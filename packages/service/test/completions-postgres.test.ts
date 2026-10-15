import { grantFreeFixture } from './free-fixture';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import pg from 'pg';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import type {ChatEvent,ChatRequest} from '@femlab/ai';
import {postgresAccounts} from '../src/accounts';
import {creditLedger} from '../src/ledger';
import {migrate} from '../src/migrations';
import {reservations} from '../src/reservations';
import {completionService} from '../src/completions';
import {serviceServer} from '../src/http';
import type {ProviderGateway,Observations} from '../src/provider';
import {ServiceFailure} from '../src/errors';

describe.skipIf(!process.env.TEST_DATABASE_URL)('authenticated completion HTTP pipeline',()=>{
  const schema=`completions_${randomUUID().replaceAll('-','')}`,admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
  const db=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
  const now=()=>new Date('2026-10-14T12:00:00Z'),ledger=creditLedger(db,now,randomUUID),accounts=postgresAccounts(db,now,randomUUID),holds=reservations(db,now,randomUUID);
  let counted:ChatRequest|undefined,generated=0,mode='complete',url='';
  const provider:ProviderGateway={
    async countInput(request){counted=request;if(mode==='count-failure')throw new Error('private supplier failure');return 1000;},
    async *chat(_request,observations:Observations):AsyncIterable<ChatEvent>{
      generated++;
      if(mode==='rejected'){await observations.rejected!();yield {type:'error',message:'provider rejected'};return;}
      await observations.providerId('resp_pipeline');
      yield {type:'text_delta',text:'hello'};
      if(mode==='waiting') { if(!_request.signal?.aborted) await new Promise<void>(resolve=>_request.signal!.addEventListener('abort',()=>resolve(),{once:true})); return; }
      if(mode==='interrupted')throw new Error('network private error');
      if(mode==='missing-usage'){yield {type:'done',stopReason:'end_turn'};return;}
      const usage={input:1000,cacheRead:0,output:100};await observations.usage(usage);
      yield {type:'tool_use',id:'call-one',name:'query_nodes',input:{set:'all'}};
      yield {type:'usage',usage};yield {type:'continuation',continuation:{provider:'openai',value:[]}};yield {type:'done',stopReason:'tool_use'};
    },
  };
  const account=async(header:string|undefined)=>{if(!header?.startsWith('Bearer '))throw new ServiceFailure(401,'login-required','Sign in to use hosted AI.','identity');const owner=await accounts.provision({uid:header.slice(7),email:`${header.slice(7)}@example.com`});if(mode!=='unapproved')await grantFreeFixture(ledger,owner.id,now());return owner;};
  const completions=completionService({account,ledger,reservations:holds,provider});
  const server=serviceServer({now,newId:randomUUID,ready:async()=>true,account,completions});
  const body={protocol:1,turnId:'turn-one',round:0,model:'gpt-5.4-mini',maxTokens:1000,system:'project context',messages:[{role:'user',content:[{type:'text',text:'inspect'}]}],tools:[]};
  beforeAll(async()=>{
    await admin.query(`CREATE SCHEMA ${schema}`);
    const migrations=await Promise.all(['001-accounts.sql','002-credit-ledger.sql','003-ai-reservations.sql','004-provider-rejections.sql','005-billing-inbox.sql'].map(async name=>({name,sql:await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8')})));
    const connection=await db.connect();try{await migrate(connection,migrations);}finally{connection.release();}
    server.listen(0,'127.0.0.1');await once(server,'listening');url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(async()=>{await db.query('TRUNCATE accounts CASCADE');counted=undefined;generated=0;mode='complete';});
  afterAll(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await db.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  const send=(key='key-one',input:unknown=body,authorization='Bearer owner')=>fetch(`${url}/v1/ai/completions`,{method:'POST',headers:{authorization,'content-type':'application/json','idempotency-key':key},body:JSON.stringify(input)});
  it('denies disposable verified identities before any provider call unless explicitly approved',async()=>{
    mode='unapproved';
    for(let i=0;i<8;i++){const response=await send('signup',body,`Bearer disposable-${i}`);expect(response.status).toBe(402);}
    expect(counted).toBeUndefined();expect(generated).toBe(0);
    expect((await db.query('SELECT * FROM credit_grants')).rows).toHaveLength(0);
    expect((await db.query('SELECT * FROM ai_requests')).rows).toHaveLength(0);
  });
  it('staging initialization denies free and test-paid credits before counting or generation',async()=>{
    const original=(await db.query('SELECT * FROM ai_limits WHERE id=true')).rows[0];
    const paid=await account('Bearer paid');
    await ledger.grant({accountId:paid.id,source:'stripe-test-paid',plan:'plus',startsAt:now(),expiresAt:new Date('2026-11-14T12:00:00Z')});
    const pause=await readFile(new URL('../../../infra/google/sql-staging-ai-paused.sql',import.meta.url),'utf8');
    try {
      await db.query(pause);await db.query(pause);
      expect((await db.query('SELECT enabled,daily_micros,monthly_micros,free_daily_micros,uncertain_micros FROM ai_limits')).rows[0])
        .toEqual({enabled:false,daily_micros:'0',monthly_micros:'0',free_daily_micros:'0',uncertain_micros:'0'});
      for(const uid of ['free','paid']) {
        const response=await send('paused',body,`Bearer ${uid}`);
        expect(response.status).toBe(503);expect(await response.json()).toMatchObject({code:'ai-unavailable'});
      }
      expect(counted).toBeUndefined();expect(generated).toBe(0);
      expect((await db.query('SELECT * FROM ai_requests')).rows).toHaveLength(0);
      expect((await db.query('SELECT * FROM usage_receipts')).rows).toHaveLength(0);
      expect((await ledger.balance(paid.id)).availableCredits).toBe(10000000);
      await db.query('DELETE FROM ai_limits');await db.query('INSERT INTO ai_limits(id) VALUES(true)');
      expect((await db.query('SELECT enabled,daily_micros,monthly_micros,free_daily_micros,uncertain_micros FROM ai_limits')).rows[0])
        .toEqual({enabled:false,daily_micros:'0',monthly_micros:'0',free_daily_micros:'0',uncertain_micros:'0'});
    } finally {
      await db.query('UPDATE ai_limits SET enabled=$1,daily_micros=$2,monthly_micros=$3,free_daily_micros=$4,uncertain_micros=$5 WHERE id=true',
        [original.enabled,original.daily_micros,original.monthly_micros,original.free_daily_micros,original.uncertain_micros]);
    }
  });
  it('streams normalized calls/continuation, with the authoritative receipt before executable tools',async()=>{
    const response=await send();expect(response.status).toBe(200);expect(response.headers.get('content-type')).toBe('text/event-stream');
    const stream=await response.text();expect(stream).toContain('query_nodes');expect(stream).toContain('continuation');
    expect(stream.indexOf('event: receipt')).toBeLessThan(stream.indexOf('"type":"tool_use"'));
    expect(counted?.maxTokens).toBe(1000);expect(generated).toBe(1);
    const row=(await db.query('SELECT id,state FROM ai_requests')).rows[0];expect(row.state).toBe('settled');
    const status=await fetch(`${url}/v1/ai/requests/${row.id}`,{headers:{authorization:'Bearer owner'}});expect(await status.json()).toMatchObject({receipt:{chargedCredits:1600,outcome:'confirmed'}});
    expect((await fetch(`${url}/v1/ai/requests/${row.id}`,{headers:{authorization:'Bearer another'}})).status).toBe(404);
    const replay=await send();expect(replay.headers.get('content-type')).toBe('application/json');expect(await replay.json()).toMatchObject({replay:true,state:'settled'});expect(generated).toBe(1);
    expect((await send('key-one',{...body,system:'changed'})).status).toBe(409);
  });
  it('rejects identity/client authority/remote references before counting or generating',async()=>{
    expect((await send('anonymous',body,'')).status).toBe(401);
    for(const input of [{...body,accountId:'another'},{...body,tier:'studio'},{...body,model:'gpt-6-astra'},
      {...body,messages:[{role:'assistant',content:[],continuation:{provider:'openai',value:[{type:'input_file',file_url:'https://private.example'}]}}]},
      {...body,messages:[{role:'user',content:[{type:'image',mediaType:'image/png',base64:'https://remote.example'}]}]},
    ]) expect((await send(randomUUID(),input)).status).toBeGreaterThanOrEqual(400);
    expect(counted).toBeUndefined();expect(generated).toBe(0);
  });
  it('releases preflight failures but holds interrupted generation or missing usage',async()=>{
    mode='count-failure';const failed=await send();expect(failed.status).toBe(503);expect(await failed.text()).not.toContain('private');
    expect((await db.query('SELECT state FROM ai_requests')).rows[0].state).toBe('released');
    mode='interrupted';const interrupted=await send('interrupted');expect((await interrupted.text())).toContain('interrupted');
    expect((await db.query("SELECT state FROM ai_requests WHERE idempotency_key='interrupted'")).rows[0].state).toBe('pending_reconciliation');
    expect((await send('retry')).status).toBe(429);
    mode='missing-usage';const missing=await send('missing',body,'Bearer other');const events=await missing.text();
    expect(events).toContain('pending confirmation');expect(events).not.toContain('"type":"done"');
    expect((await db.query('SELECT * FROM usage_receipts')).rows).toHaveLength(1); // the provably undispatched request only
  });
  it('bounds and validates the HTTP body and MIME type',async()=>{
    const headers={authorization:'Bearer owner','content-type':'application/json','idempotency-key':'invalid'};
    const invalid=await fetch(`${url}/v1/ai/completions`,{method:'POST',headers,body:'{broken'});expect(invalid.status).toBe(400);
    const large=await fetch(`${url}/v1/ai/completions`,{method:'POST',headers,body:JSON.stringify({text:'x'.repeat(16*1024*1024)})});expect(large.status).toBe(413);
    const mime=await fetch(`${url}/v1/ai/completions`,{method:'POST',body:'plain'});expect(mime.status).toBe(415);
    expect(generated).toBe(0);
  });
  it('distinguishes an explicit unbilled rejection from unknown usage',async()=>{
    mode='rejected'; const response=await send();expect(await response.text()).toContain('provider-rejected');
    const receipt=(await db.query('SELECT outcome,usage,charged_subcredits,supplier_micros FROM usage_receipts')).rows[0];
    expect(receipt).toEqual({outcome:'provider-rejected',usage:null,charged_subcredits:'0',supplier_micros:'0'});
    expect((await db.query('SELECT state FROM ai_requests')).rows[0].state).toBe('released');
  });
  it('cancels a quiet upstream when the browser disconnects and retains its hold',async()=>{
    mode='waiting';const abort=new AbortController();
    const response=await fetch(`${url}/chat/completions`,{method:'POST',headers:{authorization:'Bearer owner','content-type':'application/json','idempotency-key':'cancel'},body:JSON.stringify(body),signal:abort.signal});
    await response.body!.getReader().read();abort.abort();
    await expect.poll(async()=>(await db.query("SELECT state FROM ai_requests WHERE idempotency_key='cancel'")).rows[0].state).toBe('pending_reconciliation');
    expect((await db.query('SELECT * FROM usage_receipts')).rows).toHaveLength(0);
  });
  it('accepts bounded real image bytes and rejects excessive dimensions/count before admission',async()=>{
    const base64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZI0AAAAASUVORK5CYII=';
    const image={type:'image',mediaType:'image/png',base64};
    const valid=await send('image',{...body,messages:[{role:'user',content:[image]}]});
    expect(valid.status).toBe(200);await valid.text();expect(counted?.messages[0]!.content[0]).toMatchObject({base64});
    const huge=Buffer.from(base64,'base64');huge.writeUInt32BE(2000,16);
    const bounds=await send('huge',{...body,messages:[{role:'user',content:[{...image,base64:huge.toString('base64')}]}]});expect(bounds.status).toBe(422);
    const many=await send('many',{...body,messages:[{role:'user',content:[image,image,image]}]});expect(await many.json()).toMatchObject({code:'too-many-images'});
    const mismatch=await send('mime',{...body,messages:[{role:'user',content:[{...image,mediaType:'image/jpeg'}]}]});expect(mismatch.status).toBe(422);
    expect(generated).toBe(1);
  });
});
