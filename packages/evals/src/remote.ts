import { FemError, toToolDefinitions, type CommandDef, type JsonSchema, type QueryDef, type Registry, type ToolDefinition } from '@femlab/registry';
import { buildSystem, runTurn, type Message, type Provider, type ToolCall, type TurnResult } from '../../app/src/ai/eval-api';
import type { EvalCase, EvalEvidence, ToolTrace } from './types';

export interface RemoteDefinitionSet {
  commands: CommandDef[];
  queries: QueryDef[];
  defs: Record<string, unknown>;
  tools?: ToolDefinition[];
}

export interface RemoteEngine {
  definitions(): Promise<RemoteDefinitionSet>;
  invoke(command: string, input: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/** Registry's read/dispatch surface over an actual browser or MCP connection. */
class RemoteRegistry {
  readonly defs: Record<string, unknown>;
  private readonly byName: Map<string, CommandDef | QueryDef>;
  readonly validation: { before: string; after: string }[] = [];

  constructor(private readonly remote: RemoteEngine, private readonly definitions_: RemoteDefinitionSet) {
    this.defs = definitions_.defs;
    this.byName = new Map([...definitions_.commands, ...definitions_.queries].map((definition) => [definition.name, definition]));
  }

  list(): { commands: CommandDef[]; queries: QueryDef[] } {
    return { commands: this.definitions_.commands, queries: this.definitions_.queries };
  }

  describe(name: string): CommandDef | QueryDef {
    const definition = this.byName.get(name);
    if (definition === undefined) throw new FemError('not-found', `the evaluation host has no '${name}' capability`, name);
    return definition;
  }

  dispatch(input: { cmd: string } & Record<string, unknown>): Promise<unknown> {
    const { cmd, ...args } = input;
    return this.remote.invoke(cmd, args);
  }

  async query(input: { query: string } & Record<string, unknown>): Promise<unknown> {
    const { query, ...args } = input;
    if (query !== 'query.validateScript') return this.remote.invoke(query, args);
    const before = journalHash(await this.remote.invoke('query.journal', {}));
    const value = await this.remote.invoke(query, args);
    const after = journalHash(await this.remote.invoke('query.journal', {}));
    this.validation.push({ before, after });
    return value;
  }
}

function journalHash(value: unknown): string {
  if (value && typeof value === 'object' && typeof (value as { hash?: unknown }).hash === 'string') return (value as { hash: string }).hash;
  return '';
}

function parsed(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function traces(calls: ToolCall[], validation: { before: string; after: string }[]): ToolTrace[] {
  let validateAt = 0;
  return calls.map((call) => {
    const snapshot = call.command === 'query.validateScript' ? validation[validateAt++] : undefined;
    return {
      name: call.command,
      command: call.command,
      input: call.input,
      output: call.ok ? parsed(call.result) : undefined,
      error: call.ok ? undefined : parsed(call.result),
      ms: call.ms,
      ok: call.ok,
      ...(snapshot === undefined ? {} : { journalBefore: snapshot.before, journalAfter: snapshot.after }),
    };
  });
}

async function optional(remote: RemoteEngine, command: string, input: Record<string, unknown>): Promise<unknown> {
  try {
    return await remote.invoke(command, input);
  } catch {
    return undefined;
  }
}

/** One real provider turn against one fresh host process/page, followed by independent reads. */
export async function evaluateCase(remote: RemoteEngine, provider: Provider, model: string, spec: EvalCase, options: { maxTokens: number; maxRounds: number; timeoutMs: number }): Promise<EvalEvidence> {
  const definitions = await remote.definitions();
  const registry = new RemoteRegistry(remote, definitions);
  const tools = definitions.tools ?? toToolDefinitions(registry as unknown as Registry);
  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: spec.prompt }] }];
  const system = buildSystem({ registry: registry as unknown as Registry, skills: [], project: null });
  let text = '';
  let turn: TurnResult | null = null;
  const errors: string[] = [];
  try {
    for await (const event of runTurn({ provider, registry: registry as unknown as Registry, model, system, tools, messages, ...options })) {
      if (event.type === 'text') text += event.text;
      else if (event.type === 'error') errors.push(event.message);
      else if (event.type === 'turn') turn = event.turn;
    }
    const capabilities = await optional(remote, 'query.capabilities', {});
    const modelResult = await optional(remote, 'query.model', {});
    const journal = await optional(remote, 'query.journal', {});
    const result = await optional(remote, 'query.result', {});
    const probe = spec.measure.kind === 'probe'
      ? await optional(remote, 'query.probe', { field: spec.measure.field, ...(spec.measure.component === undefined ? {} : { component: spec.measure.component }), at: spec.measure.atM.map((n) => `${n} m`) })
      : undefined;
    let frames: unknown[] | undefined;
    let framesCatalogue: unknown;
    if (spec.measure.kind === 'frames') {
      const catalogue = await optional(remote, 'query.frames', {}) as { frames?: { index?: number }[] } | undefined;
      framesCatalogue = catalogue;
      frames = [];
      for (const stamp of catalogue?.frames ?? []) {
        if (typeof stamp.index !== 'number') continue;
        try {
          frames.push(await remote.invoke('query.frame', { index: stamp.index }));
        } catch (error) {
          frames.push({ requested: stamp, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    return {
      status: errors.length === 0 ? 'completed' : 'error',
      ...(errors.length === 0 ? {} : { reason: errors.join('; ') }),
      assistantText: text,
      usage: turn?.usage,
      elapsedMs: turn?.ms,
      capabilities,
      model: modelResult,
      result,
      probe,
      framesCatalogue,
      frames,
      journal,
      trace: traces(turn?.calls ?? [], registry.validation),
    };
  } finally {
    await remote.close();
  }
}
