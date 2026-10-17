import OpenAI from 'openai';
import { expect, it, vi } from 'vitest';
import { responsesProvider, type ChatEvent, type ChatRequest, type ProviderObserver } from '@femlab/ai';
import { EvaluationBudget, requireFreeDisk } from '../src/budget';
import { recoverableProvider, retryableTransport, type AttemptReceipt } from '../src/transport-recovery';

const request: ChatRequest = { model: 'gpt-6.1-sol', system: 'offline only', messages: [], tools: [], maxTokens: 1000 };
const limits = { model: request.model, maxUsd: 1, maxRequests: 4, maxInputTokens: 128000 };
const network = () => new TypeError('private fetch payload', { cause: Object.assign(new Error('private socket'), { code: 'ECONNRESET' }) });
const count = () => new Response(JSON.stringify({ object: 'response.input_tokens', input_tokens: 100 }), { headers: { 'content-type': 'application/json' } });
const frame = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
const complete = () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
  controller.enqueue(frame({ type: 'response.output_text.delta', delta: 'retained' }));
  controller.enqueue(frame({ type: 'response.completed', response: { output: [], usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 10 }, output_tokens: 20 } } }));
  controller.close();
} }), { headers: { 'content-type': 'text/event-stream' } });
async function collect(source: AsyncIterable<ChatEvent>) { const result: ChatEvent[] = []; for await (const event of source) result.push(event); return result; }
function setup(route: (stage: 'count' | 'generation', init?: RequestInit) => Promise<Response>, options: { timeout?: number; resources?: () => Promise<void>; changed?: () => void } = {}) {
  const stages: string[] = [], receipts: AttemptReceipt[] = [], states: ReturnType<EvaluationBudget['snapshot']>[] = [];
  const fetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const stage = url.pathname === '/v1/responses/input_tokens' ? 'count' : 'generation';
    stages.push(stage); return route(stage, init);
  });
  const client = new OpenAI({ apiKey: 'private-offline-only', maxRetries: 0, timeout: options.timeout ?? 120000, fetch });
  const budget = new EvaluationBudget(limits);
  const factory = vi.fn((observer: ProviderObserver) => responsesProvider(client, [request.model], observer));
  const resources = vi.fn(options.resources ?? (async () => undefined));
  const provider = recoverableProvider(factory, { id: 'openai', models: [request.model] }, budget, async req => (await client.responses.inputTokens.count({ model: req.model, input: 'offline only' }, { signal: req.signal })).input_tokens, resources, async () => { states.push(budget.snapshot()); options.changed?.(); }, { maxTransportRetries: 1, now: () => 1, record: receipt => { receipts.push(receipt); } });
  return { provider, budget, factory, fetch, stages, receipts, states, resources };
}

it('recovers a genuine SDK transient count failure before reserving one complete generation', async () => {
  let counts = 0;
  const run = setup(async stage => { if (stage === 'count') { if (counts++ === 0) throw network(); return count(); } return complete(); });
  const delivered = await collect(run.provider.chat(request));
  expect(run.stages).toEqual(['count', 'count', 'generation']); expect(run.resources).toHaveBeenCalledTimes(3); expect(run.factory).toHaveBeenCalledOnce();
  expect(run.receipts.map(row => ({ attempt: row.attempt, outcome: row.outcome, request: row.request }))).toEqual([{ attempt: 0, outcome: 'retry', request: 0 }, { attempt: 1, outcome: 'completed', request: 1 }]);
  expect(run.receipts[0]).toMatchObject({ diagnostics: [{ phase: 'input-count', abortOrigin: 'none', error: { cause: { cause: { code: 'ECONNRESET' } } } }], discardedEvents: 0, unknownUsageRetained: false });
  expect(run.states.map(state => state.inFlightRequests)).toEqual([0, 1, 0]);
  expect(run.budget.snapshot()).toMatchObject({ requests: 1, chargedOrReservedUsd: 0.000381, retainedUnknown: [], inFlightRequests: 0, stoppedReason: null });
  expect(delivered.filter(event => event.type === 'text_delta')).toEqual([{ type: 'text_delta', text: 'retained' }]);
});

