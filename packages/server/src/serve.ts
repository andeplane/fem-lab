// Single-user loopback registry RPC. Sessions never share a Model or mutable WASM owner.
// Use an SSH tunnel for remote notebooks; this is not the hosted multi-user/billing service.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { FemError, scientificJson } from '@femlab/registry';
import type { EngineProvider } from '../../mcp/src/engine';

const MAX_BYTES = 64 * 1024 * 1024;
export interface ServeOptions {
  engine(): EngineProvider;
  now(): number;
  token(): string;
  maxSessions?: number;
  sessionMs?: number;
}
const normalized = (error: unknown) => {
  const value = error as { code?: string; cause?: string; where?: string; suggestedCommand?: string; message?: string };
  // WASM errors may arrive as a serialized engine Error.
  if (typeof error === 'string') { try { return JSON.parse(error) as unknown; } catch { /* plain failure */ } }
  return { code: value?.code ?? 'internal', cause: value?.cause ?? value?.message ?? String(error), ...(value?.where ? { where: value.where } : {}) };
};
export function registryServer(options: ServeOptions) {
  const sessions = new Map<string, { provider: EngineProvider; at: number; tail: Promise<unknown> }>();
  const drop = async (key: string): Promise<void> => {
    const session = sessions.get(key); sessions.delete(key);
    if (session) { await session.tail; await session.provider.dispose?.(); }
  };
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(scientificJson(body));
  };
  const body = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    if (req.headers['content-type'] !== 'application/json') throw new FemError('schema', 'use application/json', 'request');
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of req) { size += chunk.length; if (size > MAX_BYTES) throw new FemError('unsupported', 'request exceeds 64 MiB', 'request'); chunks.push(chunk); }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FemError('schema', 'request must be an object', 'request');
    return value as Record<string, unknown>;
  };
  const server = createServer(async (req, res) => {
    // A website cannot acquire a notebook engine by using a CORS/preflight or form request.
    // Also reject rebinding Host headers even though the listener is loopback-only.
    const host = req.headers.host ?? '';
    if (req.headers.origin || !/^(127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?$/.test(host)) { json(res, 403, { error: { code: 'unsupported', cause: 'loopback client required' } }); return; }
    if (req.method !== 'POST') { json(res, 405, { error: { code: 'unsupported', cause: 'use POST' } }); return; }
    try {
      const value = await body(req);
      const now = options.now();
      for (const [key, session] of sessions) if (now - session.at > (options.sessionMs ?? 30 * 60_000)) await drop(key);
      if (req.url === '/session') {
        if (sessions.size >= (options.maxSessions ?? 16)) throw new FemError('unsupported', 'too many sessions; close an existing client', 'session');
        const token = options.token();
        sessions.set(token, { provider: options.engine(), at: now, tail: Promise.resolve() });
        json(res, 201, { session: token }); return;
      }
      const key = req.headers['x-femlab-session'];
      const session = typeof key === 'string' ? sessions.get(key) : undefined;
      if (!session) { json(res, 401, { error: { code: 'session.expired', cause: 'open a new notebook Client' } }); return; }
      session.at = now;
      if (req.url === '/close') { await drop(key as string); json(res, 200, { closed: true }); return; }
      if (req.url !== '/rpc') { json(res, 404, { error: { code: 'not-found', cause: 'no such route' } }); return; }
      const { id, op, payload } = value;
      if (!Number.isSafeInteger(id) || (id as number) < 0 || !['dispatch', 'query', 'replaceCommands'].includes(String(op))) throw new FemError('schema', 'invalid registry request', 'rpc');
      if (!payload || typeof payload !== 'object') throw new FemError('schema', 'payload must be an object or command list', 'payload');
      const run = async () => {
        const handle = await session.provider.acquire();
        try {
          if (op === 'replaceCommands') {
            if (!Array.isArray(payload)) throw new FemError('schema', 'replacement requires Commands', 'payload');
            await handle.replaceCommands(payload as Record<string, unknown>[]);
            return await handle.query({ query: 'query.journal' });
          }
          if (Array.isArray(payload)) throw new FemError('schema', 'payload must be an object', 'payload');
          return await (op === 'dispatch' ? handle.dispatch(payload as Record<string, unknown>) : handle.query(payload as Record<string, unknown>));
        } finally { await handle.release(); }
      };
      const result = session.tail.then(run); session.tail = result.catch(() => undefined);
      const response = await result;
      json(res, 200, { id, ok: true, value: response });
    } catch (error) { json(res, 400, { error: normalized(error) }); }
  });
  server.on('close', () => { for (const key of sessions.keys()) void drop(key); });
  server.requestTimeout = 130_000;
  server.headersTimeout = 10_000;
  return server;
}
export async function listen(options: ServeOptions, port = 7777) {
  const server = registryServer(options);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, port: (server.address() as AddressInfo).port };
}
export const randomSessionToken = (): string => randomBytes(32).toString('hex');
