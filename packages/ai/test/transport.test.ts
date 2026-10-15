import OpenAI from 'openai';
import { expect, it, vi } from 'vitest';
import { responsesProvider, type OpenAILike } from '../src/openai';
import { providerDiagnostic, startProviderObservation, observeProviderFailure, type ProviderDiagnostic, type ProviderObserver } from '../src/transport-diagnostics';
import type { ChatEvent, ChatRequest } from '../src/provider';

const request: ChatRequest = { model: 'gpt-6.1-sol', system: 'Offline fixture only', messages: [], tools: [], maxTokens: 1 };
async function collect(events: AsyncIterable<ChatEvent>) { const result: ChatEvent[] = []; for await (const event of events) result.push(event); return result; }

it('retains a whitelisted deep socket cause from a genuine SDK offline fetch failure without retrying or copying secrets', async () => {
  const secret = 'offline-fixture-key-must-not-leak';
  const socket = Object.assign(new Error(`private payload ${secret}`), { code: 'ECONNRESET', authorization: secret, request: { body: 'private payload' } });
  const offlineFetch: typeof fetch = vi.fn(async () => { throw new TypeError(`private payload ${secret}`, { cause: socket }); });
  const client = new OpenAI({ apiKey: secret, maxRetries: 0, fetch: offlineFetch });
  const diagnostics: unknown[] = [];
  const events = await collect(responsesProvider(client, [request.model], { now: () => 10, record: diagnostic => { diagnostics.push(diagnostic); } }).chat(request));
  expect(offlineFetch).toHaveBeenCalledOnce();
  expect(events).toEqual([{ type: 'error', message: 'Connection error.' }]);
  expect(diagnostics).toContainEqual(expect.objectContaining({
    phase: 'request', abortOrigin: 'none', error: { kind: 'APIConnectionError', cause: { kind: 'TypeError', cause: { kind: 'Error', code: 'ECONNRESET' } } },
  }));
  expect(JSON.stringify({ events, diagnostics })).not.toContain(secret);
  expect(JSON.stringify({ events, diagnostics })).not.toContain('private payload');
  expect(JSON.stringify({ events, diagnostics })).not.toContain('authorization');
});


it('captures real SDK HTTP status/request ID while excluding response headers and payload', async () => {
  const diagnostic: ProviderDiagnostic[] = [];
  const offlineFetch: typeof fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'private response payload', type: 'invalid_request_error' } }), { status: 401, headers: { 'content-type': 'application/json', 'x-request-id': 'req_fixture123', 'authorization': 'private-header' } }));
  const client = new OpenAI({ apiKey: 'unused-offline', fetch: offlineFetch, maxRetries: 0 });
  await collect(responsesProvider(client, [request.model], { now: () => 7, record: d => { diagnostic.push(d); } }).chat(request));
  expect(diagnostic).toEqual([{ phase: 'request', abortOrigin: 'none', elapsedMs: 0, error: { kind: 'AuthenticationError', status: 401, requestId: 'req_fixture123' } }]);
  expect(JSON.stringify(diagnostic)).not.toContain('private');
});

it('retains a genuine SDK response-body failure as stream phase without retrying the body', async () => {
  const diagnostic: ProviderDiagnostic[] = [];
  const bodyFailure = Object.assign(new TypeError('private stream body'), { cause: Object.assign(new Error('private socket'), { code: 'UND_ERR_SOCKET' }) });
  const offlineFetch: typeof fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"started"}\n\n')); controller.error(bodyFailure); } }), { headers: { 'content-type': 'text/event-stream' } }));
  const client = new OpenAI({ apiKey: 'unused-offline', fetch: offlineFetch, maxRetries: 0 });
  await collect(responsesProvider(client, [request.model], { now: () => 8, record: d => { diagnostic.push(d); } }).chat(request));
  expect(offlineFetch).toHaveBeenCalledOnce();
  expect(diagnostic).toEqual([{ phase: 'stream', abortOrigin: 'none', elapsedMs: 0, error: { kind: 'TypeError', cause: { kind: 'Error', code: 'UND_ERR_SOCKET' } } }]);
});

