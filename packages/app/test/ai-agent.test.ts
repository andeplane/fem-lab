// The loop against a scripted provider (plan B §7.6): text, then two parallel tool calls, then a
// closing turn. Asserts that both Commands ran, that their results came back as ONE message, that a
// structured Error becomes `is_error: true`, and that the Journal diff and the undo step count are
// what the cards need.
import { Registry, FemError, toToolDefinitions, type EngineSchema, type JournalDump } from '@femlab/registry';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../registry/src/generated/engine.schema.json';
import { fakeHost, fakeTransport } from '../../registry/test/fakes';
import { runTurn, undoTurn, type AgentEvent } from '../src/ai/agent';
import type { ChatEvent, ChatRequest, Message, Provider } from '../src/ai/provider';

type Script = ChatEvent[][];

function fakeProvider(rounds: Script): { provider: Provider; seen: ChatRequest[] } {
  const seen: ChatRequest[] = [];
  let round = 0;
  return {
    seen,
    provider: {
      id: 'anthropic',
      models: ['claude-opus-5'],
      async *chat(req) {
        seen.push({ ...req, messages: structuredClone(req.messages) });
        for (const event of rounds[round++] ?? [{ type: 'done' as const, stopReason: 'end_turn' }]) yield event;
      },
    },
  };
}

const JOURNALS: JournalDump[] = [
  { hash: 'before', entries: [{ seq: 0, cmd: { cmd: 'model.new' } as never, hashAfter: 'a' }], revision: 1, canUndo: false, canRedo: false },
  { hash: 'after', entries: [
    { seq: 0, cmd: { cmd: 'model.new' } as never, hashAfter: 'a' },
    { seq: 1, cmd: { cmd: 'geometry.addBox', name: 'beam', size: ['1 m', '0.1 m', '0.2 m'] } as never, hashAfter: 'b' },
  ], revision: 2, canUndo: true, canRedo: false },
];

function fixture(opts: { failBox?: boolean; journals?: JournalDump[] } = {}) {
  const transport = fakeTransport();
  const dispatched: { cmd: string }[] = [];
  const journals = opts.journals ?? JOURNALS;
  let asked = 0;
  transport.query = (async (q: { query: string }) => {
    if (q.query === 'query.journal') return journals[Math.min(asked++, journals.length - 1)];
    return { name: 'beam' };
  }) as never;
  transport.dispatch = (async (cmd: { cmd: string }) => {
    dispatched.push(cmd);
    if (opts.failBox && cmd.cmd === 'geometry.addBox') throw new FemError('schema', 'size must be three lengths', 'size', 'pass size as ["1 m", "1 m", "1 m"]');
    return { seq: 1, revision: 2, hash: 'b', warnings: [], output: { type: 'none' } };
  }) as never;
  const registry = new Registry({ schema: schema as unknown as EngineSchema, host: fakeHost(transport) });
  return { registry, dispatched };
}

const TOOL_ROUND: ChatEvent[] = [
  { type: 'text_delta', text: 'Adding the beam' },
  { type: 'tool_use', id: 'c1', name: 'geometry_addBox', input: { name: 'beam', size: ['1 m', '0.1 m', '0.2 m'] } },
  { type: 'tool_use', id: 'c2', name: 'query_model', input: {} },
  { type: 'usage', usage: { input: 100, output: 20, cacheRead: 40 } },
  { type: 'done', stopReason: 'tool_use' },
];
const FINAL_ROUND: ChatEvent[] = [
  { type: 'text_delta', text: 'Done.' },
  { type: 'usage', usage: { input: 200, output: 10, cacheRead: 0 } },
  { type: 'done', stopReason: 'end_turn' },
];

async function drain(gen: AsyncGenerator<AgentEvent, unknown>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of gen) events.push(structuredClone(e));
  return events;
}

const turnOf = (events: AgentEvent[]) => (events.find((e) => e.type === 'turn') as Extract<AgentEvent, { type: 'turn' }>).turn;

