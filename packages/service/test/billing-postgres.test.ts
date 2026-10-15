import { grantFreeFixture } from './free-fixture';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {postgresAccounts} from '../src/accounts';
import {creditLedger} from '../src/ledger';
import {migrate} from '../src/migrations';
import {billingLifecycle,type BillingGateway,type BillingInvoice,type BillingSubscription,type BillingEnvelope} from '../src/billing';

describe.skipIf(!process.env.TEST_DATABASE_URL)('durable payment lifecycle on Postgres',()=>{
  const schema=`billing_${randomUUID().replaceAll('-','')}`,admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
  const db=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`,max:16});
  let clock=new Date('2026-10-14T12:00:00Z'),accountId='',fail=false;
  const now=()=>clock,accounts=postgresAccounts(db,now,randomUUID),ledger=creditLedger(db,now,randomUUID);
  let invoice:BillingInvoice,subscription:BillingSubscription,chargeLookups:{id:string;kind:'charge'|'dispute'}[]=[];
  const gateway:BillingGateway={
    verify(body,signature){if(signature!=='fixture')throw new Error('private signature detail');return JSON.parse(new TextDecoder().decode(body)) as BillingEnvelope;},
    async invoice(){if(fail)throw new Error('private payment outage');return structuredClone(invoice);},
    async subscription(){return structuredClone(subscription);},async chargeCustomer(id,kind){chargeLookups.push({id,kind});return 'cus_owner';},
  };
  const billing=billingLifecycle(db,gateway,{live:false,prices:{plus:'price_plus',pro:'price_pro',studio:'price_studio'}},now,randomUUID);
  const envelope=(id='evt_one',type='invoice.paid',objectId='in_one'):BillingEnvelope=>({id,type,objectId,customerId:'cus_owner',live:false});
  const deliver=(event=envelope())=>billing.receive(new TextEncoder().encode(JSON.stringify(event)),'fixture');
  beforeAll(async()=>{
    await admin.query(`CREATE SCHEMA ${schema}`);
    const directory=new URL('../migrations/',import.meta.url);
    const migrations=await Promise.all((await readdir(directory)).filter(name=>name.endsWith('.sql')).sort().map(async name=>({name,sql:await readFile(new URL(name,directory),'utf8')})));
    const connection=await db.connect();try{await migrate(connection,migrations);}finally{connection.release();}
  });
  beforeEach(async()=>{
    await db.query('TRUNCATE accounts CASCADE');await db.query('TRUNCATE billing_inbox CASCADE');await db.query('TRUNCATE billing_leases');
    clock=new Date('2026-10-14T12:00:00Z');fail=false;chargeLookups=[];
    accountId=(await accounts.provision({uid:'owner',email:'owner@example.com'})).id;await grantFreeFixture(ledger, accountId, clock);
    await db.query('INSERT INTO billing_accounts(account_id,customer_id,updated_at) VALUES($1,$2,$3)',[accountId,'cus_owner',clock]);
    const start=clock.getTime()/1000,end=new Date('2026-11-14T12:00:00Z').getTime()/1000;
    invoice={id:'in_one',customerId:'cus_owner',subscriptionId:'sub_one',status:'paid',currency:'usd',reason:'subscription_create',amountPaid:4900,lines:[{priceId:'price_plus',quantity:1,proration:false,start,end}]};
    subscription={id:'sub_one',customerId:'cus_owner',status:'active',cancelAtPeriodEnd:false,periodEnd:end};
  });
  afterAll(async()=>{await db.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  it('concurrent duplicate event/invoice delivery grants the paid period once',async()=>{
    await Promise.all(Array.from({length:24},()=>deliver()));await deliver(envelope('evt_second','invoice.payment_succeeded'));
    expect((await ledger.balance(accountId)).availableCredits).toBe(4000000);
    expect((await db.query('SELECT * FROM paid_periods')).rows).toHaveLength(1);
    expect((await db.query("SELECT * FROM credit_grants WHERE plan='plus'")).rows).toHaveLength(1);
    expect((await db.query('SELECT * FROM billing_leases')).rows).toHaveLength(0);
    await expect(deliver({...envelope(),objectId:'in_changed'})).rejects.toMatchObject({code:'billing-event-conflict'});
  });
  it('uses canonical state for unordered events and preserves the already-paid cancellation period',async()=>{
    await deliver();subscription.status='canceled';subscription.cancelAtPeriodEnd=true;
    await deliver(envelope('evt_deleted','customer.subscription.deleted','sub_one'));
    await deliver(envelope('evt_late_created','customer.subscription.created','sub_one'));
    expect((await db.query('SELECT subscription_status FROM billing_accounts')).rows[0].subscription_status).toBe('canceled');
    expect((await ledger.balance(accountId)).plan).toBe('plus');
    clock=new Date('2026-11-14T12:00:00Z');await grantFreeFixture(ledger, accountId, clock);expect((await ledger.balance(accountId)).plan).toBe('free');
  });
  it('failed renewal and proration invoices cannot mint new allowances',async()=>{
    await deliver();invoice={...invoice,id:'in_failed',status:'open',reason:'subscription_cycle',amountPaid:0};subscription.status='past_due';
    await deliver(envelope('evt_failed','invoice.payment_failed','in_failed'));
    expect((await ledger.balance(accountId)).availableCredits).toBe(4000000);
    invoice={...invoice,status:'paid',reason:'subscription_update',amountPaid:1000,lines:invoice.lines.map(line=>({...line,proration:true}))};
    await deliver(envelope('evt_upgrade','invoice.paid','in_failed'));
    expect((await db.query('SELECT * FROM paid_periods')).rows).toHaveLength(1);
  });
  it('durably acknowledges an outage and retries without storing raw customer/payment data',async()=>{
    fail=true;expect(await deliver()).toEqual({received:true});
    const row=(await db.query('SELECT * FROM billing_inbox')).rows[0];expect(row.state).toBe('queued');expect(row.last_error).toBe('billing-processing-unavailable');
    expect(row).not.toHaveProperty('payload');expect(JSON.stringify(row)).not.toContain('private');
    fail=false;clock=new Date(clock.getTime()+60001);expect(await billing.recover()).toEqual({processed:1,failed:0});
    expect((await ledger.balance(accountId)).plan).toBe('plus');
  });
  it('refuses mismatched canonical customers, mode and signatures',async()=>{
    await expect(billing.receive(new Uint8Array(),'bad')).rejects.toMatchObject({code:'invalid-webhook'});
    await expect(deliver({...envelope(),live:true})).rejects.toMatchObject({code:'billing-mode-mismatch'});
    invoice.customerId='cus_other';await deliver();expect((await db.query('SELECT * FROM paid_periods')).rows).toHaveLength(0);
    expect((await ledger.balance(accountId)).plan).toBe('free');
  });
  it.each([
    {type:'charge.refunded',objectId:'ch_one',kind:'charge' as const},
    {type:'charge.dispute.created',objectId:'du_one',kind:'dispute' as const},
  ])('$type independently freezes paid access through canonical ownership and preserves consumed history',async({type,objectId,kind})=>{
    await deliver();const grant=(await db.query("SELECT id FROM credit_grants WHERE plan='plus'")).rows[0];
    await db.query("INSERT INTO credit_entries(id,account_id,grant_id,source,amount,kind,created_at) VALUES($1,$2,$3,'consumed','-300','usage',$4)",[randomUUID(),accountId,grant.id,clock]);
    await deliver({...envelope('evt_review',type,objectId),customerId:kind==='dispute'?null:'cus_owner'});
    expect(chargeLookups).toEqual([{id:objectId,kind}]);
    expect((await ledger.balance(accountId)).plan).toBe('free');expect((await db.query('SELECT * FROM billing_reviews')).rows).toHaveLength(1);
    expect((await db.query("SELECT amount FROM credit_entries WHERE source='consumed'")).rows[0].amount).toBe('-300');
  });
  it('rejects a second overlapping paid period even if it has another invoice ID',async()=>{
    await deliver();invoice={...invoice,id:'in_two',lines:invoice.lines.map(line=>({...line,start:line.start+86400,end:line.end+86400}))};
    await deliver(envelope('evt_overlap','invoice.paid','in_two'));
    expect((await db.query('SELECT * FROM paid_periods')).rows).toHaveLength(1);expect((await db.query("SELECT state FROM billing_inbox WHERE event_id='evt_overlap'")).rows[0].state).toBe('queued');
  });
});
