import type { AccountPrivacy } from './privacy';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { ServiceFailure } from './errors';
import type { AccountResponse } from './accounts';
import type { Completions } from './completions';
import type { BillingLifecycle } from './billing';
import type {CheckoutService} from './checkout';
import type {MonthlyFreeAllowance} from './free-allowance';
import type {CloudProjects} from './cloud-projects';
import {PROJECT_CHUNK_BYTES} from '@femlab/registry';
import type {PublicCreditUnit} from '@femlab/registry';
import {requestedCreditUnit,accountCredits,allowanceCredits,receiptCredits,requestCredits} from './public-credits';

export interface HttpDependencies {
  now(): Date;
  newId(): string;
  ready(): Promise<boolean>;
  /** Usage quantities must be read in the requested unit; omitted means the legacy contract. */
  account?(authorization: string | undefined,creditUnit?:PublicCreditUnit): Promise<AccountResponse>;
  origins?: readonly string[];
  completions?: Completions;
  heartbeat?(callback:()=>void):()=>void;
  billing?:BillingLifecycle;
  payments?:CheckoutService;
  privacy?:AccountPrivacy;
  freeAllowance?:MonthlyFreeAllowance;
  projects?:CloudProjects;
}

async function readBytes(req:IncomingMessage,limit:number):Promise<Buffer> {
  const chunks:Buffer[]=[]; let length=0;
  for await(const chunk of req.iterator({destroyOnReturn:false})) {
    const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk); length+=bytes.length;
    if(length>limit) { req.resume(); throw new ServiceFailure(413,'request-too-large','Reduce attachments or chat context.','request'); }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
async function readJson(req:IncomingMessage):Promise<unknown> {
  if(req.headers['content-type']?.split(';')[0]?.trim().toLowerCase()!=='application/json') throw new ServiceFailure(415,'json-required','Send this request as JSON.','request');
  const bytes=await readBytes(req,16*1024*1024);
  try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); }
  catch { throw new ServiceFailure(400,'invalid-json','Send a valid JSON request.','request'); }
}
function failure(res:ServerResponse,error:unknown,requestId:string) {
  const publicError=error instanceof ServiceFailure ? error : new ServiceFailure(503,'service-unavailable','The service is temporarily unavailable.','http');
  res.statusCode=publicError.status;
  if(publicError.status===429) res.setHeader('retry-after','60');
  res.end(JSON.stringify({code:publicError.code,cause:publicError.message,where:publicError.where,suggestion:publicError.suggestion,...(publicError.details?{details:publicError.details}:{}),requestId}));
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
      res.setHeader('access-control-allow-headers', 'authorization, content-type, idempotency-key, x-femlab-credit-unit');
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.statusCode = origin && deps.origins?.includes(origin) ? 204 : 403; res.end(); return; }
    if (req.method === 'GET' && ['/health','/healthz'].includes(req.url??'')) {
      res.end(JSON.stringify({ status: 'ok', protocol: 1 }));
      return;
    }
    if (req.method === 'GET' && ['/ready','/readyz'].includes(req.url??'')) {
      let ready = false;
      try { ready = await deps.ready(); } catch { /* dependency failure is not readiness */ }
      res.statusCode = ready ? 200 : 503;
      res.end(JSON.stringify({ status: ready ? 'ready' : 'unavailable' }));
      return;
    }
    let creditUnit:PublicCreditUnit|undefined;
    try{creditUnit=requestedCreditUnit(req.headers['x-femlab-credit-unit']);}catch(error){failure(res,error,requestId);return;}
    if((req.url??'').startsWith('/v1/projects')){
      try {
        if(!deps.projects)throw new ServiceFailure(503,'cloud-projects-unavailable','Cloud project storage is unavailable. Local projects remain available.','project');
        const url=new URL(req.url!,'http://service.local'),path=url.pathname;
        if(req.method==='GET'&&path==='/v1/projects'){res.end(JSON.stringify(await deps.projects.list(req.headers.authorization,url.searchParams.get('after')??'0')));return}
        if(req.method==='POST'&&path==='/v1/projects/uploads'){res.end(JSON.stringify(await deps.projects.reserve(req.headers.authorization,req.headers['idempotency-key'],await readJson(req))));return}
        const upload=path.match(/^\/v1\/projects\/uploads\/([^/]+)\/chunks\/(\d+)$/);
        if(req.method==='PUT'&&upload){res.end(JSON.stringify(await deps.projects.put(req.headers.authorization,upload[1]!,Number(upload[2]),async()=>{if(req.headers['content-type']!=='application/octet-stream')throw new ServiceFailure(415,'binary-required','Send project chunks as application/octet-stream.','project');const length=req.headers['content-length'];if(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>PROJECT_CHUNK_BYTES))throw new ServiceFailure(413,'project-chunk-too-large','Project chunks are limited to 8,000,000 bytes.','project');return readBytes(req,PROJECT_CHUNK_BYTES)})));return}
        const commit=path.match(/^\/v1\/projects\/uploads\/([^/]+)\/commit$/);
        if(req.method==='POST'&&commit){res.end(JSON.stringify(await deps.projects.commit(req.headers.authorization,commit[1]!,await readJson(req))));return}
        const chunk=path.match(/^\/v1\/projects\/([^/]+)\/chunks\/(\d+)$/);
        if(req.method==='GET'&&chunk){const bytes=await deps.projects.chunk(req.headers.authorization,chunk[1]!,Number(chunk[2]),url.searchParams.get('revision')??'');res.setHeader('content-type','application/octet-stream');res.setHeader('content-disposition','attachment; filename="femlab-project.chunk"');res.setHeader('x-content-type-options','nosniff');res.end(bytes);return}
        const remove=path.match(/^\/v1\/projects\/([^/]+)\/delete$/);
        if(req.method==='POST'&&remove){res.end(JSON.stringify(await deps.projects.remove(req.headers.authorization,remove[1]!,req.headers['idempotency-key'],await readJson(req))));return}
        const project=path.match(/^\/v1\/projects\/([^/]+)$/);
        if(req.method==='GET'&&project){res.end(JSON.stringify(await deps.projects.read(req.headers.authorization,project[1]!)));return}
        throw new ServiceFailure(404,'not-found','This cloud project route is not available.','project');
      }catch(error){failure(res,error,requestId)}return;
    }
    if(req.method==='POST'&&req.url==='/v1/account/free-allowance'){
      try{if(!deps.freeAllowance)throw new ServiceFailure(503,'free-allowance-unavailable','Monthly free allowances are unavailable.','free-allowance');res.end(JSON.stringify(allowanceCredits(await deps.freeAllowance.claim(req.headers.authorization,await readJson(req)),creditUnit)));}
      catch(error){failure(res,error,requestId)}return;
    }
    if(req.method==='POST'&&['/v1/account/export','/v1/account/delete'].includes(req.url??'')){try{if(!deps.privacy)throw new ServiceFailure(503,'privacy-unavailable','Account data actions are temporarily unavailable.','account');const result=req.url==='/v1/account/export'?await deps.privacy.export(req.headers.authorization,await readJson(req)):await deps.privacy.delete(req.headers.authorization,await readJson(req));res.end(JSON.stringify(result));}catch(error){failure(res,error,requestId)}return;}
    if(req.method==='POST'&&req.url==='/v1/billing/webhook') {
      try {
        if(!deps.billing)throw new ServiceFailure(503,'billing-unavailable','Payments are not configured yet.','billing');
        const signature=req.headers['stripe-signature'];
        res.end(JSON.stringify(await deps.billing.receive(await readBytes(req,1024*1024),typeof signature==='string'?signature:undefined)));
      } catch(error) {failure(res,error,requestId);}return;
    }
    if(req.method==='POST'&&['/v1/billing/checkout','/v1/billing/portal','/v1/billing/plan'].includes(req.url??'')) {
      try {
        if(!deps.payments)throw new ServiceFailure(503,'billing-unavailable','Paid plans are not available yet.','billing');
        const result=req.url==='/v1/billing/portal'?await deps.payments.portal(req.headers.authorization,await readJson(req)):
          req.url==='/v1/billing/plan'?await deps.payments.change(req.headers.authorization,await readJson(req)):await deps.payments.checkout(req.headers.authorization,await readJson(req));
        res.end(JSON.stringify(result));
      }catch(error){failure(res,error,requestId);}return;
    }
    if (req.method === 'GET' && req.url === '/v1/account' && deps.account) {
      try { res.end(JSON.stringify(accountCredits(await deps.account(req.headers.authorization,creditUnit),creditUnit))); }
      catch (error) {
        const failure = error instanceof ServiceFailure ? error : new ServiceFailure(503, 'account-unavailable', 'Account service is temporarily unavailable.', 'account');
        res.statusCode = failure.status;
        res.end(JSON.stringify({ code: failure.code, cause: failure.message, where: failure.where, suggestion: failure.suggestion, requestId }));
      }
      return;
    }
    if(req.method==='GET'&&req.url==='/v1/ai/models'&&deps.account) {
      try { const account=await deps.account(req.headers.authorization); res.end(JSON.stringify({models:account.usage?.models??[],maxOutput:account.usage?.maxOutput??0,contextLimit:account.usage?.contextLimit??0,tariffVersion:account.usage?.tariffVersion??null})); }
      catch(error) { failure(res,error,requestId); } return;
    }
    if(req.method==='GET'&&/^\/v1\/ai\/requests\/[a-f0-9-]{36}$/.test(req.url??'')&&deps.completions) {
      try { res.end(JSON.stringify(requestCredits(await deps.completions.status(req.headers.authorization,req.url!.split('/').at(-1)!),creditUnit))); }
      catch(error) { failure(res,error,requestId); } return;
    }
    if(req.method==='POST'&&['/v1/ai/completions','/chat/completions'].includes(req.url??'')&&deps.completions) {
      const abort=new AbortController(); let streaming=false,stopHeartbeat:(()=>void)|undefined;
      const onClose=()=>abort.abort(); res.once('close',onClose);
      try {
        const result=await deps.completions.run({authorization:req.headers.authorization,key:typeof req.headers['idempotency-key']==='string'?req.headers['idempotency-key']:undefined,body:await readJson(req),signal:abort.signal},{
          start(){ streaming=true; res.setHeader('content-type','text/event-stream'); res.setHeader('x-accel-buffering','no'); res.flushHeaders();
            stopHeartbeat=deps.heartbeat?.(()=>{if(!res.destroyed) res.write(': keep-alive\n\n');}); },
          async send(event) { if(abort.signal.aborted) return;const publicEvent=event.type==='receipt'?{...event,receipt:receiptCredits(event.receipt,creditUnit)}:event.type==='request'?{...event,request:requestCredits(event.request,creditUnit)}:event;if(!res.write(`event: ${event.type}\ndata: ${JSON.stringify(publicEvent)}\n\n`)) await once(res,'drain',{signal:abort.signal}); },
        });
        if(!res.destroyed) res.end(result?JSON.stringify(requestCredits(result,creditUnit)):undefined);
      } catch(error) {
        if(!res.destroyed) { if(streaming) res.end(); else failure(res,error,requestId); }
      } finally { stopHeartbeat?.(); res.removeListener('close',onClose); }
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ code: 'not-found', cause: 'This route is not available.', where: 'http', suggestion: null, requestId }));
  });
}
