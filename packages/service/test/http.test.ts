import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { serviceServer, type HttpDependencies } from '../src/http.js';

const servers: ReturnType<typeof serviceServer>[] = [];
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>((resolve) => s.close(() => resolve())); } });
async function host(ready: HttpDependencies['ready']) {
  const server = serviceServer({ newId: () => 'request-1', now: () => new Date('2026-10-14T12:00:00Z'), ready });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('headless service host', () => {
  it('is live independently of dependency readiness and receives its clock/identity', async () => {
    const url = await host(async () => false); const response = await fetch(`${url}/healthz`);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ status: 'ok', protocol: 1 });
    expect(response.headers.get('x-request-id')).toBe('request-1');
    expect(response.headers.get('date')).toBe('Wed, 14 Oct 2026 12:00:00 GMT');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('requires explicit successful readiness, and tolerates dependency errors', async () => {
    for (const [ready, status] of [
      [async () => true, 200], [async () => false, 503],
      [async () => { throw new Error('secret database detail'); }, 503],
    ] as const) {
      const response = await fetch(`${await host(ready)}/readyz`);
      expect(response.status).toBe(status); expect(await response.text()).not.toContain('secret');
    }
  });
  it('refuses unknown routes/methods without reflecting credentials or input', async () => {
    const url = await host(async () => true);
    const response = await fetch(`${url}/healthz?apiKey=secret`, { method: 'POST', body: 'private prompt' });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: 'not-found', cause: 'This route is not available.', where: 'http', suggestion: null, requestId: 'request-1' });
  });
});
