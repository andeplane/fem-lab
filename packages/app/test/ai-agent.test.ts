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
  { entries: [{ seq: 4, cmd: { cmd: 'model.new' } as never, hashAfter: 'a' }], revision: 5, canUndo: true, canRedo: false },
  { entries: [{ seq: 5, cmd: { cmd: 'geometry.addBox' } as never, hashAfter: 'b' }, { seq: 6, cmd: { cmd: 'material.add' } as never, hashAfter: 'c' }], revision: 7, canUndo: true, canRedo: false },
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
    return { seq: 1, revision: 2, hash: 'h', warnings: [], output: { type: 'none' } };
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
  it('runs every tool call of the turn and returns them in ONE tool_result message', async () => {
    const { registry, dispatched } = fixture();
    const { provider, seen } = fakeProvider([TOOL_ROUND, FINAL_ROUND]);
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'build a beam' }] }];
    const events = await drain(runTurn({ provider, registry, model: 'claude-opus-5', system: 'rules', tools: toToolDefinitions(registry), messages }));

    expect(dispatched.map((c) => c.cmd)).toEqual(['geometry.addBox']);
    expect(events.filter((e) => e.type === 'tool_end')).toHaveLength(2);
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
    expect(call).toMatchObject({ tool: 'geometry_addBox', command: 'geometry.addBox', ok: false });
  });

  it('computes the Journal diff of the turn and how many steps undo it', async () => {
    const { registry } = fixture();
    const { provider } = fakeProvider([TOOL_ROUND, FINAL_ROUND]);
    const turn = turnOf(await drain(runTurn({ provider, registry, model: 'claude-opus-5', system: '', tools: [], messages: [{ role: 'user', content: [] }] })));
    expect(turn.diff.map((e) => e.seq)).toEqual([5, 6]);
    expect(turn.undoSteps).toBe(2);
    expect(turn.usage).toEqual({ input: 300, output: 30, cacheRead: 40 });
    expect(turn.cost).toBeCloseTo((300 * 5 + 30 * 25 + 4 * 5) / 1e6, 9);
  });

  it('undoes the whole turn with one journal.undo, and does nothing when it changed nothing', async () => {
    const { registry, dispatched } = fixture();
    await undoTurn(registry, 2);
    await undoTurn(registry, 0);
    expect(dispatched).toEqual([{ cmd: 'journal.undo', steps: 2 }]);
  });

  it('routes run_script to script.run and reports a tool the registry does not have', async () => {
    const { registry } = fixture();
    const { provider, seen } = fakeProvider([
      [{ type: 'tool_use', id: 's1', name: 'run_script', input: { code: 'fem.model.new({})' } }, { type: 'tool_use', id: 's2', name: 'not_a_tool', input: {} }, { type: 'done', stopReason: 'tool_use' }],
      FINAL_ROUND,
    ]);
    const events = await drain(runTurn({ provider, registry, model: 'claude-opus-5', system: '', tools: [], messages: [{ role: 'user', content: [] }] }));
    const calls = turnOf(events).calls;
    expect(calls[0]).toMatchObject({ command: 'script.run', ok: true });
    expect(calls[1]).toMatchObject({ command: 'not_a_tool', ok: false });
    expect(JSON.parse((seen[1]!.messages[2]!.content[1] as { content: string }).content).code).toBe('not-found');
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
