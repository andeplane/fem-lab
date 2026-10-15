import OpenAI from 'openai';
import { expect, it, vi } from 'vitest';
import { responsesProvider, type ChatEvent, type ChatRequest, type Provider, type ProviderObserver, type Usage } from '@femlab/ai';
import { EvaluationBudget, requireFreeDisk } from '../src/budget';
import { evaluateCase, type RemoteEngine } from '../src/remote';
import { EVAL_CASES } from '../src/cases';
import { recoverableProvider, retryableTransport, type AttemptReceipt } from '../src/transport-recovery';

const request: ChatRequest = { model: 'gpt-6.1-sol', system: 'offline fixture', messages: [], tools: [], maxTokens: 1000 };
const limits = { model: request.model, maxUsd: 1, maxRequests: 4, maxInputTokens: 128000 };
const usage: Usage = { input: 90, cacheRead: 10, output: 20 };
const network = () => Object.assign(new TypeError('offline socket failure'), { cause: Object.assign(new Error('socket'), { code: 'ECONNRESET' }) });
async function collect(source: AsyncIterable<ChatEvent>) { const result: ChatEvent[] = []; for await (const event of source) result.push(event); return result; }
function setup(factory: (observer: ProviderObserver) => Provider, options: { budget?: EvaluationBudget; count?: () => Promise<number>; resources?: () => Promise<void> } = {}) {
  const budget = options.budget ?? new EvaluationBudget(limits), receipts: AttemptReceipt[] = [], states: ReturnType<EvaluationBudget['snapshot']>[] = [];
  const count = vi.fn(options.count ?? (async () => 100)), resources = vi.fn(options.resources ?? (async () => undefined));
  const provider = recoverableProvider(factory, { id: 'openai', models: [request.model] }, budget, count, resources, async () => { states.push(budget.snapshot()); }, { maxTransportRetries: 1, now: () => 1, record: receipt => { receipts.push(receipt); } });
  return { provider, budget, receipts, states, count, resources };
}
function fixture(factory: (observer: ProviderObserver) => AsyncIterable<ChatEvent>) { return (observer: ProviderObserver): Provider => ({ id: 'openai', models: [request.model], chat: () => factory(observer) }); }
const good = async function* (): AsyncIterable<ChatEvent> { yield { type: 'usage', usage }; yield { type: 'done', stopReason: 'end_turn' }; };