describe('the agent loop', () => {
  it('returns validation diagnostics as a failed script tool result without starting execution', async () => {
    const transport = fakeTransport();
    transport.query = vi.fn(async () => ({ entries: [], revision: 0, canUndo: false, canRedo: false })) as never;
    const host = fakeHost(transport);
    const invalid = { ok: false, diagnostics: [{ code: 'TS2339', cause: 'unknown API', where: { line: 1, column: 1 }, hint: 'fix the call' }] };
    host.script.validate = vi.fn(async () => invalid);
    const registry = new Registry({ schema: schema as unknown as EngineSchema, host });
    const { provider, seen } = fakeProvider([
      [{ type: 'tool_use', id: 'bad-script', name: 'run_script', input: { code: 'wrong' } }, { type: 'done', stopReason: 'tool_use' }],
      FINAL_ROUND,
    ]);
    const turn = turnOf(await drain(runTurn({ provider, registry, model: 'claude-opus-5', system: '', tools: [], messages: [{ role: 'user', content: [] }] })));
    expect(turn.calls[0]?.status).toBe('failed');
    expect(host.script.run).not.toHaveBeenCalled();
    expect(transport.dispatch).not.toHaveBeenCalled();
    const result = seen[1]!.messages[2]!.content[0] as { isError: boolean; content: string };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).diagnostics).toEqual(invalid.diagnostics);
  });

  it('runs every tool call of the turn and returns them in ONE tool_result message', async () => {
    const { registry, dispatched } = fixture();
    const { provider, seen } = fakeProvider([TOOL_ROUND, FINAL_ROUND]);
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'build a beam' }] }];
    const events = await drain(runTurn({ provider, registry, model: 'claude-opus-5', system: 'rules', tools: toToolDefinitions(registry), messages }));

    expect(dispatched.map((c) => c.cmd)).toEqual(['geometry.addBox']);
    expect(events.filter((e) => e.type === 'tool_start').map((e) => e.call.status)).toEqual(['pending', 'pending']);
    expect(events.filter((e) => e.type === 'tool_end').map((e) => e.call.status)).toEqual(['succeeded', 'succeeded']);
    // The second request carries: the person's turn, the assistant turn, one message of results.
    expect(seen[1]!.messages).toHaveLength(3);
    const results = seen[1]!.messages[2]!;
    expect(results.role).toBe('user');
    expect(results.content.map((b) => (b as { toolUseId: string }).toolUseId)).toEqual(['c1', 'c2']);
  });

  it('sends a failed Command back as its structured Error with is_error, and the card says so', async () => {
    const { registry } = fixture({ failBox: true });
    const { provider, seen } = fakeProvider([TOOL_ROUND, FINAL_ROUND]);
    const events = await drain(runTurn({ provider, registry, model: 'claude-opus-5', system: 'rules', tools: [], messages: [{ role: 'user', content: [] }] }));

    const failed = seen[1]!.messages[2]!.content[0] as { content: string; isError?: boolean };
    expect(failed.isError).toBe(true);
    expect(JSON.parse(failed.content)).toEqual({ code: 'schema', cause: 'size must be three lengths', where: 'size', suggestion: 'pass size as ["1 m", "1 m", "1 m"]' });
    const call = turnOf(events).calls[0]!;
    expect(call).toMatchObject({ tool: 'geometry_addBox', command: 'geometry.addBox', status: 'failed' });
  });

  it('computes the Journal diff of the turn and how many steps undo it', async () => {
    const { registry } = fixture();
    const { provider } = fakeProvider([TOOL_ROUND, FINAL_ROUND]);
    const turn = turnOf(await drain(runTurn({ provider, registry, model: 'claude-opus-5', system: '', tools: [], messages: [{ role: 'user', content: [] }] })));
    expect(turn.diff.map((e) => e.seq)).toEqual([1]);
    expect(turn.undoSteps).toBe(1);
    expect(turn.undoJournal).toEqual(JOURNALS[1]!.hash);
    expect(turn.usage).toEqual({ input: 300, output: 30, cacheRead: 40 });
    expect(turn.cost).toBeCloseTo((300 * 5 + 30 * 25 + 4 * 5) / 1e6, 9);
  });

  it('sums request prices without treating separate short contexts as one long context', async () => {
    const { registry } = fixture();
    const rounds = [TOOL_ROUND, FINAL_ROUND].map((round) => round.map((event): ChatEvent =>
      event.type === 'usage' ? { type: 'usage', usage: { input: 150_000, cacheRead: 25_000, output: 1_000 } } : event));
    const { provider } = fakeProvider(rounds);
    const turn = turnOf(await drain(runTurn({ provider, registry, model: 'gpt-6-astra', system: '', tools: [], messages: [{ role: 'user', content: [] }] })));
    expect(turn.usage).toEqual({ input: 300_000, cacheRead: 50_000, output: 2_000 });
    expect(turn.cost).toBeCloseTo(3.15, 12);
  });

  it('undoes the whole turn with one journal.undo, and does nothing when it changed nothing', async () => {
    const { registry, dispatched } = fixture();
    await undoTurn(registry, 1, JOURNALS[1]!.hash);
    await undoTurn(registry, 0, null);
    expect(dispatched).toEqual([{ cmd: 'journal.undo', steps: 1, expectedJournal: JOURNALS[1]!.hash }]);
  });

  it.each([
    { name: 'mesh_set', input: { mesher: { kind: 'lattice', size: '25 mm' }, order: null }, command: { cmd: 'mesh.set', mesher: { kind: 'lattice', size: '25 mm' } } },
    { name: 'solve_run', input: { step: 'static', solver: null }, command: { cmd: 'solve.run', step: 'static' } },
    { name: 'study_converge', input: { step: 'static', sizes: ['50 mm', '25 mm', '12.5 mm'], quantity: { kind: 'max', field: 'displacement' }, restore: null }, command: { cmd: 'study.converge', step: 'static', sizes: ['50 mm', '25 mm', '12.5 mm'], quantity: { kind: 'max', field: 'displacement' } } },
  ])('matches canonical Journal entries when $name omits null/default arguments', async ({ name, input, command }) => {
    const after = structuredClone(JOURNALS[1]!);
    after.entries[1]!.cmd = command as never;
    const { registry } = fixture({ journals: [JOURNALS[0]!, after] });
    const { provider } = fakeProvider([[{ type: 'tool_use', id: 'default', name, input }], FINAL_ROUND]);
    const turn = turnOf(await drain(runTurn({ provider, registry, model: 'test', system: '', tools: [], messages: [] })));
    expect(turn.diff).toEqual([after.entries[1]!]);
    expect(turn.undoSteps).toBe(1);
  });

  it('does not label a partial undo of a newly created Model as Undo turn', async () => {
    const after = structuredClone(JOURNALS[0]!);
    after.entries[0]!.cmd = { cmd: 'model.new', name: 'new' } as never;
    after.entries[0]!.hashAfter = 'b';
    const { registry } = fixture({ journals: [{ hash: 'empty', entries: [], revision: 0, canUndo: false, canRedo: false }, after] });
    vi.spyOn(registry, 'dispatch').mockResolvedValue({ seq: 0, revision: 1, hash: 'b' });
    const { provider } = fakeProvider([[{ type: 'tool_use', id: 'new', name: 'model_new', input: { name: 'new' } }], FINAL_ROUND]);
    const turn = turnOf(await drain(runTurn({ provider, registry, model: 'test', system: '', tools: [], messages: [] })));
    expect(turn.diff).toHaveLength(1);
    expect(turn.undoJournal).toBeNull();
    expect(turn.undoSteps).toBe(0);
  });

  it('excludes interleaved human edits from the diff and refuses to batch-undo them', async () => {
    const after = structuredClone(JOURNALS[1]!);
    after.entries.push({ seq: 2, cmd: { cmd: 'model.setUnits', units: { length: 'mm', force: 'N', stress: 'MPa' } } as never, hashAfter: 'human' });
    after.revision++;
    const { registry, dispatched } = fixture({ journals: [JOURNALS[0]!, after] });
    const { provider } = fakeProvider([TOOL_ROUND, FINAL_ROUND]);
    const turn = turnOf(await drain(runTurn({ provider, registry, model: 'test', system: '', tools: [], messages: [] })));
    expect(turn.diff.map((entry) => entry.cmd.cmd)).toEqual(['geometry.addBox']);
    expect(turn.undoJournal).toBeNull();
    await undoTurn(registry, turn.undoSteps, turn.undoJournal);
    expect(dispatched.map((cmd) => cmd.cmd)).toEqual(['geometry.addBox']);
  });

  it('keeps two engine Commands as one guarded undo unit', async () => {
    const after = structuredClone(JOURNALS[1]!);
    after.entries.push({ seq: 2, cmd: { cmd: 'geometry.addBox', name: 'second', size: ['1 m', '1 m', '1 m'] }, hashAfter: 'c' });
    after.revision++;
    const { registry } = fixture({ journals: [JOURNALS[0]!, after] });
    let seq = 0;
    vi.spyOn(registry, 'dispatch').mockImplementation(async () => ({ seq: ++seq, hash: seq === 1 ? 'b' : 'c' }));
    const { provider } = fakeProvider([[...TOOL_ROUND, { type: 'tool_use', id: 'second', name: 'geometry_addBox', input: { name: 'second', size: ['1 m', '1 m', '1 m'] } }], FINAL_ROUND]);
    const turn = turnOf(await drain(runTurn({ provider, registry, model: 'test', system: '', tools: [], messages: [] })));
    expect(turn.diff.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(turn.undoSteps).toBe(2);
    expect(turn.undoJournal).toBe(after.hash);
  });

  it('does not offer turn undo after an earlier Journal entry was rewritten', async () => {
    const after = structuredClone(JOURNALS[1]!);
    after.entries[0]!.cmd = { cmd: 'model.new', name: 'different model' } as never;
    const { registry } = fixture({ journals: [JOURNALS[0]!, after] });
    const { provider } = fakeProvider([TOOL_ROUND, FINAL_ROUND]);
    const turn = turnOf(await drain(runTurn({ provider, registry, model: 'test', system: '', tools: [], messages: [] })));
    expect(turn.undoJournal).toBeNull();
    expect(turn.undoSteps).toBe(0);
  });

  it('attributes nested script Commands from the script host receipts', async () => {
    const { registry } = fixture();
    vi.spyOn(registry, 'dispatch').mockResolvedValue({ result: null, console: [], journalEntries: [JOURNALS[1]!.entries[1]!] });
    const { provider } = fakeProvider([[{ type: 'tool_use', id: 'script', name: 'run_script', input: { code: 'build()' } }], FINAL_ROUND]);
    const turn = turnOf(await drain(runTurn({ provider, registry, model: 'test', system: '', tools: [], messages: [] })));
    expect(turn.diff).toEqual([JOURNALS[1]!.entries[1]!]);
    expect(turn.undoSteps).toBe(1);
    expect(turn.undoJournal).toEqual(JOURNALS[1]!.hash);
  });

  it('routes run_script to script.run and reports a tool the registry does not have', async () => {
    const { registry } = fixture();
    const { provider, seen } = fakeProvider([
      [{ type: 'tool_use', id: 's1', name: 'run_script', input: { code: 'fem.model.new({})' } }, { type: 'tool_use', id: 's2', name: 'not_a_tool', input: {} }, { type: 'done', stopReason: 'tool_use' }],
      FINAL_ROUND,
    ]);
    const events = await drain(runTurn({ provider, registry, model: 'claude-opus-5', system: '', tools: [], messages: [{ role: 'user', content: [] }] }));
    const calls = turnOf(events).calls;
    expect(calls[0]).toMatchObject({ command: 'script.run', status: 'succeeded' });
    expect(calls[1]).toMatchObject({ command: 'not_a_tool', status: 'failed' });
    expect(JSON.parse((seen[1]!.messages[2]!.content[1] as { content: string }).content).code).toBe('not-found');
  });

  it('marks a partially successful script as failed while preserving receipts and output', async () => {
    const { registry } = fixture();
    vi.spyOn(registry, 'dispatch').mockResolvedValue({ result: null, console: ['built one body'], error: 'line 2: no such Set', journalEntries: [JOURNALS[1]!.entries[1]!] });
    const { provider, seen } = fakeProvider([[{ type: 'tool_use', id: 'script', name: 'run_script', input: { code: 'buildThenFail()' } }], FINAL_ROUND]);
    const turn = turnOf(await drain(runTurn({ provider, registry, model: 'test', system: '', tools: [], messages: [] })));
    expect(turn.calls[0]!.status).toBe('failed');
    expect(JSON.parse(turn.calls[0]!.result)).toMatchObject({ error: 'line 2: no such Set', console: ['built one body'] });
    expect(turn.diff).toEqual([JOURNALS[1]!.entries[1]!]);
    expect(turn.undoSteps).toBe(1);
    expect(seen[1]!.messages.at(-1)!.content[0]).toMatchObject({ type: 'tool_result', isError: true });
  });

  it('counts the skills the model loaded itself', async () => {
    const { registry } = fixture();
    const { provider } = fakeProvider([[{ type: 'tool_use', id: 'k1', name: 'skill_invoke', input: { name: 'beam-theory-check' } }, { type: 'done', stopReason: 'tool_use' }], FINAL_ROUND]);
    const turn = turnOf(await drain(runTurn({ provider, registry, model: 'claude-opus-5', system: '', tools: [], messages: [{ role: 'user', content: [] }] })));
    expect(turn.skills).toEqual(['beam-theory-check']);
  });

  it('stops on a provider error and still reports the turn', async () => {
    const { registry } = fixture();
    const { provider } = fakeProvider([[{ type: 'error', message: '401 invalid x-api-key' }]]);
    const events = await drain(runTurn({ provider, registry, model: 'claude-opus-5', system: '', tools: [], messages: [{ role: 'user', content: [] }] }));
    expect(events.filter((e) => e.type === 'error')).toEqual([{ type: 'error', message: '401 invalid x-api-key' }]);
    expect(turnOf(events).calls).toEqual([]);
  });

  it('stops when the turn runs past its timeout, and when it has asked for too many rounds', async () => {
    const { registry } = fixture();
    const clock = vi.fn(() => clock.mock.calls.length * 1000);
    const slow = fakeProvider([TOOL_ROUND, TOOL_ROUND, TOOL_ROUND]);
    const events = await drain(runTurn({ provider: slow.provider, registry, model: 'claude-opus-5', system: '', tools: [], messages: [{ role: 'user', content: [] }], timeoutMs: 1, now: clock }));
    expect(events.some((e) => e.type === 'error' && e.message.includes('was stopped'))).toBe(true);

    const looping = fakeProvider([TOOL_ROUND, TOOL_ROUND, TOOL_ROUND]);
    const capped = await drain(runTurn({ provider: looping.provider, registry, model: 'claude-opus-5', system: '', tools: [], messages: [{ role: 'user', content: [] }], maxRounds: 2 }));
    expect(looping.seen).toHaveLength(2);
    expect(turnOf(capped).calls).toHaveLength(4);
  });

  it('survives an engine that cannot answer query.journal: no diff, no undo offered', async () => {
    const transport = fakeTransport();
    transport.query = (async () => {
      throw new FemError('unsupported', 'no Model yet', null);
    }) as never;
    const registry = new Registry({ schema: schema as unknown as EngineSchema, host: fakeHost(transport) });
    const { provider } = fakeProvider([FINAL_ROUND]);
    const turn = turnOf(await drain(runTurn({ provider, registry, model: 'claude-opus-5', system: '', tools: [], messages: [{ role: 'user', content: [] }] })));
    expect(turn.diff).toEqual([]);
    expect(turn.undoSteps).toBe(0);
  });
});

it('finishes an active tool on interruption, skips later tools and retains paired results', async () => {
  const { registry } = fixture({ journals: [{ hash: 'same', entries: [], revision: 0, canUndo: false, canRedo: false }] });
  const controller = new AbortController();
  const dispatch = vi.spyOn(registry, 'dispatch').mockImplementation(async () => {
    controller.abort();
    return undefined;
  });
  const { provider, seen } = fakeProvider([[
    { type: 'tool_use', id: 'a', name: 'view_fit', input: {} },
    { type: 'tool_use', id: 'b', name: 'view_fit', input: {} },
    { type: 'done', stopReason: 'tool_use' },
  ]]);
  const messages: Message[] = [];
  const events = await drain(runTurn({ registry, provider, model: 'test', system: '', tools: [], messages, signal: controller.signal }));
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(seen).toHaveLength(1);
  expect(turnOf(events).calls.map(c => c.status)).toEqual(['succeeded', 'cancelled']);
  expect(messages[1]!.content).toEqual([
    { type: 'tool_result', toolUseId: 'a', content: 'null' },
    { type: 'tool_result', toolUseId: 'b', isError: true, content: expect.stringContaining('Interrupted before this tool started') },
  ]);
});
