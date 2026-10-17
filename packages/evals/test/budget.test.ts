import { describe, expect, it, vi } from 'vitest';
import type { ChatEvent, ChatRequest, Provider, Usage } from '@femlab/ai';
import { boundedProvider, EvaluationBudget, requireFreeDisk, restoreEvaluationBudget } from '../src/budget';
import { runLane, type EvalAdapter } from '../src/runner';
import { EVAL_CASES } from '../src/cases';

const request: ChatRequest = { system: 'engineering', messages: [], tools: [], model: 'gpt-6.1-sol', maxTokens: 1000 };
const usage: Usage = { input: 90, cacheRead: 10, output: 20 };
const limits = { model: request.model, maxUsd: 1, maxRequests: 4, maxInputTokens: 128_000 };
function provider(report: Usage | null = usage): Provider {
  return { id: 'openai', models: [request.model], chat: vi.fn(async function* () {
    yield { type: 'text_delta', text: 'fixture only; never a live evaluation' } as const;
    if (report) yield { type: 'usage', usage: report } as const;
    yield { type: 'done', stopReason: 'end_turn' } as const;
  }) };
}
async function drain(source: AsyncIterable<ChatEvent>) { const events = []; for await (const event of source) events.push(event); return events; }

describe('bounded evaluation generation', () => {
  it('admits resources and authoritative token count before calling the real provider, then settles actual usage', async () => {
    const p = provider(), budget = new EvaluationBudget(limits), resources = vi.fn(async () => undefined), count = vi.fn(async () => 100);
    const snapshots: number[] = [];
    const bounded = boundedProvider(p, budget, count, resources, async () => { snapshots.push(budget.snapshot().inFlightRequests); });
    expect(await drain(bounded.chat(request))).toContainEqual({ type: 'usage', usage });
    expect(snapshots).toEqual([1, 0]);
    expect(count).toHaveBeenCalledWith(request);
    expect(p.chat).toHaveBeenCalledWith(request);
    expect(resources.mock.invocationCallOrder[0]).toBeLessThan(count.mock.invocationCallOrder[0]!);
    expect(count.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(p.chat).mock.invocationCallOrder[0]!);
    expect(budget.snapshot()).toMatchObject({ requests: 1, chargedOrReservedUsd: 0.000381, stoppedReason: null });
  });
  it('refuses a request before generation when its maximum charge exceeds the remaining USD cap', async () => {
    const p = provider(), budget = new EvaluationBudget({ ...limits, maxUsd: 0.001 });
    expect(await drain(boundedProvider(p, budget, async () => 100, async () => undefined).chat(request))).toContainEqual({ type: 'error', message: expect.stringContaining('cost limit') });
    expect(p.chat).not.toHaveBeenCalled();
    expect(budget.snapshot().requests).toBe(0);
    expect(() => budget.assertReady()).toThrow('cost limit');
  });
  it('retains a worst-case reservation and halts both lanes when provider usage is unknown', async () => {
    const p = provider(null), budget = new EvaluationBudget(limits), bounded = boundedProvider(p, budget, async () => 100, async () => undefined);
    await drain(bounded.chat(request));
    expect(budget.snapshot()).toMatchObject({ requests: 1, chargedOrReservedUsd: 0.01025, stoppedReason: expect.stringContaining('usage unavailable') });
    await drain(bounded.chat(request));
    expect(p.chat).toHaveBeenCalledOnce();
  });
  it('rejects invalid usage, unknown tariffs, changed model, oversized context and exhausted request count', () => {
    const budget = new EvaluationBudget(limits);
    expect(() => budget.reserve('gpt-6-astra', 100, 1000)).toThrow('model differs');
    expect(() => budget.reserve(request.model, 128001, 1000)).toThrow('token limits');
    expect(() => new EvaluationBudget({ ...limits, model: 'unpriced' }).reserve('unpriced', 100, 1000)).toThrow('tariff');
    const held = budget.reserve(request.model, 100, 1000);
    held.finish({ ...usage, output: 1001 });
    expect(() => budget.assertReady()).toThrow('exceeded');
    expect(() => held.finish(usage)).toThrow('already settled');
    const one = new EvaluationBudget({ ...limits, maxRequests: 1 });
    one.reserve(request.model, 100, 1000).finish(usage);
    expect(() => one.reserve(request.model, 100, 1000)).toThrow('request limit');
  });
  it('never counts or generates below the selected disk floor, including after earlier admitted requests', async () => {
    const p = provider(), count = vi.fn(async () => 100);
    const bounded = boundedProvider(p, new EvaluationBudget(limits), count, async () => requireFreeDisk(29.85 * 2 ** 30, 30 * 2 ** 30));
    expect(await drain(bounded.chat(request))).toContainEqual({ type: 'error', message: expect.stringContaining('30 GiB') });
    expect(count).not.toHaveBeenCalled(); expect(p.chat).not.toHaveBeenCalled();
    expect(() => requireFreeDisk(30 * 2 ** 30, 30 * 2 ** 30)).not.toThrow();
    let freeGiB = 24;
    const reuseProvider = provider(), reuseCount = vi.fn(async () => 100);
    const reuse = boundedProvider(reuseProvider, new EvaluationBudget(limits), reuseCount, async () => requireFreeDisk(freeGiB * 2 ** 30, 24 * 2 ** 30));
    await drain(reuse.chat(request));
    freeGiB = 23.9;
    expect(await drain(reuse.chat(request))).toContainEqual({ type: 'error', message: expect.stringContaining('24 GiB') });
    expect(reuseProvider.chat).toHaveBeenCalledOnce();
    expect(reuseCount).toHaveBeenCalledOnce();
  });
  it('restores spent budget only under identical resolved limits and refuses unresolved billing', () => {
    const budget = new EvaluationBudget(limits);
    budget.reserve(request.model, 100, 1000).finish(usage);
    expect(restoreEvaluationBudget(limits, budget.snapshot()).snapshot()).toEqual(budget.snapshot());
    expect(() => restoreEvaluationBudget(limits, { ...budget.snapshot(), model: 'gpt-5.6-sol' })).toThrow('checkpoint');
    expect(() => restoreEvaluationBudget(limits, undefined)).toThrow('missing');
    expect(() => restoreEvaluationBudget(limits, null)).toThrow('missing');
    expect(() => restoreEvaluationBudget(limits, {})).toThrow('incompatible');
    expect(() => new EvaluationBudget({ ...limits, maxUsd: 2 }, budget.snapshot())).toThrow('checkpoint');
    expect(() => new EvaluationBudget(limits, { ...budget.snapshot(), inFlightRequests: 1 })).toThrow('checkpoint');
    expect(() => new EvaluationBudget(limits, { ...budget.snapshot(), stoppedReason: 'usage unknown' })).toThrow('checkpoint');
    expect(() => new EvaluationBudget({ ...limits, maxRequests: 0 })).toThrow('invalid');
  });
});

