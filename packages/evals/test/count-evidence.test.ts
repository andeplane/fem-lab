import OpenAI from 'openai';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { countEvidenceFetch, localCountEvidence } from '../src/count-evidence';
import { EvaluationBudget } from '../src/budget';
import { recoverableProvider, retryableTransport } from '../src/transport-recovery';
import { providerDiagnostic, responsesProvider } from '@femlab/ai';

const runtime = { source: 'a'.repeat(40), node: 'v26.4.0', sdk: 'openai@7.33.0' };
const ok = () => Response.json({ object: 'response.input_tokens', input_tokens: 12 });

it('captures actual SDK serialized Unicode and opaque continuation bytes before forwarding identical fetch arguments', async () => {
  const order: string[] = [], captured: Uint8Array[] = [];
  let sdkInput: Parameters<typeof fetch>[0], sdkInit: Parameters<typeof fetch>[1];
  const forward: typeof fetch = vi.fn(async (input, init) => {
    order.push('fetch'); expect(input).toBe(sdkInput); expect(init).toBe(sdkInit);
    expect(init?.signal).toBe(sdkInit?.signal); expect(init?.body).toBe(sdkInit?.body); return ok();
  });
  const wrapped = countEvidenceFetch(forward, { async save(bytes) { order.push('save'); captured.push(bytes); } });
  const sdkFetch: typeof fetch = async (input, init) => { sdkInput = input; sdkInit = init; return wrapped(input, init); };
  const client = new OpenAI({ apiKey: 'private-key-never-saved', maxRetries: 0, fetch: sdkFetch });
  const controller = new AbortController();
  const body: OpenAI.Responses.InputTokenCountParams = { model: 'gpt-6.1-sol', input: [{ role: 'user', content: 'π λ 👋' }, { type: 'reasoning', id: 'opaque', summary: [], encrypted_content: 'opaque-fixture' }], instructions: 'offline only', tools: [] };
  expect((await client.responses.inputTokens.count(body, { signal: controller.signal })).input_tokens).toBe(12);
  expect(order).toEqual(['save', 'fetch']); expect(forward).toHaveBeenCalledOnce();
  expect(captured[0]).toEqual(new TextEncoder().encode(JSON.stringify(body)));
  expect(new TextDecoder().decode(captured[0])).not.toContain('private-key-never-saved');
});

it('leaves generation and unrelated fetch requests untouched and captures no headers or client options', async () => {
  const save = vi.fn(async () => undefined), forward: typeof fetch = vi.fn(async () => ok());
  const wrapped = countEvidenceFetch(forward, { save });
  const input = new Request('https://api.openai.com/v1/responses', { method: 'POST', body: 'private generation', headers: { authorization: 'private' } });
  await wrapped(input); expect(forward).toHaveBeenCalledWith(input, undefined); expect(save).not.toHaveBeenCalled();
});

it('fails closed before forwarding unsupported count representations or endpoint overrides', async () => {
  const forward: typeof fetch = vi.fn(async () => ok()), save = vi.fn(async () => undefined);
  const wrapped = countEvidenceFetch(forward, { save });
  for (const [url, init] of [
    ['https://api.openai.com/v1/responses/input_tokens', { method: 'GET', body: '{}' }],
    ['https://api.openai.com/v1/responses/input_tokens?private=1', { method: 'POST', body: '{}' }],
    ['https://private.invalid/v1/responses/input_tokens', { method: 'POST', body: '{}' }],
    ['https://api.openai.com/other/responses/input_tokens', { method: 'POST', body: '{}' }],
    ['https://api.openai.com/v1/responses/input_tokens', { method: 'POST', body: new Uint8Array([1]) }],
    ['https://api.openai.com/v1/responses/input_tokens', { method: 'POST', body: 'x'.repeat(16 * 1024 * 1024 + 1) }],
    ['https://api.openai.com/v1/responses/input_tokens', { method: 'POST', body: 'π'.repeat(9 * 1024 * 1024) }],
  ] as const) await expect(wrapped(url, init)).rejects.toThrow('count evidence');
  expect(forward).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
});