it('exhausts two genuine transient count fetches with zero generation and zero reservations', async () => {
  const run = setup(async () => { throw network(); });
  expect(await collect(run.provider.chat(request))).toEqual([{ type: 'error', message: 'Connection error.' }]);
  expect(run.stages).toEqual(['count', 'count']); expect(run.factory).not.toHaveBeenCalled();
  expect(run.receipts.map(row => row.outcome)).toEqual(['retry', 'stopped']);
  expect(run.budget.snapshot()).toMatchObject({ requests: 0, chargedOrReservedUsd: 0, retainedUnknown: [], inFlightRequests: 0, stoppedReason: 'Connection error.' });
});

it.each(['unknown', 'filtered-code', 'tls', 'mixed-tls', 'mixed-filtered', 'mixed-unreadable', 'mixed-timeout', 'mixed-abort', 'auth', 'http', 'timeout'])('stops genuine SDK fatal %s count errors without retry or generation', async kind => {
  const run = setup(async (_stage, init) => {
    if (kind === 'auth' || kind === 'http') return new Response(JSON.stringify({ error: { message: 'private payload' } }), { status: kind === 'auth' ? 401 : 503, headers: { 'content-type': 'application/json' } });
    if (kind === 'timeout') return await new Promise<Response>((_resolve, reject) => { init!.signal!.addEventListener('abort', () => reject(new DOMException('private timeout', 'AbortError'))); });
    if (kind === 'mixed-tls' || kind === 'mixed-filtered' || kind === 'mixed-unreadable' || kind === 'mixed-timeout' || kind === 'mixed-abort') {
      const fatal = kind === 'mixed-unreadable' ? Object.defineProperty(new Error('private cause'), 'code', { get() { throw new Error('private getter'); } }) : Object.assign(new Error('private cause'), { code: kind === 'mixed-tls' ? 'CERT_HAS_EXPIRED' : kind === 'mixed-timeout' ? 'ETIMEDOUT' : kind === 'mixed-abort' ? 'UND_ERR_ABORTED' : 'EPRIVATE_SECRET' });
      throw new TypeError('private payload', { cause: new AggregateError([Object.assign(new Error('private socket'), { code: 'ECONNRESET' }), fatal], 'private aggregate') });
    }
    if (kind === 'tls' || kind === 'filtered-code') throw new TypeError('private payload', { cause: Object.assign(new Error('private cause'), { code: kind === 'tls' ? 'CERT_HAS_EXPIRED' : 'EPRIVATE_SECRET' }) });
    throw new TypeError('private unknown', { cause: new Error('private cause') });
  }, { timeout: 5 });
  expect(await collect(run.provider.chat(request))).toEqual([{ type: 'error', message: expect.any(String) }]);
  expect(run.stages).toEqual(['count']); expect(run.factory).not.toHaveBeenCalled();
  expect(run.budget.snapshot()).toMatchObject({ requests: 0, chargedOrReservedUsd: 0, inFlightRequests: 0, retainedUnknown: [] });
  expect(run.receipts.map(row => row.outcome)).toEqual(['stopped']);
  expect(JSON.stringify(run.receipts.flatMap(row => row.diagnostics))).not.toContain('private');
});

it('keeps known TLS fatal across phases even beside a transient network aggregate sibling', () => {
  for (const phase of ['input-count', 'request', 'stream'] as const) expect(retryableTransport([{ phase, abortOrigin: 'none', elapsedMs: 0, error: { kind: 'AggregateError', errors: [{ kind: 'Error', code: 'ECONNRESET' }, { kind: 'Error', code: 'CERT_HAS_EXPIRED' }] } }])).toBe(false);
});