it('buffers actual SDK partial text, completed tool/continuation and usage until a later body failure settles, then releases only the complete retry', async () => {
  let release!: () => void, blocked!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { blocked = resolve; });
  const completion = (id: string) => ({ type: 'response.completed', response: { output: [{ type: 'function_call', call_id: id, name: 'run_script', arguments: '{"code":"once"}' }], usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 10 }, output_tokens: 20 } } });
  const frame = (data: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
  let calls = 0;
  const fetch: typeof globalThis.fetch = vi.fn(async () => {
    const first = calls++ === 0;
    const chunks = [frame({ type: 'response.output_text.delta', delta: first ? 'DISCARD partial text' : 'complete text' }), frame(completion(first ? 'discard-tool' : 'retained-tool'))];
    return new Response(new ReadableStream<Uint8Array>({ async pull(controller) {
      const chunk = chunks.shift();
      if (chunk) { controller.enqueue(chunk); return; }
      if (first) { blocked(); await held; controller.error(network()); } else controller.close();
    } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const client = new OpenAI({ apiKey: 'offline-only', maxRetries: 0, fetch });
  const run = setup(observer => responsesProvider(client, [request.model], observer));
  const delivered: ChatEvent[] = [], journal: string[] = [];
  const observed: Provider = { ...run.provider, async *chat(req) { for await (const event of run.provider.chat(req)) { delivered.push(event); yield event; } } };
  const remote: RemoteEngine = {
    definitions: async () => ({ commands: [], queries: [], defs: {}, tools: [{ name: 'run_script', description: 'Offline fixture script only', input_schema: { type: 'object', properties: { code: { type: 'string' } } } }] }),
    invoke: async (command, input) => {
      if (command === 'script.run') { journal.push(String(input['code'])); return { journalEntries: [] }; }
      if (command === 'query.journal') return { hash: `h${journal.length}`, entries: [], revision: journal.length, canUndo: false, canRedo: false };
      return null;
    }, close: async () => undefined,
  };
  const pending = evaluateCase(remote, observed, request.model, EVAL_CASES[0]!, { maxTokens: request.maxTokens, maxRounds: 1, timeoutMs: 1000 });
  await reached;
  expect(delivered).toEqual([]); expect(journal).toEqual([]);
  release(); const evidence = await pending;
  expect(journal).toEqual(['once']);
  expect(evidence.trace).toMatchObject([{ command: 'run_script', ok: true, input: { code: 'once' } }]);
  expect(delivered.filter(event => event.type === 'tool_use')).toMatchObject([{ id: 'retained-tool' }]);
  expect(delivered.some(event => event.type === 'text_delta' && event.text.includes('DISCARD'))).toBe(false);
  expect(delivered.filter(event => event.type === 'continuation')).toHaveLength(1);
  expect(run.receipts.map(receipt => receipt.outcome)).toEqual(['retry', 'completed']);
  expect(run.receipts[0]).toMatchObject({ discardedEvents: 6, unknownUsageRetained: false, diagnostics: [{ phase: 'stream', error: { kind: 'TypeError', cause: { kind: 'Error', code: 'ECONNRESET' } } }] });
  expect(run.budget.snapshot()).toMatchObject({ requests: 2, chargedOrReservedUsd: 0.000762, inFlightRequests: 0, stoppedReason: null });
  expect(run.resources).toHaveBeenCalledTimes(2); expect(run.count).toHaveBeenCalledTimes(2); expect(fetch).toHaveBeenCalledTimes(2);
});

it('retains the full unknown first debit as consumed and independently reserves/counts the successful retry', async () => {
  let attempt = 0;
  const run = setup(fixture(async function* (observer) {
    if (attempt++ === 0) { observer.record({ phase: 'request', abortOrigin: 'none', elapsedMs: 2, error: { kind: 'APIConnectionError', cause: { kind: 'Error', code: 'ECONNRESET' } } }); yield { type: 'error', message: 'connection fixture' }; return; }
    yield* good();
  }));
  expect(await collect(run.provider.chat(request))).toEqual(await collect(good()));
  expect(run.budget.snapshot()).toMatchObject({ requests: 2, chargedOrReservedUsd: 0.010631, stoppedReason: null, retainedUnknown: [{ request: 1, reservedUsd: 0.01025 }] });
  expect(run.states.map(state => state.inFlightRequests)).toEqual([1, 0, 1, 0]);
  expect(() => new EvaluationBudget(limits, run.budget.snapshot())).toThrow('unresolved');
});

it.each(['double-usage', 'usage-after-error', 'missing-usage', 'double-done'])('refuses %s without releasing tools or retrying, keeping the maximum debit', async kind => {
  const run = setup(fixture(async function* () {
    yield { type: 'tool_use', id: 'never', name: 'execute', input: {} };
    if (kind === 'usage-after-error') yield { type: 'error', message: 'failed' };
    if (kind !== 'missing-usage') yield { type: 'usage', usage };
    if (kind === 'double-usage') yield { type: 'usage', usage };
    yield { type: 'done', stopReason: 'end_turn' };
    if (kind === 'double-done') yield { type: 'done', stopReason: 'end_turn' };
  }));
  expect(await collect(run.provider.chat(request))).toEqual([{ type: 'error', message: expect.any(String) }]);
  expect(run.budget.snapshot()).toMatchObject({ requests: 1, chargedOrReservedUsd: 0.01025, inFlightRequests: 0 });
  expect(run.budget.snapshot().stoppedReason).not.toBeNull();
});

it('settles valid usage even if iterator close fails, releases no tools and exhausts exactly one retry', async () => {
  const run = setup(fixture(async function* () { try { yield { type: 'tool_use', id: 'never', name: 'execute', input: {} }; yield { type: 'usage', usage }; yield { type: 'done', stopReason: 'tool_use' }; } finally { throw network(); } }));
  expect(await collect(run.provider.chat(request))).toEqual([{ type: 'error', message: 'offline socket failure' }]);
  expect(run.receipts.map(receipt => receipt.outcome)).toEqual(['retry', 'stopped']);
  expect(run.budget.snapshot()).toMatchObject({ requests: 2, chargedOrReservedUsd: 0.000762, inFlightRequests: 0 });
});

it.each(['floor', 'requests', 'cost', 'abort'])('rechecks %s admission before the extra generation', async kind => {
  const controller = new AbortController(); let attempts = 0;
  const budget = new EvaluationBudget({ ...limits, ...(kind === 'requests' ? { maxRequests: 1 } : {}), ...(kind === 'cost' ? { maxUsd: 0.015 } : {}) });
  const run = setup(fixture(async function* (observer) {
    attempts++; observer.record({ phase: 'request', abortOrigin: 'none', elapsedMs: 1, error: { kind: 'APIConnectionError', cause: { kind: 'Error', code: 'ECONNRESET' } } });
    if (kind === 'abort') controller.abort();
    yield { type: 'error', message: 'connection fixture' };
  }), { budget, resources: async () => { requireFreeDisk((kind === 'floor' && attempts ? 23.9 : 24) * 2 ** 30, 24 * 2 ** 30); } });
  expect(await collect(run.provider.chat({ ...request, signal: controller.signal }))).toEqual([{ type: 'error', message: expect.any(String) }]);
  expect(attempts).toBe(1); expect(budget.snapshot()).toMatchObject({ requests: 1, chargedOrReservedUsd: 0.01025, inFlightRequests: 0 });
});

it('refuses pre-abort and count errors before reserving or generating', async () => {
  const factory = vi.fn(fixture(good)), controller = new AbortController(); controller.abort();
  const aborted = setup(factory);
  await collect(aborted.provider.chat({ ...request, signal: controller.signal }));
  expect(aborted.count).not.toHaveBeenCalled(); expect(factory).not.toHaveBeenCalled();
  const counted = setup(factory, { count: async () => { throw network(); } });
  await collect(counted.provider.chat(request));
  expect(counted.receipts[0]?.diagnostics[0]?.phase).toBe('input-count'); expect(counted.budget.snapshot().requests).toBe(0);
});

it('does not retry HTTP/auth/schema, unknown errors, owned aborts, SDK timeouts, or malformed usage', async () => {
  for (const error of [{ kind: 'AuthenticationError', status: 401 }, { kind: 'APIError', status: 503, code: 'ECONNRESET' }, { kind: 'Error' }, { kind: 'APIConnectionTimeoutError', cause: { kind: 'Error', code: 'ECONNRESET' } }, { kind: 'APIUserAbortError', code: 'ECONNRESET' }]) {
    expect(retryableTransport([{ phase: 'request', abortOrigin: 'none', elapsedMs: 0, error }])).toBe(false);
  }
  expect(retryableTransport([])).toBe(false);
  expect(retryableTransport([{ phase: 'request', abortOrigin: 'request-signal', elapsedMs: 0, error: { kind: 'Error', code: 'ECONNRESET' } }])).toBe(false);
  const run = setup(fixture(async function* () { yield { type: 'usage', usage: { ...usage, output: 1001 } }; yield { type: 'done', stopReason: 'end_turn' }; }));
  expect(await collect(run.provider.chat(request))).toEqual([{ type: 'error', message: expect.stringContaining('exceeded') }]);
  expect(run.budget.snapshot()).toMatchObject({ requests: 1, chargedOrReservedUsd: 0.01025 });
});

it('exhausts one unknown-usage transport retry with both maximum debits visible and stops all later generation', async () => {
  const run = setup(fixture(async function* () { throw network(); }));
  expect(await collect(run.provider.chat(request))).toEqual([{ type: 'error', message: 'offline socket failure' }]);
  expect(run.budget.snapshot()).toMatchObject({ requests: 2, chargedOrReservedUsd: 0.0205, inFlightRequests: 0, retainedUnknown: [{ request: 1, reservedUsd: 0.01025 }, { request: 2, reservedUsd: 0.01025 }] });
  expect(run.receipts.map(receipt => receipt.outcome)).toEqual(['retry', 'stopped']);
  await collect(run.provider.chat(request));
  expect(run.count).toHaveBeenCalledTimes(2);
});

it('treats even an empty provider error as failed and never releases its text or tool', async () => {
  const run = setup(fixture(async function* () {
    yield { type: 'text_delta', text: 'discard' };
    yield { type: 'tool_use', id: 'never', name: 'execute', input: {} };
    yield { type: 'usage', usage };
    yield { type: 'done', stopReason: 'tool_use' };
    yield { type: 'error', message: '' };
  }));
  expect(await collect(run.provider.chat(request))).toEqual([{ type: 'error', message: '' }]);
  expect(run.receipts[0]).toMatchObject({ outcome: 'stopped', discardedEvents: 5, reason: '' });
});


it('records the real SDK TLS input-count failure without retry, generation, or a budget reservation', async () => {
  const secret = 'private-count-key-message-url';
  const fetch: typeof globalThis.fetch = vi.fn(async () => { throw new TypeError(secret, { cause: Object.assign(new Error(secret), { code: 'CERT_HAS_EXPIRED' }) }); });
  const client = new OpenAI({ apiKey: secret, maxRetries: 0, fetch });
  const factory = vi.fn((observer: ProviderObserver) => responsesProvider(client, [request.model], observer));
  const run = setup(factory, { count: async () => (await client.responses.inputTokens.count({ model: request.model, input: 'offline count' })).input_tokens });
  expect(await collect(run.provider.chat(request))).toEqual([{ type: 'error', message: 'Connection error.' }]);
  expect(fetch).toHaveBeenCalledOnce(); expect(run.count).toHaveBeenCalledOnce(); expect(factory).not.toHaveBeenCalled();
  expect(run.budget.snapshot()).toMatchObject({ requests: 0, inFlightRequests: 0, chargedOrReservedUsd: 0, retainedUnknown: [], stoppedReason: 'Connection error.' });
  expect(run.receipts).toMatchObject([{ outcome: 'stopped', unknownUsageRetained: false, discardedEvents: 0, diagnostics: [{ phase: 'input-count', abortOrigin: 'none', error: { kind: 'APIConnectionError', cause: { kind: 'TypeError', cause: { kind: 'Error', code: 'CERT_HAS_EXPIRED', codePresent: true, codeType: 'string', codeRecognized: true } } } }] }]);
  expect(run.states).toHaveLength(1); expect(run.states[0]?.inFlightRequests).toBe(0);
  expect(JSON.stringify(run.receipts)).not.toContain(secret);
});
