import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { serviceServer, type HttpDependencies } from '../src/http.js';
import { ServiceFailure } from '../src/errors';

const servers: ReturnType<typeof serviceServer>[] = [];
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>((resolve) => s.close(() => resolve())); } });
async function host(ready: HttpDependencies['ready'], extra: Partial<HttpDependencies> = {}) {
  const server = serviceServer({ newId: () => 'request-1', now: () => new Date('2026-10-14T12:00:00Z'), ready, ...extra });
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
  it('exposes probe paths that Cloud Run does not reserve',async()=>{
    const url=await host(async()=>true);
    const health=await fetch(`${url}/health`);expect(health.status).toBe(200);expect(await health.json()).toMatchObject({status:'ok'});
    const ready=await fetch(`${url}/ready`);expect(ready.status).toBe(200);expect(await ready.json()).toEqual({status:'ready'});
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
  it('authenticates account reads, rejects selectors and redacts dependency failures', async () => {
    const account = { id: '11111111-1111-4111-8111-111111111111', email: 'me@example.com', status: 'active' as const, createdAt: '2026-10-14T12:00:00.000Z' };
    const url = await host(async () => true, { account: async header => {
      if (!header) throw new ServiceFailure(401, 'login-required', 'Sign in to use hosted AI.', 'identity', 'account.signIn');
      if (header === 'Bearer broken') throw new Error('database password secret');
      return account;
    } });
    const anonymous = await fetch(`${url}/v1/account`);
    expect(anonymous.status).toBe(401); expect(await anonymous.json()).toMatchObject({ code: 'login-required', requestId: 'request-1' });
    const loggedIn = await fetch(`${url}/v1/account`, { headers: { authorization: 'Bearer valid' } });
    expect(await loggedIn.json()).toEqual(account);
    expect((await fetch(`${url}/v1/account?accountId=other`, { headers: { authorization: 'Bearer valid' } })).status).toBe(404);
    const failure = await fetch(`${url}/v1/account`, { headers: { authorization: 'Bearer broken' } });
    expect(failure.status).toBe(503); expect(await failure.text()).not.toContain('secret');
  });
  it('permits only configured browser origins, without cookies or wildcard CORS', async () => {
    const url = await host(async () => true, { origins: ['https://femlab.app'] });
    const allowed = await fetch(`${url}/v1/account`, { method: 'OPTIONS', headers: { origin: 'https://femlab.app' } });
    expect(allowed.status).toBe(204); expect(allowed.headers.get('access-control-allow-origin')).toBe('https://femlab.app');
    expect(allowed.headers.get('access-control-allow-credentials')).toBeNull();
    const refused = await fetch(`${url}/v1/account`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    expect(refused.status).toBe(403); expect(refused.headers.get('access-control-allow-origin')).toBeNull();
  });
  it('passes original payment webhook bytes/signature and refuses an unconfigured payment service',async()=>{
    let raw='',signature:string|undefined;
    const url=await host(async()=>true,{billing:{receive:async(bytes,header)=>{raw=new TextDecoder().decode(bytes);signature=header;return {received:true};},process:async()=>false,recover:async()=>({processed:0,failed:0})}});
    const response=await fetch(`${url}/v1/billing/webhook`,{method:'POST',headers:{'stripe-signature':'signed-header'},body:'{ "original": 1 }\n'});
    expect(response.status).toBe(200);expect(raw).toBe('{ "original": 1 }\n');expect(signature).toBe('signed-header');
    const missing=await fetch(`${await host(async()=>true)}/v1/billing/webhook`,{method:'POST',body:'{}'});expect(missing.status).toBe(503);expect(await missing.json()).toMatchObject({code:'billing-unavailable'});
  });
});
