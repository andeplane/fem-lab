import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ServiceFailure } from './errors';
import type { AccountResponse } from './accounts';

export interface HttpDependencies {
  now(): Date;
  newId(): string;
  ready(): Promise<boolean>;
  account?(authorization: string | undefined): Promise<AccountResponse>;
  origins?: readonly string[];
}

/** Node host only. No engine construction, browser globals, implicit clock or randomness. */
export function serviceServer(deps: HttpDependencies) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const requestId = deps.newId();
    res.setHeader('x-request-id', requestId);
    res.setHeader('date', deps.now().toUTCString());
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    const origin = req.headers.origin;
    if (origin && deps.origins?.includes(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-headers', 'authorization, content-type, idempotency-key');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.statusCode = origin && deps.origins?.includes(origin) ? 204 : 403; res.end(); return; }
    if (req.method === 'GET' && req.url === '/healthz') {
      res.end(JSON.stringify({ status: 'ok', protocol: 1 }));
      return;
    }
    if (req.method === 'GET' && req.url === '/readyz') {
      let ready = false;
      try { ready = await deps.ready(); } catch { /* dependency failure is not readiness */ }
      res.statusCode = ready ? 200 : 503;
      res.end(JSON.stringify({ status: ready ? 'ready' : 'unavailable' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/account' && deps.account) {
      try { res.end(JSON.stringify(await deps.account(req.headers.authorization))); }
      catch (error) {
        const failure = error instanceof ServiceFailure ? error : new ServiceFailure(503, 'account-unavailable', 'Account service is temporarily unavailable.', 'account');
        res.statusCode = failure.status;
        res.end(JSON.stringify({ code: failure.code, cause: failure.message, where: failure.where, suggestion: failure.suggestion, requestId }));
      }
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ code: 'not-found', cause: 'This route is not available.', where: 'http', suggestion: null, requestId }));
  });
}