it('distinguishes an owned caller abort from an SDK timeout using real SDK requests', async () => {
  const diagnostics: ProviderDiagnostic[] = [];
  const observer: ProviderObserver = { now: () => 9, record: d => { diagnostics.push(d); } };
  const abort = new AbortController(); abort.abort();
  const unusedFetch: typeof fetch = vi.fn(async () => { throw new Error('must not reach fetch'); });
  const abortedClient = new OpenAI({ apiKey: 'unused-offline', fetch: unusedFetch, maxRetries: 0 });
  expect(await collect(responsesProvider(abortedClient, [request.model], observer).chat({ ...request, signal: abort.signal }))).toEqual([]);
  expect(unusedFetch).not.toHaveBeenCalled();
  expect(diagnostics[0]).toMatchObject({ phase: 'request', abortOrigin: 'request-signal', error: { kind: 'APIUserAbortError' } });
  const stalledFetch: typeof fetch = vi.fn(async (_url, init) => await new Promise<Response>((_resolve, reject) => { init!.signal!.addEventListener('abort', () => reject(new DOMException('private abort', 'AbortError'))); }));
  const timedClient = new OpenAI({ apiKey: 'unused-offline', fetch: stalledFetch, maxRetries: 0, timeout: 5 });
  await collect(responsesProvider(timedClient, [request.model], observer).chat(request));
  expect(diagnostics[1]).toMatchObject({ phase: 'request', abortOrigin: 'sdk-timeout', error: { kind: 'APIConnectionTimeoutError' } });
});

it('does not let initial/later clock or observer failures mask the original request failure', async () => {
  const sdk: OpenAILike = { responses: { create: async () => { throw new Error('original failure'); } } };
  const reports: ProviderDiagnostic[] = [];
  const clockFailure: ProviderObserver = { now: () => { throw new Error('clock unavailable'); }, record: d => { reports.push(d); } };
  expect(await collect(responsesProvider(sdk, [request.model], clockFailure).chat(request))).toEqual([{ type: 'error', message: 'original failure' }]);
  expect(reports[0]).toMatchObject({ elapsedMs: 0, error: { kind: 'Error' } });
  let reads = 0;
  const laterClockFailure: ProviderObserver = { now: () => { if (++reads === 1) return 10; throw new Error('later clock'); }, record: d => { reports.push(d); } };
  await collect(responsesProvider(sdk, [request.model], laterClockFailure).chat(request));
  expect(reports[1]?.elapsedMs).toBe(0);
  expect(await collect(responsesProvider(sdk, [request.model], { now: () => 1, record: () => { throw new Error('sink failure'); } }).chat(request))).toEqual([{ type: 'error', message: 'original failure' }]);
  expect(startProviderObservation(undefined)).toBeUndefined();
  observeProviderFailure(undefined, new Error('unused'), 'request', undefined, undefined);
});

it('bounds adversarial cause chains and never accesses messages, headers, requests, URLs or stacks', () => {
  const hidden = () => { throw new Error('forbidden private getter'); };
  const root = Object.create(null) as Record<string, unknown>;
  for (const key of ['message', 'headers', 'request', 'url', 'stack']) Object.defineProperty(root, key, { get: hidden });
  Object.assign(root, { name: 'TypeError', code: 'ECONNRESET', status: 503, requestID: 'req_fixture456', cause: root, errors: [null, 'private', undefined, 42, new Error('fifth ignored')] });
  const d = providerDiagnostic(root, 'input-count', undefined, 11);
  expect(d).toEqual({ phase: 'input-count', abortOrigin: 'none', elapsedMs: 11, error: { kind: 'TypeError', code: 'ECONNRESET', status: 503, requestId: 'req_fixture456', cause: { kind: 'UnknownError' }, errors: Array.from({ length: 4 }, () => ({ kind: 'UnknownError' })) } });
  expect(JSON.stringify(d)).not.toContain('private');
  expect(providerDiagnostic({ name: 'private-name', code: 'private-code', status: 99, requestID: 'private-id' }, 'request', undefined, NaN).error).toEqual({ kind: 'UnknownError' });
  expect(providerDiagnostic({ name: 'Error', code: 3, status: 600, requestID: 5 }, 'request', undefined, -1).elapsedMs).toBe(0);
  expect(providerDiagnostic({ name: 'Error', status: 200.5 }, 'request', undefined, Infinity).elapsedMs).toBe(0);
  const nested = new Error('private', { cause: new Error('private', { cause: new Error('private', { cause: new Error('private', { cause: new Error('depth ignored') }) }) }) });
  expect(providerDiagnostic(nested, 'request', undefined, 0).error.cause?.cause?.cause?.cause).toEqual({ kind: 'UnknownError' });
  const unreadable = Object.create(null) as Record<string, unknown>;
  for (const key of ['constructor', 'name', 'code', 'status', 'requestID', 'cause', 'errors']) Object.defineProperty(unreadable, key, { get: hidden });
  expect(providerDiagnostic(unreadable, 'request', undefined, 1).error).toEqual({ kind: 'UnknownError' });
});