it('persists exact private local bytes and sanitized receipts outside the real checkout including symlink checks', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'count-evidence-test-')), root = path.join(parent, 'repo');
  await mkdir(root);
  try {
    const sink = await localCountEvidence(root, parent, runtime), bytes = new TextEncoder().encode('{"input":"private prompt"}');
    await sink.save(bytes);
    expect((await stat(sink.directory)).mode & 0o777).toBe(0o700);
    expect(await readdir(sink.directory)).toEqual(['000.body.json', '000.receipt.json']);
    for (const file of await readdir(sink.directory)) expect((await stat(path.join(sink.directory, file))).mode & 0o777).toBe(0o600);
    expect(new Uint8Array(await readFile(path.join(sink.directory, '000.body.json')))).toEqual(bytes);
    const receipt = await readFile(path.join(sink.directory, '000.receipt.json'), 'utf8');
    expect(JSON.parse(receipt)).toEqual({ ...runtime, index: 0, classification: 'serialized-count-input', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    expect(receipt).not.toContain('private'); expect(receipt).not.toContain('"input":');
    await expect(localCountEvidence(root, root, runtime)).rejects.toThrow('outside');
    const inside = path.join(root, 'inside'); await mkdir(inside); const link = path.join(parent, 'alias'); await symlink(inside, link);
    await expect(localCountEvidence(root, link, runtime)).rejects.toThrow('outside');
    const another = path.join(parent, 'another-checkout'); await mkdir(another); await mkdir(path.join(another, '.git'));
    await expect(localCountEvidence(root, another, runtime)).rejects.toThrow('outside repositories');
    await expect(localCountEvidence(root, 'relative', runtime)).rejects.toThrow('absolute');
    await expect(localCountEvidence(root, parent, { ...runtime, source: 'private' })).rejects.toThrow('identity');
    await expect(sink.save(new Uint8Array(16 * 1024 * 1024 + 1))).rejects.toThrow('limit');
    // A real destination failure is sanitized and does not publish a partial body/receipt.
    await rm(sink.directory, { recursive: true });
    await expect(sink.save(bytes)).rejects.toThrow('count evidence could not be persisted');
  } finally { await rm(parent, { recursive: true, force: true }); }
});

it('captures a real SDK failed count before any generation/reservation without changing fatal policy', async () => {
  const captured: Uint8Array[] = [], forward: typeof fetch = vi.fn(async () => { throw new TypeError('private error', { cause: Object.assign(new Error('private URL'), { code: 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH' }) }); });
  const client = new OpenAI({ apiKey: 'private-key', maxRetries: 0, fetch: countEvidenceFetch(forward, { async save(bytes) { captured.push(bytes); } }) });
  const budget = new EvaluationBudget({ model: 'gpt-6.1-sol', maxUsd: 1, maxRequests: 4, maxInputTokens: 128000 });
  const factory = vi.fn(observer => responsesProvider(client, ['gpt-6.1-sol'], observer)), receipts: unknown[] = [];
  const provider = recoverableProvider(factory, { id: 'openai', models: ['gpt-6.1-sol'] }, budget, async req => (await client.responses.inputTokens.count({ model: req.model, input: 'offline fixture' }, { signal: req.signal })).input_tokens, async () => undefined, async () => undefined, { maxTransportRetries: 1, now: () => 1, record: row => { receipts.push(row); } });
  const events = []; for await (const event of provider.chat({ model: 'gpt-6.1-sol', system: '', messages: [], tools: [], maxTokens: 10 })) events.push(event);
  expect(events).toEqual([{ type: 'error', message: 'Connection error.' }]); expect(forward).toHaveBeenCalledOnce(); expect(captured).toHaveLength(1); expect(factory).not.toHaveBeenCalled();
  expect(budget.snapshot()).toMatchObject({ requests: 0, inFlightRequests: 0, chargedOrReservedUsd: 0, retainedUnknown: [] });
  expect(receipts).toMatchObject([{ outcome: 'stopped', diagnostics: [{ phase: 'input-count', error: { cause: { cause: { code: 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH', codeRecognized: true } } } }] }]);
  expect(JSON.stringify(receipts)).not.toContain('private');
  const diagnostic = providerDiagnostic({ code: 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH' }, 'input-count', undefined, 1);
  expect(retryableTransport([diagnostic])).toBe(false);
});

it('does not forward when the injected capture sink refuses persistence', async () => {
  const forward: typeof fetch = vi.fn(async () => ok());
  const wrapped = countEvidenceFetch(forward, { async save() { throw new Error('offline persistence refusal'); } });
  await expect(wrapped('https://api.openai.com/v1/responses/input_tokens', { method: 'POST', body: '{}' })).rejects.toThrow('offline persistence refusal');
  expect(forward).not.toHaveBeenCalled();
});

it('does not retry any newly recognized code, including alongside a transient sibling', () => {
  for (const code of ['UND_ERR_HEADERS_OVERFLOW', 'UND_ERR_RESPONSE_STATUS_CODE', 'UND_ERR_INVALID_ARG', 'UND_ERR_INVALID_RETURN_VALUE', 'UND_ERR_INFO', 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH', 'UND_ERR_NOT_SUPPORTED', 'UND_ERR_BPL_MISSING_UPSTREAM', 'UND_ERR_RES_EXCEEDED_MAX_SIZE', 'UND_ERR_REQ_RETRY', 'UND_ERR_PRX_TLS', 'EACCES', 'EPERM', 'EADDRINUSE', 'EADDRNOTAVAIL', 'EHOSTDOWN', 'ENETDOWN', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR']) {
    const error = new AggregateError([Object.assign(new Error('private'), { code: 'ECONNRESET' }), Object.assign(new Error('private'), { code })]);
    for (const phase of ['input-count', 'request', 'stream'] as const) expect(retryableTransport([providerDiagnostic(error, phase, undefined, 0)])).toBe(false);
  }
});
