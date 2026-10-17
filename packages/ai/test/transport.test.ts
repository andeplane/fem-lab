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
    phase: 'request', abortOrigin: 'none', error: { kind: 'APIConnectionError', codePresent: true, codeType: 'undefined', codeRecognized: false, cause: { kind: 'TypeError', codePresent: false, codeType: 'absent', codeRecognized: false, cause: { kind: 'Error', code: 'ECONNRESET', codePresent: true, codeType: 'string', codeRecognized: true } } },
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
  expect(diagnostic).toEqual([{ phase: 'request', abortOrigin: 'none', elapsedMs: 0, error: { kind: 'AuthenticationError', status: 401, requestId: 'req_fixture123', codePresent: true, codeType: 'undefined', codeRecognized: false } }]);
  expect(JSON.stringify(diagnostic)).not.toContain('private');
});

it('retains a genuine SDK response-body failure as stream phase without retrying the body', async () => {
  const diagnostic: ProviderDiagnostic[] = [];
  const bodyFailure = Object.assign(new TypeError('private stream body'), { cause: Object.assign(new Error('private socket'), { code: 'UND_ERR_SOCKET' }) });
  const offlineFetch: typeof fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"started"}\n\n')); controller.error(bodyFailure); } }), { headers: { 'content-type': 'text/event-stream' } }));
  const client = new OpenAI({ apiKey: 'unused-offline', fetch: offlineFetch, maxRetries: 0 });
  await collect(responsesProvider(client, [request.model], { now: () => 8, record: d => { diagnostic.push(d); } }).chat(request));
  expect(offlineFetch).toHaveBeenCalledOnce();
  expect(diagnostic).toEqual([{ phase: 'stream', abortOrigin: 'none', elapsedMs: 0, error: { kind: 'TypeError', codePresent: false, codeType: 'absent', codeRecognized: false, cause: { kind: 'Error', code: 'UND_ERR_SOCKET', codePresent: true, codeType: 'string', codeRecognized: true } } }]);
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
  expect(d).toEqual({ phase: 'input-count', abortOrigin: 'none', elapsedMs: 11, error: { kind: 'TypeError', code: 'ECONNRESET', codePresent: true, codeType: 'string', codeRecognized: true, status: 503, requestId: 'req_fixture456', cause: { kind: 'UnknownError' }, errors: Array.from({ length: 4 }, () => ({ kind: 'UnknownError' })) } });
  expect(JSON.stringify(d)).not.toContain('private');
  expect(providerDiagnostic({ name: 'private-name', code: 'private-code', status: 99, requestID: 'private-id' }, 'request', undefined, NaN).error).toEqual({ kind: 'UnknownError', codePresent: true, codeType: 'string', codeRecognized: false });
  expect(providerDiagnostic({ name: 'Error', code: 3, status: 600, requestID: 5 }, 'request', undefined, -1).elapsedMs).toBe(0);
  expect(providerDiagnostic({ name: 'Error', status: 200.5 }, 'request', undefined, Infinity).elapsedMs).toBe(0);
  const nested = new Error('private', { cause: new Error('private', { cause: new Error('private', { cause: new Error('private', { cause: new Error('depth ignored') }) }) }) });
  expect(providerDiagnostic(nested, 'request', undefined, 0).error.cause?.cause?.cause?.cause).toEqual({ kind: 'UnknownError' });
  const unreadable = Object.create(null) as Record<string, unknown>;
  for (const key of ['constructor', 'name', 'code', 'status', 'requestID', 'cause', 'errors']) Object.defineProperty(unreadable, key, { get: hidden });
  expect(providerDiagnostic(unreadable, 'request', undefined, 1).error).toEqual({ kind: 'UnknownError', codePresent: true, codeType: 'unreadable', codeRecognized: false });
});


