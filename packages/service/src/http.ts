import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export interface HttpDependencies {
  now(): Date;
  newId(): string;
  ready(): Promise<boolean>;
}

/** Node host only. No engine construction, browser globals, implicit clock or randomness. */
export function serviceServer(deps: HttpDependencies) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const requestId = deps.newId();
    res.setHeader('x-request-id', requestId);
    res.setHeader('date', deps.now().toUTCString());
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
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
    res.statusCode = 404;
    res.end(JSON.stringify({ code: 'not-found', cause: 'This route is not available.', where: 'http', suggestion: null, requestId }));
  });
}
