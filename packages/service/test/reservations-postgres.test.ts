import { grantFreeFixture } from './free-fixture';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { postgresAccounts } from '../src/accounts';
import { creditLedger } from '../src/ledger';
import { migrate } from '../src/migrations';
import { reservations } from '../src/reservations';

describe.skipIf(!process.env.TEST_DATABASE_URL)('atomic admission/recovery on real Postgres', () => {
  const schema=`reservations_${randomUUID().replaceAll('-', '')}`;
  const admin=new pg.Pool({ connectionString:process.env.TEST_DATABASE_URL });
  const settings={ connectionString:process.env.TEST_DATABASE_URL, options:`-c search_path=${schema}`, max:16 };
  const db=new pg.Pool(settings), otherProcess=new pg.Pool(settings);
  let clock=new Date('2026-10-14T12:00:00Z');
  const now=()=>clock, ledger=creditLedger(db,now,randomUUID), accounts=postgresAccounts(db,now,randomUUID);
  const a=reservations(db,now,randomUUID), b=reservations(otherProcess,now,randomUUID);
  const digest='a'.repeat(64);
  beforeAll(async()=>{
    await admin.query(`CREATE SCHEMA ${schema}`);
    const migrations=await Promise.all(['001-accounts.sql','002-credit-ledger.sql','003-ai-reservations.sql','004-provider-rejections.sql','005-billing-inbox.sql','010-free-monthly-allowance.sql'].map(async name=>({name,sql:await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8')})));
    const connection=await db.connect(); try { await migrate(connection,migrations); } finally { connection.release(); }
  });
  beforeEach(async()=>{
    clock=new Date('2026-10-14T12:00:00Z');
    await db.query('TRUNCATE accounts CASCADE');
    await db.query('UPDATE ai_limits SET enabled=true,daily_micros=100000000,monthly_micros=1000000000,free_daily_micros=20000000,free_monthly_micros=50000000,uncertain_micros=10000000,concurrent=16');
  });
  afterAll(async()=>{ await db.end(); await otherProcess.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  async function owner(uid='owner') { const account=await accounts.provision({uid,email:`${uid}@example.com`}); await grantFreeFixture(ledger, account.id, clock); return account.id; }
  async function prepare(accountId:string,key:string=randomUUID(), model='gpt-5.4-mini',maxOutput=1000) {
    return a.prepare({accountId,key,digest,turnId:'turn-1',round:0,model,maxOutput});
  }
  async function admit(accountId:string,input=1000) { const request=await prepare(accountId); await a.reserve(accountId,request.id,input); return request.id; }
  it('two service processes racing one key produce one request, one hold and one dispatch',async()=>{
    const accountId=await owner(), key='same';
    const input={accountId,key,digest,turnId:'turn-1',round:0,model:'gpt-5.4-mini',maxOutput:1000};
    const results=await Promise.all(Array.from({length:24},(_,i)=>(i%2?a:b).prepare(input)));
    expect(new Set(results.map(row=>row.id)).size).toBe(1); expect(results.filter(row=>!row.replay)).toHaveLength(1);
    const id=results[0]!.id;
    const reservations=await Promise.allSettled([a.reserve(accountId,id,1000),b.reserve(accountId,id,1000)]);
    expect(reservations.filter(row=>row.status==='fulfilled')).toHaveLength(1);
    const dispatches=await Promise.allSettled([a.dispatch(accountId,id),b.dispatch(accountId,id)]);
    expect(dispatches.filter(row=>row.status==='fulfilled')).toHaveLength(1);
    expect(await ledger.balance(accountId)).toMatchObject({availableCredits:193000,reservedCredits:7000});
    await expect(a.prepare({...input,digest:'b'.repeat(64)})).rejects.toMatchObject({status:409,code:'request-conflict'});
    await expect(prepare(accountId)).rejects.toMatchObject({code:'request-outstanding'});
  });
  it('does not admit a request whose worst-case cost exceeds the allowance',async()=>{
    const accountId=await owner();
    for(let i=0;i<2;i++){const spent=await admit(accountId,64000);await a.dispatch(accountId,spent);await a.settle(accountId,spent,{input:64000,cacheRead:0,output:1000});}
    const request=await prepare(accountId);
    await expect(a.reserve(accountId,request.id,64000)).rejects.toMatchObject({code:'credits-insufficient'});
    expect((await a.status(accountId,request.id)).state).toBe('preflight');
    await a.release(accountId,request.id);
    expect(await ledger.balance(accountId)).toMatchObject({availableCredits:60000,reservedCredits:0});
    await expect(a.dispatch(accountId,request.id)).rejects.toMatchObject({code:'request-state'});
  });
  it('settles confirmed usage once and refuses cross-account reads/settlements',async()=>{
    const accountId=await owner(), otherId=await owner('other'),id=await admit(accountId);
    await expect(a.status(otherId,id)).rejects.toMatchObject({status:404});
    await a.dispatch(accountId,id);
    await expect(a.settle(otherId,id,{input:1000,cacheRead:0,output:100})).rejects.toMatchObject({status:404});
    const usage={input:1000,cacheRead:0,output:100};
    const receipts=await Promise.all([a.settle(accountId,id,usage),b.settle(accountId,id,usage)]);
    expect(receipts[0]).toEqual(receipts[1]); expect(receipts[0]).toMatchObject({chargedCredits:1600,outcome:'confirmed',usage});
    expect(await ledger.balance(accountId)).toMatchObject({availableCredits:198400,reservedCredits:0});
    expect((await db.query('SELECT * FROM usage_receipts')).rows).toHaveLength(1);
    expect((await db.query('SELECT * FROM credit_entries')).rows).toHaveLength(1);
    const replay=await prepare(accountId,(await db.query('SELECT idempotency_key FROM ai_requests WHERE id=$1',[id])).rows[0].idempotency_key);
    expect(replay.receipt).toEqual(receipts[0]); expect(replay.replay).toBe(true);
  });
  it.each(['daily_micros','monthly_micros','free_daily_micros','free_monthly_micros','uncertain_micros'])('global %s includes outstanding holds across processes',async column=>{
    await db.query(`UPDATE ai_limits SET ${column}=6000`);
    const one=await owner('one'),two=await owner('two');
    const r1=await prepare(one),r2=await prepare(two);
    const results=await Promise.allSettled([a.reserve(one,r1.id,1000),b.reserve(two,r2.id,1000)]);
    expect(results.filter(row=>row.status==='fulfilled')).toHaveLength(1);
    expect(results.filter(row=>row.status==='rejected')).toHaveLength(1);
    expect((await db.query("SELECT count(*) AS n FROM ai_requests WHERE state='reserved'")).rows[0].n).toBe('1');
  });
  it('enforces the supplier month budget for paid usage independently of the free pool and paid renewal date',async()=>{
    const accountId=await owner();
    await ledger.grant({accountId,source:'paid-budget',plan:'plus',startsAt:clock,expiresAt:new Date('2026-11-14T12:00:00Z')});
    await db.query('UPDATE ai_limits SET monthly_micros=6000,free_daily_micros=0');
    const id=await admit(accountId);await a.dispatch(accountId,id);
    await a.settle(accountId,id,{input:1000,cacheRead:0,output:1000}); // $0.00525.
    expect(await ledger.balance(accountId)).toMatchObject({plan:'plus',availableCredits:9_993_000});
    const denied=await prepare(accountId);
    await expect(a.reserve(accountId,denied.id,1000)).rejects.toMatchObject({code:'spend-limit'});await a.release(accountId,denied.id);
    clock=new Date('2026-11-01T00:00:00Z');
    const newMonth=await admit(accountId);await a.release(accountId,newMonth);
    expect(await ledger.balance(accountId)).toMatchObject({plan:'plus',availableCredits:9_993_000});
    expect((await db.query("SELECT count(*) AS n FROM credit_grants WHERE account_id=$1 AND plan='plus'",[accountId])).rows[0].n).toBe('1');
  });
  it('global concurrency, model entitlement and context bounds fail closed',async()=>{
    const one=await owner('one'),two=await owner('two');
    await expect(prepare(one,randomUUID(),'gpt-6-astra')).rejects.toMatchObject({code:'model-not-in-plan'});
    await expect(prepare(one,'bad key')).rejects.toMatchObject({code:'invalid-idempotency-key'});
    const request=await prepare(one);
    await expect(a.reserve(one,request.id,128001)).rejects.toMatchObject({code:'context-too-large'});
    await db.query('UPDATE ai_limits SET concurrent=1'); await a.reserve(one,request.id,1000);
    const second=await prepare(two);
    await expect(b.reserve(two,second.id,1000)).rejects.toMatchObject({code:'spend-limit'});
  });
  it('expired leases release only undispatched work; dispatched work remains held',async()=>{
    const one=await owner('one'),two=await owner('two');
    const undispatched=await admit(one),dispatched=await admit(two);
    await a.dispatch(two,dispatched); await a.providerId(two,dispatched,'resp_test');
    await expect(a.release(two,dispatched)).rejects.toThrow('possibly billed');
    clock=new Date(clock.getTime()+1_200_001);
    expect(await a.recover(async()=>undefined)).toEqual({released:1,settled:0,pending:1,losses:0});
    expect((await a.status(one,undispatched)).state).toBe('released');
    expect((await a.status(two,dispatched)).state).toBe('pending_reconciliation');
    expect(await ledger.balance(two)).toMatchObject({availableCredits:193000,reservedCredits:7000});
    await expect(prepare(two)).rejects.toMatchObject({code:'request-outstanding'});
  });
  it('lookup failures keep a hold, confirmed lookup settles it, and 24h unknown usage becomes company loss',async()=>{
    const one=await owner('one'),id=await admit(one); await a.dispatch(one,id); await a.providerId(one,id,'resp_confirmed'); await a.pending(one,id);
    expect(await a.recover(async()=>{throw new Error('provider unavailable');})).toMatchObject({pending:1,losses:0});
    expect(await a.recover(async()=>({input:1000,cacheRead:0,output:100}))).toMatchObject({settled:1,pending:0});
    const two=await owner('two'),unknown=await admit(two); await a.dispatch(two,unknown); await a.pending(two,unknown);
    clock=new Date(clock.getTime()+86_400_001);
    expect(await a.recover(async()=>undefined)).toMatchObject({losses:1});
    expect((await a.status(two,unknown)).receipt).toMatchObject({outcome:'unknown',usage:null,chargedCredits:0});
    expect(await ledger.balance(two)).toMatchObject({availableCredits:200000,reservedCredits:0});
    const loss=(await db.query('SELECT supplier_micros,company_loss_micros FROM usage_receipts WHERE request_id=$1',[unknown])).rows[0];
    expect(loss).toEqual({supplier_micros:'5250',company_loss_micros:'5250'});
  });
  it('settlement stays pinned to the original grant across UTC month rollover',async()=>{
    clock=new Date('2026-10-31T23:59:00Z');
    const accountId=await owner(),id=await admit(accountId); await a.dispatch(accountId,id);
    clock=new Date('2026-11-01T00:01:00Z'); await grantFreeFixture(ledger, accountId, clock);
    await a.settle(accountId,id,{input:1000,cacheRead:0,output:100});
    expect(await ledger.balance(accountId)).toMatchObject({availableCredits:200000,reservedCredits:0});
    const debit=(await db.query('SELECT g.starts_at,e.amount FROM credit_entries e JOIN credit_grants g ON g.id=e.grant_id WHERE e.account_id=$1',[accountId])).rows[0];
    expect(debit.starts_at.toISOString()).toBe('2026-10-01T00:00:00.000Z'); expect(debit.amount).toBe('-48000');
  });
  it('account deletion freezes new admission and plan expiry is rechecked after counting',async()=>{
    const accountId=await owner(); await ledger.grant({accountId,source:'paid-one',plan:'plus',startsAt:clock,expiresAt:new Date(clock.getTime()+1000)});
    const request=await prepare(accountId,randomUUID(),'gpt-6-astra'); clock=new Date(clock.getTime()+1001);
    await expect(a.reserve(accountId,request.id,100)).rejects.toMatchObject({code:'plan-changed'}); await a.release(accountId,request.id);
    await db.query("UPDATE accounts SET status='deleting' WHERE id=$1",[accountId]);
    await expect(prepare(accountId)).rejects.toMatchObject({code:'account-inactive'});
  });
  it('limits account attempts and bounds output by the server plan',async()=>{
    const accountId=await owner();
    for(let i=0;i<20;i++) { const request=await prepare(accountId,`attempt-${i}`,'gpt-5.4-mini',16000); expect(request.maxOutput).toBe(4096); await a.release(accountId,request.id); }
    await expect(prepare(accountId)).rejects.toMatchObject({code:'rate-limited'});
  });
});
