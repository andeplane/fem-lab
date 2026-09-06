// The tool loop (plan B §7.6): stream the text, run every `tool_use` block of the turn through the
// registry, hand back ONE message holding all the `tool_result` blocks, repeat until the model
// stops asking. A failed Command comes back as its structured `Error` with `is_error: true`, so the
// model can fix its own call instead of guessing.
//
// The Journal revision is read before the first request and after the last, which is what makes
// "show me what you did" a diff and "undo this turn" one `journal.undo { steps }`.
import { commandNameFor, FemError, RUN_SCRIPT, type Ack, type Command, type ScriptResult, type JournalDump, type JournalEntry, type Registry, type ToolDefinition } from '@femlab/registry';
import { costOf, NO_USAGE, type Message, type Provider, type ToolResultBlock, type Usage } from './provider';

export interface ToolCall {
  id: string;
  /** The tool name the model used (`geometry_addBox`). */
  tool: string;
  /** The Command it maps to (`geometry.addBox`), or the tool name when there is none. */
  command: string;
  input: unknown;
  ms: number;
  status: 'preparing' | 'pending' | 'succeeded' | 'failed' | 'cancelled';
  /** Raw argument snapshot, for display while the provider is generating a call. */
  arguments?: string;
  /** The result or the error, as the JSON the model was given. */
  result: string;
}

export interface TurnResult {
  calls: ToolCall[];
  skills: string[];
  ms: number;
  usage: Usage;
  /** Unknown if any attempted request ended without reporting its usage. */
  cost: number | null;
  /** The Journal entries this turn added, for the "Journal diff · this turn" card. */
  diff: JournalEntry[];
  /** What `journal.undo { steps }` needs to take the whole turn back. */
  undoSteps: number;
  /** Complete history required by the engine's atomic undo guard; null for interleaved edits. */
  undoJournal: string | null;
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; status: string }
  | { type: 'tool_progress'; call: ToolCall }
  | { type: 'tool_start'; call: ToolCall }
  | { type: 'tool_end'; call: ToolCall }
  | { type: 'turn'; turn: TurnResult }
  | { type: 'error'; message: string };

export interface TurnOptions {
  provider: Provider;
  registry: Registry;
  model: string;
  system: string;
  tools: ToolDefinition[];
  /** Mutated in place: the assistant turn and its tool results are appended, as the model sees them. */
  messages: Message[];
  maxTokens?: number;
  maxRounds?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: () => number;
}

const SKILL_TOOL = 'skill_invoke';

/** Everything the model is told about a failure: the engine's own error shape, unchanged. */
const errorJson = (e: unknown): string =>
  JSON.stringify(e instanceof FemError ? e.toJSON() : { code: 'internal', cause: e instanceof Error ? e.message : String(e), where: null, suggestion: null });

async function callTool(registry: Registry, tool: string, input: unknown): Promise<unknown> {
  const args = (input ?? {}) as Record<string, unknown>;
  if (tool === RUN_SCRIPT) return registry.dispatch({ cmd: 'script.run', ...args });
  const command = commandNameFor(tool, registry);
  if (!command) throw new FemError('not-found', `there is no tool called '${tool}'`, tool, 'call describe or use one of the names in the API reference');
  return command.startsWith('query.') ? registry.query({ query: command, ...args }) : registry.dispatch({ cmd: command, ...args });
}

async function journal(registry: Registry): Promise<JournalDump> {
  try {
    return (await registry.query({ query: 'query.journal' })) as JournalDump;
  } catch {
    // No Model yet, or an engine that cannot answer: the turn still runs, it just has no diff.
    return { hash: '', entries: [], revision: 0, canUndo: false, canRedo: false };
  }
}

/**
 * One turn: the request, the tool rounds it asks for, and the summary card. `messages` already ends
 * with the person's turn (see `buildTurn`); it is extended with what the model said and what the
 * Commands answered, so passing it back in continues the conversation.
 */
