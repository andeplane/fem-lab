import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {readFile,readdir,rm} from 'node:fs/promises';
import {build} from 'esbuild';
import pg from 'pg';
import {beforeAll,beforeEach,afterAll,describe,it,expect,onTestFinished} from 'vitest';
import {postgresAccounts} from '../src/accounts';
import {creditLedger,debitAdjustment,type DebitAdjustment} from '../src/ledger';
import {suspendAccount,type SuspensionIdentity} from '../src/administration';
import {identityVerifier,type IdentityAdmin} from '../src/identity';
import {reservations} from '../src/reservations';
import {migrate} from '../src/migrations';

const run=promisify(execFile);
describe.skipIf(!process.env.TEST_DATABASE_URL)('operator actions on real Postgres',()=>{
 const schema='administration_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
 const db=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`,max:16});
 const independent=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`,max:4});
 let clock=new Date('2026-11-05T12:00:00Z');const now=()=>clock,accounts=postgresAccounts(db,now,randomUUID),ledger=creditLedger(db,now,randomUUID);
 const actorRef='a'.repeat(64);
 const cliFile=fileURLToPath(new URL('../dist/operator-cli-'+randomUUID()+'.mjs',import.meta.url));
 async function fixture(){
  const owner=await accounts.provision({uid:randomUUID(),email:'operator-fixture@example.invalid'});
  await ledger.grant({accountId:owner.id,source:randomUUID(),plan:'plus',startsAt:new Date('2026-11-01T00:00:00Z'),expiresAt:new Date('2026-12-01T00:00:00Z')});
  const grant=(await db.query('SELECT * FROM credit_grants WHERE account_id=$1',[owner.id])).rows[0];
  return {owner,grant,input:{accountId:owner.id,grantId:String(grant.id),idempotencyId:randomUUID(),actorRef,reasonRef:'case-556',subcredits:'100'} satisfies DebitAdjustment};
 }
 beforeAll(async()=>{
  await admin.query(`CREATE SCHEMA ${schema}`);const directory=new URL('../migrations/',import.meta.url);
  const migrations=await Promise.all((await readdir(directory)).filter(n=>n.endsWith('.sql')).sort().map(async name=>({name,sql:await readFile(new URL(name,directory),'utf8')})));
  const connection=await db.connect();try{await migrate(connection,migrations);}finally{connection.release();}
  await build({entryPoints:[fileURLToPath(new URL('../tools/manage-operator.ts',import.meta.url))],outfile:cliFile,bundle:true,platform:'node',format:'esm',target:'node22',external:['pg','firebase-admin/*']});
 });
 beforeEach(async()=>{await db.query('TRUNCATE accounts CASCADE');clock=new Date('2026-11-05T12:00:00Z');await db.query('UPDATE ai_limits SET enabled=true,daily_micros=100000000,monthly_micros=1000000000,uncertain_micros=10000000,concurrent=16');});
 afterAll(async()=>{await db.end();await independent.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await rm(cliFile,{force:true});});
 it('appends one immutable audited debit across independent concurrent retries',async()=>{
  const {input,grant}=await fixture();const original=(await db.query('SELECT * FROM credit_grants')).rows;
  const settled=await Promise.allSettled(Array.from({length:12},(_,i)=>debitAdjustment(i%2?db:independent,input,now)));
  expect(settled.every(x=>x.status==='fulfilled')).toBe(true);
  const results=settled.flatMap(x=>x.status==='fulfilled'?[x.value]:[]);
  expect(results.filter(x=>!x.replay)).toHaveLength(1);expect(results.every(x=>x.id===input.idempotencyId&&x.debitedSubcredits==='100')).toBe(true);
  const rows=(await db.query('SELECT * FROM credit_entries')).rows;expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({id:input.idempotencyId,account_id:input.accountId,grant_id:grant.id,amount:'-100',kind:'adjustment',source:`operator-adjustment:v1:${actorRef}:case-556:${input.idempotencyId}`});
  expect((await db.query('SELECT * FROM credit_grants')).rows).toEqual(original);
  expect((await db.query('SELECT * FROM usage_receipts')).rows).toHaveLength(0);
  await expect(db.query('UPDATE credit_entries SET amount=-1 WHERE id=$1',[input.idempotencyId])).rejects.toThrow('immutable');
  clock=new Date('2027-01-01T00:00:00Z');expect(await debitAdjustment(db,input,now)).toMatchObject({replay:true,createdAt:'2026-11-05T12:00:00.000Z'});
 });
 it('rejects every changed field under the same operation UUID without another debit',async()=>{
  const {input}=await fixture(),other=await fixture();await debitAdjustment(db,input,now);
  for(const change of [{actorRef:'b'.repeat(64)},{reasonRef:'different-case'},{subcredits:'101'},{accountId:other.owner.id},{grantId:other.input.grantId}])
   await expect(debitAdjustment(db,{...input,...change},now)).rejects.toMatchObject({code:'adjustment-conflict'});
  expect((await db.query('SELECT count(*)::int AS n FROM credit_entries')).rows[0].n).toBe(1);
 });
 it('validates UUIDs, actor/reason references and exact positive bigint amounts',async()=>{
  const {input}=await fixture();for(const change of [{accountId:'invalid'},{grantId:'invalid'},{idempotencyId:'invalid'},{actorRef:'claimed-user'},{reasonRef:'contains private text'},...['0','-1','1.5','1e3','01','+1','9223372036854775808'].map(subcredits=>({subcredits}))])
   await expect(debitAdjustment(db,{...input,...change},now)).rejects.toMatchObject({code:'invalid-adjustment'});
  expect((await db.query('SELECT * FROM credit_entries')).rows).toHaveLength(0);
 });
 it('preserves exact arithmetic above the JavaScript safe-integer boundary',async()=>{
  const {owner}=await fixture(),grantId=randomUUID();
  await db.query(`INSERT INTO credit_grants(id,account_id,source,plan,tariff_version,amount,starts_at,expires_at,created_at) VALUES($1,$2,$3,'plus','2026-10-14.v1','9007199254740995',$4,$5,$4)`,[grantId,owner.id,randomUUID(),clock,new Date('2026-12-01T00:00:00Z')]);
  const input={accountId:owner.id,grantId,idempotencyId:randomUUID(),actorRef,reasonRef:'exact-integer',subcredits:'9007199254740993'};
  expect(await debitAdjustment(db,input,now)).toMatchObject({debitedSubcredits:'9007199254740993'});
  expect((await db.query('SELECT amount::text FROM credit_entries WHERE id=$1',[input.idempotencyId])).rows[0].amount).toBe('-9007199254740993');
  await expect(debitAdjustment(db,{...input,idempotencyId:randomUUID(),subcredits:'3'},now)).rejects.toMatchObject({code:'adjustment-exceeds-available'});
  expect(await debitAdjustment(db,{...input,idempotencyId:randomUUID(),subcredits:'2'},now)).toMatchObject({debitedSubcredits:'2'});
  await expect(debitAdjustment(db,{...input,idempotencyId:randomUUID(),subcredits:'1'},now)).rejects.toMatchObject({code:'adjustment-exceeds-available'});
 });
 it('rejects unavailable accounts, foreign, expired and future grants',async()=>{
  const {input}=await fixture(),other=await fixture();
  await expect(debitAdjustment(db,{...input,accountId:randomUUID()},now)).rejects.toMatchObject({code:'adjustment-account-unavailable'});
  await expect(debitAdjustment(db,{...input,accountId:other.owner.id},now)).rejects.toMatchObject({code:'adjustment-grant-unavailable'});
  clock=new Date('2026-10-01T00:00:00Z');await expect(debitAdjustment(db,input,now)).rejects.toMatchObject({code:'adjustment-grant-unavailable'});
  clock=new Date('2026-12-01T00:00:00Z');await expect(debitAdjustment(db,input,now)).rejects.toMatchObject({code:'adjustment-grant-unavailable'});
  clock=new Date('2026-11-05T12:00:00Z');await db.query("UPDATE accounts SET status='deleting' WHERE id=$1",[input.accountId]);
  await expect(debitAdjustment(db,input,now)).rejects.toMatchObject({code:'adjustment-account-unavailable'});
 });
 it('protects reserved, dispatched and uncertain allocations from administrative debits',async()=>{
  for(const state of ['reserved','dispatched','pending_reconciliation']){
   const {input,grant}=await fixture(),holds=reservations(db,now,randomUUID);
   const request=await holds.prepare({accountId:input.accountId,key:randomUUID(),digest:'a'.repeat(64),turnId:'operator-case',round:0,model:'gpt-5.4-mini',maxOutput:10});
   await holds.reserve(input.accountId,request.id,100);
   if(state!=='reserved')await holds.dispatch(input.accountId,request.id);
   if(state==='pending_reconciliation')await holds.pending(input.accountId,request.id);
   const held=BigInt(String((await db.query('SELECT held_subcredits FROM ai_requests WHERE id=$1',[request.id])).rows[0].held_subcredits));expect(held>0n).toBe(true);
   await debitAdjustment(db,{...input,subcredits:(BigInt(String(grant.amount))-held).toString()},now);
   await expect(debitAdjustment(db,{...input,idempotencyId:randomUUID(),subcredits:'1'},now)).rejects.toMatchObject({code:'adjustment-exceeds-available'});
   expect((await db.query('SELECT amount::text FROM credit_holds WHERE request_id=$1',[request.id])).rows[0].amount).toBe(held.toString());
   if(state==='reserved')await holds.release(input.accountId,request.id);else await holds.settle(input.accountId,request.id,{input:100,cacheRead:0,output:1});
   const value=(await db.query('SELECT g.amount+COALESCE(sum(e.amount),0) AS remaining FROM credit_grants g LEFT JOIN credit_entries e ON e.grant_id=g.id WHERE g.id=$1 GROUP BY g.id',[grant.id])).rows[0].remaining;
   expect(BigInt(String(value))>=0n).toBe(true);
  }
 });
 it('serializes a full-grant debit against a separate-instance reservation',async()=>{
  const {input,grant}=await fixture(),holds=reservations(independent,now,randomUUID);
  const request=await holds.prepare({accountId:input.accountId,key:'race',digest:'a'.repeat(64),turnId:'race',round:0,model:'gpt-5.4-mini',maxOutput:10});
  const results=await Promise.allSettled([debitAdjustment(db,{...input,subcredits:String(grant.amount)},now),holds.reserve(input.accountId,request.id,100)]);
  expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);
  const spent=BigInt(String((await db.query('SELECT COALESCE(sum(-amount),0) AS n FROM credit_entries')).rows[0].n));
  const held=BigInt(String((await db.query('SELECT COALESCE(sum(amount),0) AS n FROM credit_holds')).rows[0].n));expect(spent+held<=BigInt(String(grant.amount))).toBe(true);
 });
 it('prevents concurrent distinct corrections from overspending a grant',async()=>{
  const {input,grant}=await fixture(),amount=(BigInt(String(grant.amount))*2n/3n).toString();
  const results=await Promise.allSettled(Array.from({length:4},(_,i)=>debitAdjustment(i%2?db:independent,{...input,idempotencyId:randomUUID(),subcredits:amount},now)));
  expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);
 });
 it('disables identity then revokes sessions and existing verification fails closed',async()=>{
  const {owner}=await fixture();let disabled=false;const calls:string[]=[];
  const identity:SuspensionIdentity&IdentityAdmin={async updateUser(uid,properties){expect(uid).toBe((await db.query('SELECT firebase_uid FROM accounts WHERE id=$1',[owner.id])).rows[0].firebase_uid);expect(properties).toEqual({disabled:true});disabled=true;calls.push('disable');},async revokeRefreshTokens(){calls.push('revoke');},async verifyIdToken(_token,checkRevoked){expect(checkRevoked).toBe(true);if(disabled)throw new Error('auth/user-disabled');return {uid:'uid',email:'fixture@example.invalid',email_verified:true,aud:'femlab-app-staging',iss:'https://securetoken.google.com/femlab-app-staging',exp:clock.getTime()/1000+60,auth_time:clock.getTime()/1000};}};
  const verify=identityVerifier(identity,'femlab-app-staging',now);await verify('Bearer existing-token');
  expect(await suspendAccount(db,identity,owner.id)).toMatchObject({disabled:true,sessionsRevoked:true});expect(calls).toEqual(['disable','revoke']);
  await expect(verify('Bearer existing-token')).rejects.toMatchObject({code:'invalid-identity'});
  expect((await db.query('SELECT status FROM accounts WHERE id=$1',[owner.id])).rows[0].status).toBe('active');
 });
 it('reports partial revocation without re-enabling identity and safely retries',async()=>{
  const {owner}=await fixture();let fail=true,disabled=false;const identity:SuspensionIdentity={async updateUser(){disabled=true;},async revokeRefreshTokens(){if(fail)throw new Error('private SDK token');}};
  await expect(suspendAccount(db,identity,owner.id)).rejects.toMatchObject({code:'suspension-incomplete',details:{disabled:true}});expect(disabled).toBe(true);
  fail=false;expect(await suspendAccount(db,identity,owner.id)).toMatchObject({disabled:true,sessionsRevoked:true});
 });
 it('does not revoke after failed disable or touch identity for invalid/inactive targets',async()=>{
  const {owner}=await fixture();let revoked=0;const identity:SuspensionIdentity={async updateUser(){throw new Error('private SDK value');},async revokeRefreshTokens(){revoked++;}};
  await expect(suspendAccount(db,identity,owner.id)).rejects.toMatchObject({code:'suspension-incomplete',details:{disableConfirmed:false}});expect(revoked).toBe(0);
  await expect(suspendAccount(db,identity,'invalid')).rejects.toMatchObject({code:'invalid-account'});
  await db.query("UPDATE accounts SET status='deleted' WHERE id=$1",[owner.id]);await expect(suspendAccount(db,identity,owner.id)).rejects.toMatchObject({code:'suspension-account-unavailable'});
 });
 it('compiled operator CLI executes and replays the same audited debit without exposing environment credentials',async()=>{
  const {input}=await fixture(),url=new URL(process.env.TEST_DATABASE_URL!);
  const env={...process.env,PGHOST:url.hostname,PGPORT:url.port,PGDATABASE:url.pathname.slice(1),PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),PGOPTIONS:`-c search_path=${schema}`,FEMLAB_OPERATOR_ACTOR_REF:actorRef,FEMLAB_OPERATOR_ACCESS_TOKEN:'private-test-value'};
  const argv=[cliFile,'debit',input.accountId,input.idempotencyId.toUpperCase(),input.reasonRef,input.grantId,input.subcredits];
  const controller=new AbortController(),pending:Promise<unknown>[]=[];
  onTestFinished(async()=>{controller.abort();await Promise.allSettled(pending);});
  const options={cwd:fileURLToPath(new URL('../../../',import.meta.url)),env,timeout:2000,signal:controller.signal};
  const invoke=(args:string[])=>{const promise=run(process.execPath,args,options);pending.push(promise);return promise;};
  const first=JSON.parse((await invoke(argv)).stdout);expect(first.operationId).toBe(input.idempotencyId);expect(first.result).toMatchObject({id:input.idempotencyId,replay:false,debitedSubcredits:'100'});
  expect(JSON.parse((await invoke(argv)).stdout).result.replay).toBe(true);
  const failure=await invoke([...argv.slice(0,-1),'0']).then(()=>'',error=>String(error.stdout));
  expect(JSON.parse(failure).code).toBe('invalid-adjustment');expect(failure).not.toContain('private-test-value');
 });
});
