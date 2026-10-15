import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {postgresAccounts,type Account,type AccountResponse} from '../src/accounts';
import {migrate} from '../src/migrations';
import {creditLedger} from '../src/ledger';
import {reservations} from '../src/reservations';
import {approveTrial} from '../src/trials';
import {monthlyFreeAllowance} from '../src/free-allowance';
import {canonicalFreeEmail,freeEmailFingerprint,manageFreeEligibility} from '../src/free-eligibility';
import {CREDIT_SCALE,FREE_MONTHLY_CREDITS,supplierMicros} from '../src/credits';
import {accountPrivacy} from '../src/privacy';
import {serviceServer} from '../src/http';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';

describe.skipIf(!process.env.TEST_DATABASE_URL)('reviewed monthly free allowances on real PostgreSQL',()=>{
  const suffix=randomUUID().replaceAll('-',''),schema=`monthly_${suffix}`;
  const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
  const db=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`,max:24});
  const second=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`,max:24});
  let clock=new Date('2026-10-15T12:00:00Z');const now=()=>clock;
  const fingerprint=freeEmailFingerprint('fixture-secret-is-at-least-32-bytes-long');
  const accounts=postgresAccounts(db,now,randomUUID),ledger=creditLedger(db,now,randomUUID,fingerprint),holds=reservations(db,now,randomUUID,fingerprint);
  async function owner(uid=randomUUID(),email=`${uid}@example.com`){return accounts.provision({uid,email});}
  const service=(account:Account,database=db,key=fingerprint)=>monthlyFreeAllowance(database,async()=>account,now,randomUUID,key);
  const manage=(action:'approve'|'revoke'|'rebind',account:Account,reference='reviewed-person')=>manageFreeEligibility(db,action,account.id,reference,now,randomUUID,fingerprint);
  const prepare=(account:Account)=>holds.prepare({accountId:account.id,key:randomUUID(),digest:'a'.repeat(64),turnId:'monthly-test',round:0,model:'gpt-5.4-mini',maxOutput:1000});
  beforeAll(async()=>{
    await admin.query(`CREATE SCHEMA ${schema}`);
    const dir=new URL('../migrations/',import.meta.url),migrations=await Promise.all((await readdir(dir)).filter(name=>name.endsWith('.sql')).sort().map(async name=>({name,sql:await readFile(new URL(name,dir),'utf8')})));
    const connection=await db.connect();try{await migrate(connection,migrations);}finally{connection.release();}
  });
  beforeEach(async()=>{
    clock=new Date('2026-10-15T12:00:00Z');await db.query('TRUNCATE accounts CASCADE');
    await db.query('UPDATE ai_limits SET enabled=true,daily_micros=100000000,monthly_micros=1000000000,free_daily_micros=10000000,free_monthly_micros=50000000,uncertain_micros=10000000,concurrent=16');
  });
  afterAll(async()=>{await db.end();await second.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  it('never mints on signup/read, requires operator eligibility, rejects caller selectors and fails closed without the key',async()=>{
    const account=await owner(),api=service(account);
    expect(await api.status(account.id)).toMatchObject({status:'review-required',credits:6_666_666});
    expect((await ledger.balance(account.id)).availableCredits).toBe(0);
    await expect(api.claim(undefined,{})).rejects.toMatchObject({code:'eligibility-required'});
    for(const body of [{accountId:account.id},{credits:1000000000},{period:'2099-01'}])await expect(api.claim(undefined,body)).rejects.toMatchObject({code:'invalid-free-allowance'});
    await manage('approve',account);expect((await ledger.balance(account.id)).availableCredits).toBe(0);
    const unavailable=monthlyFreeAllowance(db,async()=>account,now,randomUUID);
    expect((await unavailable.status(account.id)).status).toBe('unavailable');await expect(unavailable.claim(undefined,{})).rejects.toMatchObject({code:'free-allowance-unavailable'});
    expect((await db.query('SELECT * FROM credit_grants')).rows).toHaveLength(0);
  });
  it('24 concurrent claims across processes issue exactly one $5 baseline grant',async()=>{
    const account=await owner();await manage('approve',account);
    const api=service(account),other=service(account,second);
    const claims=await Promise.all(Array.from({length:24},(_,i)=>(i%2?api:other).claim(undefined,{})));
    expect(claims.filter(value=>!value.replay)).toHaveLength(1);
    expect(await api.status(account.id)).toMatchObject({status:'claimed',periodStartsAt:'2026-10-01T00:00:00.000Z',periodEndsAt:'2026-11-01T00:00:00.000Z'});
    expect(await ledger.balance(account.id)).toMatchObject({plan:'free',availableCredits:6_666_666,totalCredits:6_666_666});
    const grants=(await db.query('SELECT amount,source FROM credit_grants')).rows;expect(grants).toHaveLength(1);expect(grants[0]!.amount).toBe('199999980');
    expect(supplierMicros(BigInt(grants[0]!.amount))).toBe(5_000_000n);expect(supplierMicros(BigInt(FREE_MONTHLY_CREDITS)*CREDIT_SCALE)).toBe(5_000_000n);
    expect((await creditLedger(db,now,randomUUID).balance(account.id)).availableCredits).toBe(0);
    await expect(reservations(db,now,randomUUID).prepare({accountId:account.id,key:randomUUID(),digest:'a'.repeat(64),turnId:'key-unavailable',round:0,model:'gpt-5.4-mini',maxOutput:1000})).rejects.toMatchObject({code:'credits-exhausted'});
  });
  it('negotiates precise account and claim amounts while preserving existing grants, tiny charges and legacy clients',async()=>{
    const account=await owner();await manage('approve',account);const api=service(account);await api.claim(undefined,{});
    const originalGrant=(await db.query('SELECT * FROM credit_grants')).rows[0];
    // Independently priced: 112 uncached Mini input tokens cost $0.000084;
    // one cached input token costs $0.000000075. Neither debit rounds to a whole credit.
    for(const usage of [{input:112,cacheRead:0,output:0},{input:0,cacheRead:1,output:0}]){
      const request=await prepare(account);await holds.reserve(account.id,request.id,112);await holds.dispatch(account.id,request.id);
      await holds.settle(account.id,request.id,usage);await holds.settle(account.id,request.id,usage);
    }
    const server=serviceServer({now,newId:randomUUID,ready:async()=>true,freeAllowance:api,account:async(_header,unit)=>({...account,usage:await ledger.balance(account.id,unit),freeAllowance:await api.status(account.id)})});
    server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try{
      const legacy=await(await fetch(url+'/v1/account')).json() as AccountResponse;expect(legacy).not.toHaveProperty('creditUnit');
      expect(legacy.usage).toMatchObject({totalCredits:6666666,availableCredits:6666553,reservedCredits:0});
      const headers={'x-femlab-credit-unit':'usd-milli-v1'};
      const scaled=await(await fetch(url+'/v1/account',{headers})).json();
      expect(scaled).toMatchObject({creditUnit:'usd-milli-v1',usage:{totalCredits:4999.9995,availableCredits:4999.915425,reservedCredits:0},freeAllowance:{status:'claimed',credits:4999.9995}});
      const claim=await(await fetch(url+'/v1/account/free-allowance',{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{}'})).json();
      expect(claim).toMatchObject({creditUnit:'usd-milli-v1',credits:4999.9995,replay:true});
      const oldClaim=await(await fetch(url+'/v1/account/free-allowance',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).json();
      expect(oldClaim).toMatchObject({credits:6666666,replay:true});expect(oldClaim).not.toHaveProperty('creditUnit');
      expect((await db.query('SELECT * FROM credit_grants')).rows).toEqual([originalGrant]);
      expect((await db.query("SELECT amount FROM credit_entries WHERE kind='usage' ORDER BY amount::bigint")).rows).toEqual([{amount:'-3360'},{amount:'-3'}]);
      expect((await db.query('SELECT charged_subcredits FROM usage_receipts ORDER BY charged_subcredits')).rows).toEqual([{charged_subcredits:'3'},{charged_subcredits:'3360'}]);
      expect((await db.query("SELECT * FROM ai_requests WHERE state=ANY($1)",[['reserved','dispatched','pending_reconciliation']])).rows).toHaveLength(0);
    }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
  it('retains one-time invitations unchanged but never stacks or falls back after monthly review/revocation',async()=>{
    const account=await owner();await approveTrial(db,account.id,'old-invite',now,randomUUID);
    const old=(await db.query('SELECT * FROM credit_grants')).rows[0];expect(old!.amount).toBe('6000000');expect((await ledger.balance(account.id)).availableCredits).toBe(200000);
    await manage('approve',account);expect((await ledger.balance(account.id)).availableCredits).toBe(0);
    await service(account).claim(undefined,{});expect((await ledger.balance(account.id)).availableCredits).toBe(6_666_666);
    await manage('revoke',account);expect((await ledger.balance(account.id)).availableCredits).toBe(0);
    expect((await db.query('SELECT * FROM credit_grants WHERE id=$1',[old!.id])).rows[0]).toEqual(old);
  });
  it('revocation is rechecked before prepare, reserve and dispatch; accepted dispatched usage settles once',async()=>{
    const account=await owner();await manage('approve',account);await service(account).claim(undefined,{});
    await manage('revoke',account);await expect(prepare(account)).rejects.toMatchObject({code:'credits-exhausted'});
    await manage('approve',account);const preflight=await prepare(account);await manage('revoke',account);
    await expect(holds.reserve(account.id,preflight.id,1000)).rejects.toMatchObject({code:'credits-insufficient'});await holds.release(account.id,preflight.id);
    await manage('approve',account);const reserved=await prepare(account);await holds.reserve(account.id,reserved.id,1000);await manage('revoke',account);
    await expect(holds.dispatch(account.id,reserved.id)).rejects.toMatchObject({code:'free-allowance-revoked'});await holds.release(account.id,reserved.id);
    await manage('approve',account);const dispatched=await prepare(account);await holds.reserve(account.id,dispatched.id,1000);await holds.dispatch(account.id,dispatched.id);await manage('revoke',account);
    const usage={input:1000,cacheRead:0,output:100};await holds.settle(account.id,dispatched.id,usage);await holds.settle(account.id,dispatched.id,usage);
    expect((await db.query("SELECT amount FROM credit_entries WHERE kind='usage'")).rows).toEqual([{amount:'-48000'}]);expect((await ledger.balance(account.id)).availableCredits).toBe(0);
    await expect(service(account).claim(undefined,{})).rejects.toMatchObject({code:'free-allowance-revoked'});
  });
  it('blocked billing and exhausted paid grants never fall back to the free pool',async()=>{
    const account=await owner();await manage('approve',account);await service(account).claim(undefined,{});
    await db.query('INSERT INTO billing_accounts(account_id,customer_id,blocked,updated_at) VALUES($1,$2,true,$3)',[account.id,'cus_owned',clock]);
    expect((await ledger.balance(account.id)).availableCredits).toBe(0);await expect(service(account).claim(undefined,{})).rejects.toMatchObject({code:'billing-review'});
    await db.query('UPDATE billing_accounts SET blocked=false WHERE account_id=$1',[account.id]);
    await ledger.grant({accountId:account.id,source:'paid-period',plan:'plus',startsAt:clock,expiresAt:new Date('2026-11-15T12:00:00Z')});
    const grant=(await db.query("SELECT id,amount FROM credit_grants WHERE plan='plus'")).rows[0]!;
    await db.query("INSERT INTO credit_entries(id,account_id,grant_id,source,amount,kind,created_at) VALUES($1,$2,$3,'spent-paid',$4,'usage',$5)",[randomUUID(),account.id,grant.id,'-'+grant.amount,clock]);
    expect(await ledger.balance(account.id)).toMatchObject({plan:'plus',availableCredits:0});await expect(service(account).claim(undefined,{})).rejects.toMatchObject({code:'paid-allowance-active'});
  });
  it('canonical Gmail aliases cannot obtain another principal; custom domain aliases are not guessed',async()=>{
    expect(()=>freeEmailFingerprint('short')).toThrow();
    expect(canonicalFreeEmail(' F.ree+offer@Googlemail.com ')).toBe('free@gmail.com');
    expect(canonicalFreeEmail('F.ree+offer@example.com')).toBe('f.ree+offer@example.com');
    const first=await owner(randomUUID(),'F.ree+offer@Googlemail.com'),other=await owner(randomUUID(),'free@gmail.com');await manage('approve',first);
    await expect(manage('approve',other,'another-reference')).rejects.toMatchObject({code:'eligibility-conflict'});
    await expect(manage('approve',other)).rejects.toMatchObject({code:'eligibility-conflict'});
    await expect(manage('rebind',other)).rejects.toMatchObject({code:'eligibility-conflict'});
  });
  it('explicit reviewed email changes retain old fingerprints and never silently carry eligibility',async()=>{
    const uid=randomUUID(),account=await owner(uid,'before@example.com');await manage('approve',account);await service(account).claim(undefined,{});
    await owner(uid,'after@example.com');expect((await ledger.balance(account.id)).availableCredits).toBe(0);
    await expect(service(account).claim(undefined,{})).rejects.toMatchObject({code:'eligibility-required'});
    await manage('approve',account);expect((await service(account).claim(undefined,{})).replay).toBe(true);
    expect((await db.query('SELECT * FROM free_eligibility_identities')).rows).toHaveLength(2);
    const duplicate=await owner(randomUUID(),'before@example.com');await expect(manage('approve',duplicate,'new-reference')).rejects.toMatchObject({code:'eligibility-conflict'});
    expect(JSON.stringify((await db.query('SELECT * FROM free_eligibilities')).rows)).not.toContain('@');
  });
  it('deletion/recreation/rebind preserves the personal month claim and permits only the following month',async()=>{
    const first=await owner(randomUUID(),'recreated@example.com');await manage('approve',first);await service(first).claim(undefined,{});
    await db.query("UPDATE accounts SET status='deleted',email='',firebase_uid=$2 WHERE id=$1",[first.id,'deleted:'+first.id]);
    const secondOwner=await owner(randomUUID(),'recreated@example.com');await expect(manage('approve',secondOwner,'new-reference')).rejects.toMatchObject({code:'eligibility-conflict'});
    await approveTrial(db,secondOwner.id,'legacy-recreated-preview',now,randomUUID);expect((await ledger.balance(secondOwner.id)).availableCredits).toBe(0);
    await manage('rebind',secondOwner);expect((await service(secondOwner).status(secondOwner.id)).status).toBe('claimed');expect((await ledger.balance(secondOwner.id)).availableCredits).toBe(0);
    await expect(service(secondOwner).claim(undefined,{})).rejects.toMatchObject({code:'free-allowance-already-claimed'});
    clock=new Date('2026-11-01T00:00:00Z');await service(secondOwner).claim(undefined,{});
    expect((await ledger.balance(secondOwner.id)).availableCredits).toBe(6_666_666);expect((await db.query("SELECT * FROM credit_grants WHERE source LIKE 'free-month:%'")).rows).toHaveLength(2);
  });
  it('funds at most ten distinct people per month under the $50 pool even after revoke',async()=>{
    const owners=await Promise.all(Array.from({length:11},()=>owner()));for(const [index,account] of owners.entries())await manage('approve',account,'person-'+index);
    const attempts=await Promise.allSettled(owners.map(account=>service(account).claim(undefined,{})));
    expect(attempts.filter(row=>row.status==='fulfilled')).toHaveLength(10);expect(attempts.filter(row=>row.status==='rejected')).toHaveLength(1);
    const funded=attempts.findIndex(row=>row.status==='fulfilled'),unfunded=attempts.findIndex(row=>row.status==='rejected');await manage('revoke',owners[funded]!,'person-'+funded);
    await expect(service(owners[unfunded]!).claim(undefined,{})).rejects.toMatchObject({code:'free-allowance-unavailable'});
    expect((await db.query("SELECT count(*) AS n FROM credit_grants WHERE source LIKE 'free-month:%'")).rows[0]!.n).toBe('10');
    clock=new Date('2026-11-01T00:00:00Z');await service(owners[unfunded]!).claim(undefined,{});
  });
  it('month rollover expires old usage, concurrent next-month claims remain one, and paused stage cannot fund claims',async()=>{
    const account=await owner();await manage('approve',account);clock=new Date('2026-10-31T23:59:59.999Z');await service(account).claim(undefined,{});
    const request=await prepare(account);await holds.reserve(account.id,request.id,1000);clock=new Date('2026-11-01T00:00:00Z');
    await expect(holds.dispatch(account.id,request.id)).rejects.toMatchObject({code:'free-allowance-revoked'});await holds.release(account.id,request.id);
    expect((await ledger.balance(account.id)).availableCredits).toBe(0);
    const claims=await Promise.all(Array.from({length:24},()=>service(account).claim(undefined,{})));expect(claims.filter(row=>!row.replay)).toHaveLength(1);
    const periods=(await db.query('SELECT starts_at,expires_at FROM credit_grants ORDER BY starts_at')).rows;expect(periods[0]!.expires_at).toEqual(periods[1]!.starts_at);
    const other=await owner();await manage('approve',other,'other-person');await db.query('UPDATE ai_limits SET enabled=false,free_daily_micros=0,free_monthly_micros=0');
    await expect(service(other).claim(undefined,{})).rejects.toMatchObject({code:'free-allowance-unavailable'});
  });
  it('the free supplier month limit includes earlier days and current holds while leaving paid admission independent',async()=>{
    const free=await Promise.all(Array.from({length:3},()=>owner()));
    for(const [index,account] of free.entries()){await manage('approve',account,'budget-person-'+index);await service(account).claim(undefined,{});}
    const spent=await prepare(free[0]!);await holds.reserve(free[0]!.id,spent.id,1000);await holds.dispatch(free[0]!.id,spent.id);
    await holds.settle(free[0]!.id,spent.id,{input:1000,cacheRead:0,output:1000}); // $0.00525 on the previous UTC day.
    clock=new Date('2026-10-16T12:00:00Z');await db.query('UPDATE ai_limits SET free_monthly_micros=11000');
    const held=await prepare(free[1]!);await holds.reserve(free[1]!.id,held.id,1000); // Another $0.00525 held.
    const denied=await prepare(free[2]!);await expect(holds.reserve(free[2]!.id,denied.id,1000)).rejects.toMatchObject({code:'spend-limit'});await holds.release(free[2]!.id,denied.id);
    const paid=await owner();await ledger.grant({accountId:paid.id,source:'paid-independent-budget',plan:'plus',startsAt:clock,expiresAt:new Date('2026-11-16T12:00:00Z')});
    const paidRequest=await prepare(paid);await holds.reserve(paid.id,paidRequest.id,1000);await holds.release(paid.id,paidRequest.id);await holds.release(free[1]!.id,held.id);
    const unfunded=await owner();await manage('approve',unfunded,'zero-month-budget');await db.query('UPDATE ai_limits SET free_monthly_micros=0');
    await expect(service(unfunded).claim(undefined,{})).rejects.toMatchObject({code:'free-allowance-unavailable'});
  });
  it('account exports include only owned eligibility records; deletion retains pseudonymous anti-regrant history',async()=>{
    const account=await owner(randomUUID(),'privacy-owner@example.com'),other=await owner();await manage('approve',account);await manage('approve',other,'other-person');await service(account).claim(undefined,{});
    let exported='';const removed:string[]=[];
    const privacy=accountPrivacy({db,account:async()=>account,recentIdentity:async()=>({uid:(await db.query('SELECT firebase_uid FROM accounts WHERE id=$1',[account.id])).rows[0]!.firebase_uid as string,email:account.email}),objects:{async write(_name,json){exported=json;},async url(){return 'https://example.invalid/private-export';},async remove(){}},identity:{async remove(uid){removed.push(uid)}},now,newId:randomUUID});
    await privacy.export(undefined,{});await privacy.recover();const data=JSON.parse(exported);expect(data.free_eligibilities).toHaveLength(1);expect(data.free_eligibilities[0].account_id).toBe(account.id);expect(exported).not.toContain(other.id);expect(data.free_eligibility_identities).toHaveLength(1);
    await privacy.delete(undefined,{confirm:'DELETE'});expect((await privacy.recover()).deleted).toBe(1);expect(removed).toHaveLength(1);
    const deleted=(await db.query('SELECT email,firebase_uid,status FROM accounts WHERE id=$1',[account.id])).rows[0];expect(deleted).toEqual({email:'',firebase_uid:'deleted:'+account.id,status:'deleted'});
    expect((await db.query('SELECT * FROM free_eligibilities WHERE account_id=$1',[account.id])).rows).toHaveLength(1);expect((await db.query('SELECT * FROM credit_grants WHERE account_id=$1',[account.id])).rows).toHaveLength(1);
    expect((await service(account).status(account.id)).status).toBe('review-required');
  });
  it('runtime roles can read eligibility but cannot approve, rebind, revoke or erase retained fingerprints',async()=>{
    const role=`monthly_runtime_${suffix}`;await admin.query(`CREATE ROLE ${role}`);
    const policy=await readFile(new URL('../../../infra/google/sql-runtime-grants.sql',import.meta.url),'utf8');
    const grant=policy.split('\n').find(line=>line.startsWith('GRANT SELECT ON free_eligibilities'))!;
    await db.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);await db.query(grant.replace('femlab_api, femlab_jobs',role));
    const client=await db.connect();try{
      await client.query(`SET ROLE ${role}`);await client.query('SELECT * FROM free_eligibilities');
      for(const sql of ["UPDATE free_eligibilities SET state='approved'","DELETE FROM free_eligibility_identities",'INSERT INTO free_eligibilities DEFAULT VALUES'])await expect(client.query(sql)).rejects.toMatchObject({code:'42501'});
    }finally{await client.query('RESET ROLE');client.release();await db.query(`DROP OWNED BY ${role}`);await admin.query(`DROP ROLE ${role}`);}
  });
});