describe('case checkpoints', () => {
  function scripted(seen: string[]): EvalAdapter {
    return { host: 'browser', live: false, availability: async () => ({ available: true }), close: vi.fn(async () => undefined),
      execute: async spec => { seen.push(spec.id); return { status: 'error', reason: 'scripted harness evidence only', trace: [] }; } };
  }
  it('retains a fixed prefix on resource interruption and resumes every remaining case without replacing failures', async () => {
    const seen: string[] = [], checkpoints: string[][] = [];
    const partial = await runLane(scripted(seen), EVAL_CASES, { beforeCase: async () => { if (seen.length === 2) throw new Error('disk guard'); }, onCase: async scores => { checkpoints.push(scores.map(score => score.id)); } });
    expect(partial).toMatchObject({ status: 'interrupted', total: 20, passed: 0, gatePassed: false });
    expect(checkpoints).toEqual([['A1'], ['A1', 'A2']]);
    const resumed = await runLane(scripted(seen), EVAL_CASES, { completed: partial.cases });
    expect(seen).toEqual(EVAL_CASES.map(spec => spec.id));
    expect(resumed.cases.slice(0, 2)).toEqual(partial.cases);
    expect(resumed).toMatchObject({ status: 'completed', total: 20, passed: 0, live: false, gatePassed: false });
  });
  it('rejects a checkpoint reordered against the fixed specification', async () => {
    const partial = await runLane(scripted([]), EVAL_CASES.slice(0, 1));
    await expect(runLane(scripted([]), EVAL_CASES, { completed: [{ ...partial.cases[0]!, id: 'A2' }] })).rejects.toThrow('fixed-case prefix');
  });
});
