import { expect, it, vi } from 'vitest';
import type { ChatRequest, Provider } from '@femlab/ai';
import { withinCaseDeadline, type DeadlineClock } from '../src/deadline';
import { boundedProvider, EvaluationBudget } from '../src/budget';

it('aborts a stuck supplier, waits for reservation settlement and closes only its owned host', async () => {
  let fire: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const cancel = vi.fn(), close = vi.fn(async () => undefined);
  const clock: DeadlineClock = { schedule: vi.fn((_ms, expire) => { fire = expire; return cancel; }) };
  const request: ChatRequest = { system: '', messages: [], tools: [], model: 'gpt-5.6-sol', maxTokens: 1000 };
  let aborted = false;
  const supplier: Provider = { id: 'openai', models: [request.model], async *chat(req) {
    entered();
    await new Promise<void>((_resolve, reject) => req.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('supplier aborted')); }, { once: true }));
    yield { type: 'done', stopReason: 'end_turn' };
  } };
  const budget = new EvaluationBudget({ model: request.model, maxUsd: 1, maxRequests: 4, maxInputTokens: 1000 });
  const provider = boundedProvider(supplier, budget, async () => 100, async () => undefined);
  const stuck = withinCaseDeadline(async signal => { for await (const _event of provider.chat({ ...request, signal })) { /* drain cancelled request */ } }, close, 600000, clock);
  await started;
  fire();
  await expect(stuck).rejects.toThrow('host was closed');
  expect(aborted).toBe(true);
  expect(budget.snapshot()).toMatchObject({ inFlightRequests: 0, chargedOrReservedUsd: 0.0205, stoppedReason: expect.stringContaining('usage unavailable') });
  expect(() => budget.assertReady()).toThrow('usage unavailable');
  expect(close).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
});

it('cancels the timer and leaves the host open after successful completion', async () => {
  const cancel = vi.fn(), close = vi.fn(async () => undefined);
  const clock: DeadlineClock = { schedule: vi.fn(() => cancel) };
  await expect(withinCaseDeadline(async signal => { expect(signal.aborted).toBe(false); return 'actual observation'; }, close, 600000, clock)).resolves.toBe('actual observation');
  expect(close).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce();
});