it('does not spend the shared allowance twice when count recovery is followed by a failed generation', async () => {
  let counts = 0;
  const run = setup(async stage => { if (stage === 'count') { if (counts++ === 0) throw network(); return count(); } throw network(); });
  expect(await collect(run.provider.chat(request))).toEqual([{ type: 'error', message: 'Connection error.' }]);
  expect(run.stages).toEqual(['count', 'count', 'generation']); expect(run.receipts.map(row => row.outcome)).toEqual(['retry', 'stopped']);
  expect(run.budget.snapshot()).toMatchObject({ requests: 1, chargedOrReservedUsd: 0.01025, inFlightRequests: 0, retainedUnknown: [{ request: 1, reservedUsd: 0.01025 }] });
  expect(run.receipts[1]).toMatchObject({ attempt: 1, unknownUsageRetained: true });
});

it('preserves the unknown generation debit when its last allowed attempt fails counting', async () => {
  let counts = 0;
  const run = setup(async stage => { if (stage === 'count') { if (counts++ > 0) throw network(); return count(); } throw network(); });
  await collect(run.provider.chat(request));
  expect(run.stages).toEqual(['count', 'generation', 'count']); expect(run.receipts.map(row => row.outcome)).toEqual(['retry', 'stopped']);
  expect(run.budget.snapshot()).toMatchObject({ requests: 1, chargedOrReservedUsd: 0.01025, retainedUnknown: [{ request: 1, reservedUsd: 0.01025 }], inFlightRequests: 0 });
});

it.each(['pre-abort', 'in-count-abort', 'retry-abort', 'retry-floor'])('rechecks %s before another count or any generation', async kind => {
  const controller = new AbortController(); let resources = 0;
  if (kind === 'pre-abort') controller.abort();
  const run = setup(async (_stage, init) => {
    if (kind === 'in-count-abort') { controller.abort(); throw new DOMException('private abort', 'AbortError'); }
    expect(init?.signal).toBeDefined(); throw network();
  }, { resources: async () => { resources++; requireFreeDisk((kind === 'retry-floor' && resources > 1 ? 23.9 : 24) * 2 ** 30, 24 * 2 ** 30); }, changed: () => { if (kind === 'retry-abort') controller.abort(); } });
  await collect(run.provider.chat({ ...request, signal: controller.signal }));
  expect(run.stages).toEqual(kind === 'pre-abort' ? [] : ['count']); expect(run.factory).not.toHaveBeenCalled();
  expect(run.budget.snapshot()).toMatchObject({ requests: 0, chargedOrReservedUsd: 0, retainedUnknown: [], inFlightRequests: 0 });
});


it('discards a partial SDK generation after the count retry and keeps its unknown maximum debit', async () => {
  let counts = 0;
  const run = setup(async stage => {
    if (stage === 'count') { if (counts++ === 0) throw network(); return count(); }
    const chunks = [frame({ type: 'response.output_text.delta', delta: 'never deliver' }), frame({ type: 'response.completed', response: { output: [{ type: 'function_call', call_id: 'never', name: 'run_script', arguments: '{"code":"never"}' }] } })];
    return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else controller.error(new TypeError('offline body failure', { cause: Object.assign(new Error('offline socket'), { code: 'ECONNRESET' }) }));
    } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
  });
  expect(await collect(run.provider.chat(request))).toEqual([{ type: 'error', message: 'offline body failure' }]);
  expect(run.stages).toEqual(['count', 'count', 'generation']);
  expect(run.receipts[1]).toMatchObject({ attempt: 1, outcome: 'stopped', discardedEvents: 5, unknownUsageRetained: true });
  expect(run.budget.snapshot()).toMatchObject({ requests: 1, chargedOrReservedUsd: 0.01025, retainedUnknown: [{ request: 1, reservedUsd: 0.01025 }], inFlightRequests: 0 });
});

it.each(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENETRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'])('keeps the exact existing transient code %s eligible in every phase', code => {
  for (const phase of ['input-count', 'request', 'stream'] as const) expect(retryableTransport([{ phase, abortOrigin: 'none', elapsedMs: 0, error: { kind: 'Error', code, codePresent: true, codeType: 'string', codeRecognized: true } }])).toBe(true);
});