export async function* runTurn(opts: TurnOptions): AsyncGenerator<AgentEvent, TurnResult> {
  const { provider, registry, model, system, tools, messages, signal, maxTokens = 16000, maxRounds = 12, timeoutMs = 180_000, now = Date.now } = opts;
  const started = now();
  const before = await journal(registry);
  const owned: JournalEntry[] = [];

  const calls: ToolCall[] = [];
  const skills: string[] = [];
  const usage: Usage = { ...NO_USAGE };
  let cost = costOf(model, NO_USAGE);

  for (let round = 0; round < maxRounds; round++) {
    if (signal?.aborted) break;
    if (now() - started > timeoutMs) {
      yield { type: 'error', message: `the turn ran longer than ${Math.round(timeoutMs / 1000)} s and was stopped` };
      break;
    }
    const pending: { id: string; name: string; input: unknown }[] = [];
    let text = '';
    let failed = false;
    let receivedUsage = false;
    let continuation: Message['continuation'];

    for await (const event of provider.chat({ system, messages, tools, model, maxTokens, signal })) {
      if (signal?.aborted) break;
      if (event.type === 'tool_progress') {
        yield { type: 'tool_progress', call: { id: event.id, tool: event.name, command: commandNameFor(event.name, registry) ?? event.name, input: null, arguments: event.arguments, ms: 0, status: 'preparing', result: '' } };
      } else if (event.type === 'text_delta') {
        text += event.text;
        yield { type: 'text', text: event.text };
      } else if (event.type === 'tool_use') {
        pending.push({ id: event.id, name: event.name, input: event.input });
      } else if (event.type === 'continuation') {
        continuation = event.continuation;
      } else if (event.type === 'usage') {
        receivedUsage = true;
        usage.input += event.usage.input;
        usage.output += event.usage.output;
        usage.cacheRead += event.usage.cacheRead;
        if (event.usage.cacheWrite) usage.cacheWrite = (usage.cacheWrite ?? 0) + event.usage.cacheWrite;
        const requestCost = costOf(model, event.usage);
        cost = cost === null || requestCost === null ? null : cost + requestCost;
      } else if (event.type === 'error') {
        failed = true;
        yield { type: 'error', message: event.message };
      }
    }
    if (!receivedUsage) cost = null;
    if (signal?.aborted) {
      if (text) messages.push({ role: 'assistant', content: [{ type: 'text', text: text + '\n[Response interrupted before completion.]' }] });
      break;
    }
    if (failed) break;

    messages.push({
      role: 'assistant',
      ...(continuation ? { continuation } : {}),
      content: [...(text ? [{ type: 'text' as const, text }] : []), ...pending.map((p) => ({ type: 'tool_use' as const, id: p.id, name: p.name, input: p.input }))],
    });
    if (pending.length === 0) break;

    // One `tool_result` message for the whole assistant turn: splitting them teaches the model to
    // stop calling tools in parallel.
    const results: ToolResultBlock[] = [];
    for (const p of pending) {
      const call: ToolCall = { id: p.id, tool: p.name, command: commandNameFor(p.name, registry) ?? p.name, input: p.input, ms: 0, status: 'pending', result: '' };
      calls.push(call);
      yield { type: 'tool_start', call };
      const at = now();
      try {
        if (signal?.aborted) throw new FemError('cancelled', 'Interrupted before this tool started', p.name);
        const value = await callTool(registry, p.name, p.input);
        call.result = JSON.stringify(value ?? null);
        call.status = p.name === RUN_SCRIPT && typeof (value as ScriptResult)?.error === 'string' ? 'failed' : 'succeeded';
        if (p.name === RUN_SCRIPT) owned.push(...((value as ScriptResult)?.journalEntries ?? []));
        else if ('journaled' in registry.describe(call.command) && (registry.describe(call.command) as { journaled: boolean }).journaled) {
          const ack = value as Ack;
          owned.push({ seq: ack.seq, hashAfter: ack.hash, cmd: { cmd: call.command, ...(p.input as Record<string, unknown>) } as Command });
        }
        if (p.name === SKILL_TOOL) skills.push(String((p.input as { name?: string })?.name ?? ''));
      } catch (e) {
        call.status = e instanceof FemError && e.code === 'cancelled' ? 'cancelled' : 'failed';
        call.result = errorJson(e);
      }
      call.ms = now() - at;
      results.push({ type: 'tool_result', toolUseId: p.id, content: call.result, ...(call.status !== 'succeeded' ? { isError: true } : {}) });
      yield { type: 'tool_end', call };
    }
    messages.push({ role: 'user', content: results });
  }

  const after = await journal(registry);
  const diff = after.entries.filter((entry) => owned.some((own) => entry.seq === own.seq && entry.hashAfter === own.hashAfter && matchesInput(entry.cmd, own.cmd)));
  const suffix = after.entries.slice(before.entries.length);
  const contiguous = typeof after.hash === 'string' && after.hash.length > 0
    && before.entries.every((entry, i) => sameEntry(entry, after.entries[i]))
    && !diff.some((entry) => entry.cmd.cmd === 'model.new')
    && suffix.length === diff.length && suffix.every((entry, i) => sameEntry(entry, diff[i]));
  const turn: TurnResult = {
    calls,
    skills,
    ms: now() - started,
    usage,
    cost,
    diff,
    undoSteps: contiguous ? diff.length : 0,
    undoJournal: contiguous ? after.hash : null,
  };
  yield { type: 'turn', turn };
  return turn;
}

/** Engine serialization can add nested defaults. Explicit input values must still match. */
function matchesInput(actual: unknown, input: unknown): boolean {
  if (input === null) return actual === null || actual === undefined;
  if (Array.isArray(input)) return Array.isArray(actual) && input.length === actual.length && input.every((value, i) => matchesInput(actual[i], value));
  if (input && typeof input === 'object') return actual !== null && typeof actual === 'object'
    && Object.entries(input).every(([key, value]) => matchesInput((actual as Record<string, unknown>)[key], value));
  return actual === input;
}

/** Object key order is transport-specific; compare the actual command values and boundary. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
}
function sameEntry(a: JournalEntry, b: JournalEntry | undefined): boolean {
  return b !== undefined && canonical(a) === canonical(b);
}

/** Undo only the recorded turn boundary; the engine compares it atomically before popping. */
export async function undoTurn(registry: Registry, steps: number, expectedJournal: string | null): Promise<void> {
  if (steps > 0 && expectedJournal !== null) await registry.dispatch({ cmd: 'journal.undo', steps, expectedJournal });
}
