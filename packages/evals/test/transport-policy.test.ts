import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import OpenAI from 'openai';
import { it, expect, vi } from 'vitest';
import { evaluationTransport } from '../src/transport-policy';

it('validates mode, actual runtime and frozen checkpoint before client construction', () => {
  const client = vi.fn();
  for (const [mode, node] of [['invalid', 'v22.21.1'], ['http1-connection-close', 'v26.4.0'], ['http1-connection-close', 'v24.0.0']] as const) {
    expect(() => client(evaluationTransport(mode, node))).toThrow();
  }
  expect(client).not.toHaveBeenCalled();
  expect(evaluationTransport(undefined, 'v26.4.0')).toEqual({ mode: 'native-default' });
  expect(evaluationTransport('native-default', 'v22.21.1')).toEqual({ mode: 'native-default' });
  expect(evaluationTransport('http1-connection-close', 'v22.21.1', { httpTransport: 'http1-connection-close' })).toEqual({ mode: 'http1-connection-close', defaultHeaders: { Connection: 'close' } });
  const previousConfigurations: Record<string, string | number | boolean>[] = [{ httpTransport: 'native-default' }, {}];
  for (const previous of previousConfigurations) {
    expect(() => client(evaluationTransport('http1-connection-close', 'v22.21.1', previous))).toThrow('checkpoint HTTP transport differs');
  }
  expect(() => client(evaluationTransport('native-default', 'v22.21.1', { httpTransport: 'http1-connection-close' }))).toThrow('checkpoint HTTP transport differs');
  expect(client).not.toHaveBeenCalled();
});

it('uses actual SDK counts and drained SSE bodies on fresh sockets only in selected close mode', async () => {
  for (const close of [true, false]) {
    let next = 0, active = 0, maxActive = 0, finishedStreams = 0;
    const sockets = new Map<Socket, number>(), records: { kind: string; socket: number }[] = [];
    const server = http.createServer(async (req, res) => {
      active++; maxActive = Math.max(maxActive, active);
      let socket = sockets.get(req.socket); if (!socket) { socket = ++next; sockets.set(req.socket, socket); }
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { stream?: boolean };
      const count = req.url === '/v1/responses/input_tokens';
      assert.ok(count || req.url === '/v1/responses');
      assert.equal(req.headers.connection, close ? 'close' : 'keep-alive'); records.push({ kind: count ? 'count' : 'stream', socket });
      res.on('finish', () => { active--; if (!count) finishedStreams++; });
      if (count) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ object: 'response.input_tokens', input_tokens: 12 })); }
      else {
        assert.equal(body.stream, true); res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [], usage: { input_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1 } } })}\n\n`);
        setTimeout(() => res.end('data: [DONE]\n\n'), 25);
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const policy = evaluationTransport(close ? 'http1-connection-close' : 'native-default', 'v22.21.1');
      const client = new OpenAI({ apiKey: 'OFFLINE_SENTINEL', baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, maxRetries: 0, ...(policy.defaultHeaders ? { defaultHeaders: policy.defaultHeaders } : {}) });
      for (let round = 0; round < 2; round++) {
        assert.equal((await client.responses.inputTokens.count({ model: 'gpt-6.1-sol', input: 'offline' })).input_tokens, 12);
        const stream = await client.responses.create({ model: 'gpt-6.1-sol', input: 'offline', stream: true, max_output_tokens: 128 });
        let completed = 0; for await (const event of stream) if (event.type === 'response.completed') completed++;
        assert.equal(completed, 1); assert.equal(finishedStreams, round + 1);
        assert.equal((await client.responses.inputTokens.count({ model: 'gpt-6.1-sol', input: 'large surrogate ' + 'λ'.repeat(32768) })).input_tokens, 12);
      }
      assert.equal(records.length, 6); assert.equal(maxActive, 1);
      if (close) assert.equal(next, 6); else assert.ok(next < 6);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
});

it('keeps caller abort effective through a response body and closes the actual SDK socket', async () => {
  let closed = false;
  const server = http.createServer((req, res) => {
    req.resume(); res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"response.output_text.delta","delta":"offline"}\n\n');
    res.socket!.once('close', () => { closed = true; });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new OpenAI({ apiKey: 'OFFLINE_SENTINEL', baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, maxRetries: 0, defaultHeaders: evaluationTransport('http1-connection-close', 'v22.21.1').defaultHeaders });
    const controller = new AbortController();
    const stream = await client.responses.create({ model: 'gpt-6.1-sol', input: 'offline', stream: true }, { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 40);
    try { for await (const event of stream) assert.equal(event.type, 'response.output_text.delta'); } finally { clearTimeout(timer); }
    assert.equal(controller.signal.aborted, true);
    for (let i = 0; i < 100 && !closed; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(closed, true);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
