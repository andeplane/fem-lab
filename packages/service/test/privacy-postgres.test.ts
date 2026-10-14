import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {postgresAccounts} from '../src/accounts';
import {creditLedger} from '../src/ledger';
import {migrate} from '../src/migrations';
import {accountPrivacy} from '../src/privacy';
import {reservations} from '../src/reservations';
import {ServiceFailure} from '../src/errors';

describe.skipIf(!process.env.TEST_DATABASE_URL)('private exports and durable deletion on Postgres',()=>{
  const schema=`privacy_${randomUUID().replaceAll('-','')}`,admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
  const db=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`,max:16});
  let clock=new Date('2026-10-14T12:00:00Z'),recent=true,cancellationFails=false;
  const now=()=>clock,accounts=postgresAccounts(db,now,randomUUID),ledger=creditLedger(db,now,randomUUID);
  const owner=async(header:string|undefined)=>{if(!header?.startsWith('Bearer '))throw new ServiceFailure(401,'login-required','Sign in.','identity');return accounts.provision({uid:header.slice(7),email:`${header.slice(7)}@example.com`})};
  const objects={write:vi.fn(async()=>{}),url:vi.fn(async()=> 'https://storage.example.com/signed'),remove:vi.fn(async()=>{})},identity={remove:vi.fn(async()=>{})},order:string[]=[];
  const payments={stopRenewal:vi.fn(async()=>{order.push('cancel');if(cancellationFails)throw new Error('Vendor outage')})};
  const service=accountPrivacy({db,account:owner,recentIdentity:async h=>{if(!recent)throw new ServiceFailure(401,'recent-login-required','Sign in again.','identity');if(!h?.startsWith('Bearer '))throw new Error('Login required');return{uid:h.slice(7),email:h.slice(7)+'@example.com'}},objects,identity,payments,now,newId:randomUUID});
  beforeAll(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);const dir=new URL('../migrations/',import.meta.url);const migrations=await Promise.all((await readdir(dir)).filter(name=>name.endsWith('.sql')).sort().map(async name=>({name,sql:await readFile(new URL(name,dir),'utf8')})));const c=await db.connect();try{await migrate(c,migrations)}finally{c.release()}});
  beforeEach(async()=>{await db.query('TRUNCATE accounts CASCADE');await db.query('TRUNCATE billing_leases');clock=new Date('2026-10-14T12:00:00Z');recent=true;cancellationFails=false;vi.clearAllMocks();order.length=0;identity.remove.mockImplementation(async()=>{order.push('identity')})});
  afterAll(async()=>{await db.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end()});
  it('exports only the verified owner ledger and signs a URL for at most 15 minutes',async()=>{
    const a=await owner('Bearer a'),b=await owner('Bearer b');await ledger.ensureFree(a.id);await ledger.ensureFree(b.id);
    await expect(service.export('Bearer a',{accountId:b.id})).rejects.toMatchObject({code:'invalid-export'});
    expect(await service.export('Bearer a',{})).toEqual({status:'queued'});expect(await service.export('Bearer a',{})).toEqual({status:'queued'});
    expect((await service.recover()).exported).toBe(1);const call=objects.write.mock.calls[0] as unknown as [string,string,Date],data=JSON.parse(call[1]);expect(data.account.id).toBe(a.id);expect(JSON.stringify(data)).not.toContain('b@example.com');expect(data.credit_grants).toHaveLength(1);expect(data).not.toHaveProperty('prompts');
    expect(await service.export('Bearer a',{})).toEqual({status:'ready',url:'https://storage.example.com/signed'});expect((objects.url.mock.calls[0] as unknown as [string,Date])[1]).toEqual(new Date(clock.getTime()+900000));
    clock=new Date(clock.getTime()+86400001);expect((await service.recover()).expired).toBe(1);expect(objects.remove).toHaveBeenCalledWith(call[0]);
  });
  it('requires explicit confirmation and recent authentication before freezing an account',async()=>{
    const a=await owner('Bearer a');await expect(service.delete('Bearer a',{confirm:'DELETE',accountId:randomUUID()})).rejects.toMatchObject({code:'delete-confirmation-required'});recent=false;await expect(service.delete('Bearer a',{confirm:'DELETE'})).rejects.toMatchObject({code:'recent-login-required'});expect((await db.query('SELECT status FROM accounts WHERE id=$1',[a.id])).rows[0].status).toBe('active');
  });
  it('keeps the identity until renewal cancellation succeeds, then pseudonymizes without mutating grants',async()=>{
    const a=await owner('Bearer a');await ledger.ensureFree(a.id);await db.query('INSERT INTO billing_accounts(account_id,customer_id,updated_at) VALUES($1,$2,$3)',[a.id,'cus_a',now()]);
    expect(await service.delete('Bearer a',{confirm:'DELETE'})).toEqual({status:'queued'});await service.delete('Bearer a',{confirm:'DELETE'});expect((await db.query('SELECT * FROM account_deletions')).rows).toHaveLength(1);await expect(owner('Bearer a')).rejects.toMatchObject({code:'account-inactive'});
    cancellationFails=true;expect((await service.recover()).failed).toBe(1);expect(identity.remove).not.toHaveBeenCalled();expect((await db.query('SELECT state FROM account_deletions')).rows[0].state).toBe('queued');
    cancellationFails=false;expect((await service.recover()).deleted).toBe(1);expect(order).toEqual(['cancel','cancel','identity']);expect(payments.stopRenewal.mock.calls[0]).toEqual(payments.stopRenewal.mock.calls[1]);
    expect((await db.query('SELECT email,firebase_uid,status FROM accounts WHERE id=$1',[a.id])).rows[0]).toEqual({email:'',firebase_uid:`deleted:${a.id}`,status:'deleted'});expect((await db.query('SELECT * FROM credit_grants WHERE account_id=$1',[a.id])).rows).toHaveLength(1);expect((await service.recover()).deleted).toBe(0);
  });
  it('waits for accepted AI work and deletes a free account without requiring Stripe',async()=>{
    const a=await owner('Bearer a');await ledger.ensureFree(a.id);
    const holds=reservations(db,now,randomUUID),request=await holds.prepare({accountId:a.id,key:'privacy-pending',digest:'a'.repeat(64),turnId:'t',round:0,model:'gpt-5.4-mini',maxOutput:128});
    const free=accountPrivacy({db,account:owner,recentIdentity:async()=>({uid:'a',email:'a@example.com'}),objects,identity,now,newId:randomUUID});
    await free.delete('Bearer a',{confirm:'DELETE'});expect((await free.recover()).pending).toBe(1);expect(identity.remove).not.toHaveBeenCalled();expect(payments.stopRenewal).not.toHaveBeenCalled();
    await holds.release(a.id,request.id);expect((await free.recover()).deleted).toBe(1);expect(identity.remove).toHaveBeenCalledWith('a');
  });
  it('retains an uncertain checkout until its expiry and serializes deletion against active billing actions',async()=>{
    const a=await owner('Bearer a');await db.query('INSERT INTO billing_leases(customer_id,owner,expires_at) VALUES($1,$2,$3)',[`checkout:${a.id}`,randomUUID(),new Date(clock.getTime()+120000)]);await expect(service.delete('Bearer a',{confirm:'DELETE'})).rejects.toMatchObject({code:'account-operation-pending'});await db.query('DELETE FROM billing_leases');
    await db.query('INSERT INTO checkout_intents(id,account_id,plan,created_at,expires_at) VALUES($1,$2,$3,$4,$5)',[randomUUID(),a.id,'plus',now(),new Date(clock.getTime()+1800000)]);
    await service.delete('Bearer a',{confirm:'DELETE'});expect((await service.recover()).pending).toBe(1);expect(payments.stopRenewal).not.toHaveBeenCalled();expect(identity.remove).not.toHaveBeenCalled();clock=new Date(clock.getTime()+1800001);expect((await service.recover()).deleted).toBe(1);
  });
});