it.each(['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC'])('retains the explicit safe TLS code %s from a genuine SDK count failure', async code => {
  const secret = 'private-key-url-and-payload';
  const failure = Object.assign(new Error(secret), { code });
  const offlineFetch: typeof fetch = vi.fn(async () => { throw new TypeError(secret, { cause: failure }); });
  const client = new OpenAI({ apiKey: secret, maxRetries: 0, fetch: offlineFetch });
  let observed: unknown;
  try { await client.responses.inputTokens.count({ model: request.model, input: 'offline fixture' }); }
  catch (error) { observed = providerDiagnostic(error, 'input-count', undefined, 14); }
  expect(offlineFetch).toHaveBeenCalledOnce();
  expect(observed).toMatchObject({ phase: 'input-count', abortOrigin: 'none', error: { kind: 'APIConnectionError', codePresent: true, codeType: 'undefined', codeRecognized: false, cause: { kind: 'TypeError', cause: { kind: 'Error', code, codePresent: true, codeType: 'string', codeRecognized: true } } } });
  expect(JSON.stringify(observed)).not.toContain(secret);
});

it('distinguishes absent, rejected, nonstring and unreadable codes without copying private values', () => {
  const rejected = ['private-key-code', 'EPRIVATE_KEY_PAYLOAD', 'ERR_PRIVATE_URL', 'UND_ERR_PRIVATE_PAYLOAD', 'CERT_PRIVATE_SECRET'];
  for (const code of rejected) {
    const receipt = providerDiagnostic({ name: 'Error', code }, 'input-count', undefined, 0).error;
    expect(receipt).toEqual({ kind: 'Error', codePresent: true, codeType: 'string', codeRecognized: false });
    expect(JSON.stringify(receipt)).not.toContain(code);
  }
  expect(providerDiagnostic(new Error(), 'input-count', undefined, 0).error).toEqual({ kind: 'Error', codePresent: false, codeType: 'absent', codeRecognized: false });
  for (const [code, codeType] of [[undefined, 'undefined'], [null, 'null'], [42, 'number'], [true, 'boolean'], [3n, 'bigint'], [Symbol('private'), 'symbol'], [() => 'private', 'function'], [{ private: 'secret' }, 'object']] as const) {
    expect(providerDiagnostic({ name: 'Error', code }, 'input-count', undefined, 0).error).toEqual({ kind: 'Error', codePresent: true, codeType, codeRecognized: false });
  }
  const getter = { get code(): string { throw new Error('private getter'); } };
  expect(providerDiagnostic(getter, 'input-count', undefined, 0).error).toEqual({ kind: 'UnknownError', codePresent: true, codeType: 'unreadable', codeRecognized: false });
  const inaccessible = new Proxy({}, { has() { throw new Error('private has trap'); } });
  expect(providerDiagnostic(inaccessible, 'input-count', undefined, 0).error).toEqual({ kind: 'UnknownError', codePresent: null, codeType: 'unreadable', codeRecognized: false });
});

it.each(['UND_ERR_HEADERS_OVERFLOW', 'UND_ERR_RESPONSE_STATUS_CODE', 'UND_ERR_INVALID_ARG', 'UND_ERR_INVALID_RETURN_VALUE', 'UND_ERR_INFO', 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH', 'UND_ERR_NOT_SUPPORTED', 'UND_ERR_BPL_MISSING_UPSTREAM', 'UND_ERR_RES_EXCEEDED_MAX_SIZE', 'UND_ERR_REQ_RETRY', 'UND_ERR_PRX_TLS', 'EACCES', 'EPERM', 'EADDRINUSE', 'EADDRNOTAVAIL', 'EHOSTDOWN', 'ENETDOWN', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR'])('recognizes exact public code %s without copying private properties', code => {
  const diagnostic = providerDiagnostic({ code, message: 'private', url: 'private', headers: { authorization: 'private' } }, 'input-count', undefined, 1);
  expect(diagnostic.error).toMatchObject({ code, codePresent: true, codeType: 'string', codeRecognized: true });
  expect(JSON.stringify(diagnostic)).not.toContain('private');
});
