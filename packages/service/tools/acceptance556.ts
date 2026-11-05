/** Disposable cloud drill only. Never part of the production image/entry point. */
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import {setTimeout as sleep} from 'node:timers/promises';
import {migrate} from '../src/migrations';
import {postgresAccounts} from '../src/accounts';
import {creditLedger} from '../src/ledger';
import {reservations} from '../src/reservations';
import {completionService} from '../src/completions';
import {serviceServer} from '../src/http';
import {billingLifecycle,type BillingGateway,type BillingEnvelope} from '../src/billing';
import {operationalSnapshot} from '../src/operations';
import {ServiceFailure} from '../src/errors';
import type {ProviderGateway} from '../src/provider';

if(!/^femlab_qa556_[a-z0-9_]+$/.test(process.env.PGDATABASE??''))throw new Error('Only a dedicated qa556 database is allowed.');
if(!/^qa556_[a-z0-9_]+$/.test(process.env.PGUSER??''))throw new Error('Only a dedicated QA database role is allowed.');
if(['OPENAI_API_KEY','STRIPE_SECRET_KEY','FIREBASE_PROJECT_ID'].some(key=>process.env[key]))throw new Error('Supplier, payment and Auth configuration is forbidden in the synthetic fixture.');
const token=process.env.QA_TOKEN??'',prefix=process.env.QA_PREFIX??'';
if(token.length<32||!/^\/qa556_[a-z0-9]+$/.test(prefix))throw new Error('A private per-run capability is required.');
const equal=(a:string,b:string)=>a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const db=new pg.Pool({max:8,connectionTimeoutMillis:5000,statement_timeout:5000});
const now=()=>new Date();const accounts=postgresAccounts(db,now,randomUUID),ledger=creditLedger(db,now,randomUUID),holds=reservations(db,now,randomUUID);
const start=Number(process.env.QA_PERIOD_START);if(!Number.isSafeInteger(start))throw new Error('Missing frozen canonical period.');
let renewal=false,refunded=false,stopping=false,generated=0,canceled=0;
const gateway:BillingGateway={
 verify(bytes,signature){if(!equal(signature,token))throw new Error('Invalid fixture signature.');return JSON.parse(new TextDecoder().decode(bytes)) as BillingEnvelope;},
 async invoice(id){const uid=id.split('_').at(-1)!;const begins=start+(renewal?30*86400:0);return {id,customerId:`cus_qa556_${uid}`,subscriptionId:`sub_qa556_${uid}`,status:'paid',currency:'usd',reason:renewal?'subscription_cycle':'subscription_create',amountPaid:4900,lines:[{priceId:'price_qa556_plus',quantity:1,proration:false,start:begins,end:begins+30*86400}]};},
 async subscription(id){return {id,customerId:id.replace('sub_','cus_'),status:'active',cancelAtPeriodEnd:false,periodEnd:start+(renewal?60:30)*86400};},
 async chargeCustomer(id){return id.replace('ch_','cus_');},
};
const billing=billingLifecycle(db,gateway,{live:false,prices:{plus:'price_qa556_plus',pro:'price_qa556_pro',studio:'price_qa556_studio'}},now,randomUUID);
const event=(uid:string,kind='invoice.paid'):BillingEnvelope=>({id:`evt_qa556_${kind==='charge.refunded'?'refund':renewal?'renewal':'first'}_${uid}`,type:kind,objectId:kind==='charge.refunded'?`ch_qa556_${uid}`:`in_qa556_${renewal?'renewal_':''}${uid}`,customerId:`cus_qa556_${uid}`,live:false});
async function seed(){
 const dir=new URL('../migrations/',import.meta.url);const migrations=await Promise.all((await readdir(dir)).filter(n=>n.endsWith('.sql')).sort().map(async name=>({name,sql:await readFile(new URL(name,dir),'utf8')})));
 const connection=await db.connect();try{await migrate(connection,migrations);}finally{connection.release();}
 for(let i=0;i<24;i++){const uid=String(i);const owner=await accounts.provision({uid:`qa556-${uid}`,email:`qa556-${uid}@example.invalid`});await db.query('INSERT INTO billing_accounts(account_id,customer_id,updated_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[owner.id,`cus_qa556_${uid}`,now()]);await billing.receive(Buffer.from(JSON.stringify(event(uid))),token);}
 // Only this isolated DB receives synthetic caps; public staging remains zero.
 await db.query('UPDATE ai_limits SET enabled=true,daily_micros=1000000,monthly_micros=1000000,uncertain_micros=1000000,concurrent=16');
}
const account=async(header:string|undefined)=>{
 const match=header?.match(/^Bearer ([^:]+):(\d{1,2})$/);if(!match||!equal(match[1]!,token)||Number(match[2])>=24)throw new ServiceFailure(401,'login-required','Private acceptance capability required.','identity');
 return accounts.provision({uid:`qa556-${match[2]}`,email:`qa556-${match[2]}@example.invalid`});
};
const provider:ProviderGateway={
 async countInput(request){if(request.system.includes('qa-input-failure'))throw new Error('private fake input failure');return 100;},
 async *chat(request,observe){generated++;if(request.system.includes('qa-rejected')){await observe.rejected!();yield {type:'error',message:'Synthetic rejection'};return;}await observe.providerId(`resp_qa556_${randomUUID()}`);yield {type:'text_delta',text:'started'};
  if(request.system.includes('qa-stream-failure'))throw new Error('private fake stream failure');
  if(request.system.includes('qa-missing-usage')){yield {type:'done',stopReason:'end_turn'};return;}
  const seconds=/seconds=(\d+)/.exec(request.system)?.[1]??'2';const duration=Math.min(Number(seconds),90)*1000;
  try{await sleep(duration,undefined,{signal:request.signal});}catch{canceled++;return;}
  const usage={input:100,cacheRead:0,output:10};await observe.usage(usage);yield {type:'usage',usage};yield {type:'done',stopReason:'end_turn'};
 },
};
const completions=completionService({account,ledger,reservations:holds,provider,observe:event=>console.log(JSON.stringify({...event,at:now().toISOString(),synthetic:true,drillRun:prefix.slice(1)}))});
const server=serviceServer({now,newId:randomUUID,ready:async()=>!stopping,account,completions,heartbeat(cb){const timer=setInterval(cb,1000);return()=>clearInterval(timer);}});
const normal=server.listeners('request')[0]!;server.removeAllListeners('request');
server.on('request',(req,res)=>{void(async()=>{
 if(req.url==='/ready'){normal.call(server,req,res);return;}
 if(!req.url?.startsWith(prefix+'/')){res.statusCode=404;res.end();return;}
 req.url=req.url.slice(prefix.length);
 if(!req.url.startsWith('/__qa/')){normal.call(server,req,res);return;}
 if(!equal(req.headers.authorization??'',`Bearer ${token}`)){res.statusCode=401;res.end();return;}
 res.setHeader('content-type','application/json');
 if(req.url==='/__qa/operations'){const snapshot=await operationalSnapshot(db,now);console.log(JSON.stringify({...snapshot,synthetic:true,drillRun:prefix.slice(1)}));res.end(JSON.stringify(snapshot));return;}
 if(req.url==='/__qa/status'){res.end(JSON.stringify({generated,canceled,revision:process.env.K_REVISION,operations:await operationalSnapshot(db,now),requests:(await db.query('SELECT state,count(*)::text FROM ai_requests GROUP BY state ORDER BY state')).rows,receipts:(await db.query('SELECT outcome,count(*)::text,sum(charged_subcredits)::text AS charged FROM usage_receipts GROUP BY outcome ORDER BY outcome')).rows,grants:(await db.query("SELECT count(*)::text FROM credit_grants WHERE plan='plus'")).rows[0],blocked:(await db.query('SELECT count(*)::text FROM billing_accounts WHERE blocked')).rows[0]}));return;}
 if(req.method!=='POST'){res.statusCode=405;res.end();return;}
 if(req.url==='/__qa/pause'){await db.query('UPDATE ai_limits SET enabled=false');res.end('{"paused":true}');return;}
 if(req.url==='/__qa/reconcile'){
  // Simulate external canonical refund/renewal arriving after the backup. It is outside restored SQL.
  renewal=true;refunded=true;
  await billing.receive(Buffer.from(JSON.stringify(event('23','charge.refunded'))),token);
  await billing.receive(Buffer.from(JSON.stringify(event('22'))),token);
  await billing.receive(Buffer.from(JSON.stringify(event('22'))),token);
  const recovered=await holds.recover(async()=>({input:100,cacheRead:0,output:10}));
  const billingResult=await billing.recover();res.end(JSON.stringify({refunded,renewal,recovered,billing:billingResult}));return;
 }
 if(req.url==='/__qa/resume'){await db.query('UPDATE ai_limits SET enabled=true');res.end('{"enabled":true}');return;}
 if(req.url==='/__qa/terminate'){res.end('{"terminating":true}');process.kill(process.pid,'SIGTERM');return;}
 res.statusCode=404;res.end();
 })().catch(()=>{res.statusCode=500;res.end('{"error":"acceptance-failed"}');});});
if(process.argv.includes('--seed')){await seed();await db.end();}else{
 server.listen(Number(process.env.PORT??8080),'0.0.0.0');
 process.once('SIGTERM',()=>{stopping=true;void server.drain(5000).finally(()=>db.end()).then(()=>{process.exitCode=0;},()=>{process.exitCode=1;});});
}