it.each(['ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNABORTED', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_ABORTED', 'UND_ERR_DESTROYED', 'UND_ERR_CLOSED'])('does not expand retry eligibility to %s', code => {
  expect(retryableTransport([{ phase: 'input-count', abortOrigin: 'none', elapsedMs: 0, error: { kind: 'Error', code, codePresent: true, codeType: 'string', codeRecognized: true } }])).toBe(false);
  for (const phase of ['input-count', 'request', 'stream'] as const) expect(retryableTransport([{ phase, abortOrigin: 'none', elapsedMs: 0, error: { kind: 'AggregateError', errors: [{ kind: 'Error', code: 'ECONNRESET' }, { kind: 'Error', code, codePresent: true, codeType: 'string', codeRecognized: true }] } }])).toBe(false);
});


it('retains the public bad-record TLS alert from actual SDK counting and vetoes its transient sibling', async () => {
  const code = 'ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC';
  const run = setup(async () => {
    throw new TypeError('offline fetch failure', { cause: new AggregateError([
      Object.assign(new Error('offline network sibling'), { code: 'ECONNRESET' }),
      Object.assign(new Error('offline TLS peer alert'), { code }),
    ], 'offline aggregate') });
  });
  expect(await collect(run.provider.chat(request))).toEqual([{ type: 'error', message: 'Connection error.' }]);
  expect(run.stages).toEqual(['count']); expect(run.fetch).toHaveBeenCalledOnce(); expect(run.factory).not.toHaveBeenCalled();
  expect(run.receipts).toMatchObject([{ attempt: 0, outcome: 'stopped', diagnostics: [{ phase: 'input-count', abortOrigin: 'none', error: { cause: { cause: { errors: [{ code: 'ECONNRESET' }, { code, codeRecognized: true }] } } } }], discardedEvents: 0, unknownUsageRetained: false }]);
  expect(run.budget.snapshot()).toMatchObject({ requests: 0, chargedOrReservedUsd: 0, inFlightRequests: 0, retainedUnknown: [] });
});

// The validated preparation policy supplies this floor; generic 24 GiB fixtures above
// intentionally continue to exercise independent resource injection.
it.each(['initial', 'retry'] as const)('enforces the verified 4 GiB floor before %s count/reservation/generation', async phase => {
  let checks = 0;
  const run = setup(async () => { throw network(); }, { resources: async () => {
    checks++;
    requireFreeDisk(4 * 2 ** 30 - (phase === 'initial' || checks > 1 ? 1 : 0), 4 * 2 ** 30);
  } });
  expect(await collect(run.provider.chat(request))).toEqual([{ type: 'error', message: expect.stringContaining('4 GiB') }]);
  expect(run.stages).toEqual(phase === 'initial' ? [] : ['count']);
  expect(run.resources).toHaveBeenCalledTimes(phase === 'initial' ? 1 : 2);
  expect(run.factory).not.toHaveBeenCalled();
  expect(run.budget.snapshot()).toMatchObject({ requests: 0, chargedOrReservedUsd: 0, inFlightRequests: 0, retainedUnknown: [] });
});

it.each(['disk', 'abort'] as const)('rechecks %s after genuine SDK count before reserving or creating generation', async kind => {
  const controller = new AbortController(); let checks = 0;
  const run = setup(async stage => { expect(stage).toBe('count'); return count(); }, { resources: async () => {
    if (++checks === 2) {
      if (kind === 'abort') controller.abort();
      else requireFreeDisk(4 * 2 ** 30 - 1, 4 * 2 ** 30);
    }
  } });
  expect(await collect(run.provider.chat({ ...request, signal: controller.signal }))).toEqual([{ type: 'error', message: expect.stringContaining(kind === 'disk' ? '4 GiB' : 'aborted') }]);
  expect(run.stages).toEqual(['count']); expect(run.resources).toHaveBeenCalledTimes(2);
  expect(run.factory).not.toHaveBeenCalled();
  expect(run.budget.snapshot()).toMatchObject({ requests: 0, chargedOrReservedUsd: 0, inFlightRequests: 0, retainedUnknown: [] });
});
