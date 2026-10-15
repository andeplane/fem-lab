import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {postgresAccounts} from '../src/accounts';
import {billingLifecycle,type BillingEnvelope,type BillingGateway,type BillingInvoice,type BillingSubscription} from '../src/billing';
import type {PurchaseUse} from '../src/billing-prices';
import {checkoutService,type CheckoutConfig,type Payments,type PaymentSession,type PaymentSubscription} from '../src/checkout';
import {creditLedger} from '../src/ledger';
import {migrate} from '../src/migrations';

type CheckoutRequest=Parameters<Payments['checkout']>[0];
type ScheduleRequest={subscription:PaymentSubscription;price:string;key:string};
const periodEnd=new Date('2026-11-15T12:00:00Z');
function fixture():CheckoutConfig {
  return {enabled:true,live:false,merchantMode:'managed',taxMode:'automatic',projectId:'femlab-test',appOrigin:'https://femlab.app',
    prices:{plus:'price_plus',pro:'price_pro',studio:'price_studio'},purchasePrices:{
      plus:{personal:'price_plus_personal',business:'price_plus_business'},
      pro:{personal:'price_pro_personal',business:'price_pro_business'},
      studio:{personal:'price_studio_personal',business:'price_studio_business'},
    }};
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('purchase-use authority and frozen payment requests on Postgres',()=>{
  const schema=`purchase_${randomUUID().replaceAll('-','')}`;
  const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
  const db=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`,max:6});
  let clock=new Date('2026-10-15T12:00:00Z'),accountId='',loseCheckoutResponse=false,failSchedule=false;
  const now=()=>new Date(clock),accounts=postgresAccounts(db,now,randomUUID),ledger=creditLedger(db,now,randomUUID);
  const checkoutCalls:CheckoutRequest[]=[],scheduleCalls:ScheduleRequest[]=[],priceCalls:string[]=[];
  const saved=new Map<string,PaymentSession>(),sessions=new Map<string,PaymentSession>(),amounts=new Map<string,number>();
  let subscriptions:PaymentSubscription[]=[],invoice:BillingInvoice,subscription:BillingSubscription;
  const payments:Payments={
    async customer(){return 'cus_owner';},
    async price(id){priceCalls.push(id);return {id,active:true,currency:'usd',amount:amounts.get(id)??null,interval:'month',intervalCount:1};},
    async subscriptions(customerId){return structuredClone(subscriptions.filter(row=>row.customerId===customerId));},
    async checkout(input){
      checkoutCalls.push(structuredClone(input));
      const previous=saved.get(input.key);if(previous)return structuredClone(previous);
      const id=`cs_purchase_${saved.size+1}`,session={id,url:`https://checkout.stripe.com/c/${id}`,expiresAt:input.expiresAt,status:'open'};
      saved.set(input.key,session);sessions.set(id,session);
      if(loseCheckoutResponse){loseCheckoutResponse=false;throw new Error('Response lost after Session creation');}
      return structuredClone(session);
    },
    async session(id){return structuredClone(sessions.get(id)!);},
    async portal(){return 'https://billing.stripe.com/p/session/fixture';},
    async schedule(current,price,key){scheduleCalls.push({subscription:structuredClone(current),price,key});if(failSchedule)throw new Error('Schedule response lost');return 'sub_sched_purchase';},
  };
  const owner=async()=>accounts.provision({uid:'owner',email:'owner@example.com'});
  const checkout=(config=fixture())=>checkoutService(db,payments,config,owner,now,randomUUID);
  const gateway:BillingGateway={
    verify(body,signature){if(signature!=='fixture')throw new Error('Invalid fixture signature');return JSON.parse(new TextDecoder().decode(body)) as BillingEnvelope;},
    async invoice(){return structuredClone(invoice);},async subscription(){return structuredClone(subscription);},async chargeCustomer(){return 'cus_owner';},
  };
  const billing=billingLifecycle(db,gateway,fixture(),now,randomUUID);
  const deliver=(id='evt_purchase',objectId=invoice.id)=>billing.receive(new TextEncoder().encode(JSON.stringify({id,type:'invoice.paid',objectId,customerId:'cus_owner',live:false})),'fixture');
  async function customerMapping(){await db.query('INSERT INTO billing_accounts(account_id,customer_id,updated_at) VALUES($1,$2,$3)',[accountId,'cus_owner',now()]);}
  async function currentSubscription(use:PurchaseUse|null){
    await customerMapping();
    subscriptions=[{id:'sub_purchase',customerId:'cus_owner',status:'active',priceId:use?`price_plus_${use}`:'price_plus',start:clock.getTime()/1000,end:periodEnd.getTime()/1000,scheduleId:null}];
  }
  async function uncertainCheckout(){
    loseCheckoutResponse=true;
    await expect(checkout().checkout('Bearer owner',{plan:'plus',purchaseUse:'personal'})).rejects.toThrow('Response lost');
    return (await db.query('SELECT * FROM checkout_intents')).rows[0]!;
  }
  beforeAll(async()=>{
    await admin.query(`CREATE SCHEMA ${schema}`);
    const directory=new URL('../migrations/',import.meta.url);
    const migrations=await Promise.all((await readdir(directory)).filter(name=>name.endsWith('.sql')).sort().map(async name=>({name,sql:await readFile(new URL(name,directory),'utf8')})));
    const connection=await db.connect();try{await migrate(connection,migrations);}finally{connection.release();}
  });
  beforeEach(async()=>{
    await db.query('TRUNCATE accounts CASCADE');await db.query('TRUNCATE billing_inbox CASCADE');await db.query('TRUNCATE billing_leases');
    clock=new Date('2026-10-15T12:00:00Z');accountId=(await owner()).id;
    checkoutCalls.length=0;scheduleCalls.length=0;priceCalls.length=0;saved.clear();sessions.clear();amounts.clear();subscriptions=[];loseCheckoutResponse=false;failSchedule=false;
    for(const [tier,amount] of [['plus',4900],['pro',14900],['studio',49900]] as const)for(const suffix of ['','_personal','_business'])amounts.set(`price_${tier}${suffix}`,amount);
    const start=clock.getTime()/1000,end=periodEnd.getTime()/1000;
    invoice={id:'in_purchase',customerId:'cus_owner',subscriptionId:'sub_purchase',status:'paid',currency:'usd',reason:'subscription_create',amountPaid:4900,lines:[{priceId:'price_plus_personal',quantity:1,proration:false,start,end}]};
    subscription={id:'sub_purchase',customerId:'cus_owner',status:'active',cancelAtPeriodEnd:false,periodEnd:end};
  });
  afterAll(async()=>{await db.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});

  it.each([
    [{plan:'plus'},'purchase-use-required'],[{plan:'plus',purchaseUse:'commercial'},'invalid-plan'],
    [{plan:'plus',purchaseUse:null},'invalid-plan'],[{plan:'plus',purchaseUse:{personal:true}},'invalid-plan'],
  ])('requires a supported managed purchase use for %j',async(body,code)=>{
    await expect(checkout().checkout('Bearer owner',body)).rejects.toMatchObject({status:422,code});
    expect(priceCalls).toEqual([]);expect(checkoutCalls).toEqual([]);
    expect((await db.query('SELECT * FROM checkout_intents')).rows).toHaveLength(0);
  });

  it.each(['personal','business'] as const)('selects and freezes the exact %s price without granting credits',async use=>{
    const service=checkout();await service.checkout('Bearer owner',{plan:'plus',purchaseUse:use});
    expect(checkoutCalls[0]).toMatchObject({price:`price_plus_${use}`,customer:'cus_owner',successUrl:'https://femlab.app/?billing=success',cancelUrl:'https://femlab.app/?billing=canceled'});
    const intent=(await db.query('SELECT * FROM checkout_intents')).rows[0]!;
    expect(intent).toMatchObject({request_version:1,price_id:`price_plus_${use}`,purchase_use:use,merchant_mode:'managed',tax_mode:'automatic',return_origin:'https://femlab.app/',customer_id:'cus_owner',project_id:'femlab-test'});
    expect(intent.expires_at).toEqual(new Date(checkoutCalls[0]!.expiresAt*1000));
    await expect(service.checkout('Bearer owner',{plan:'plus',purchaseUse:use==='personal'?'business':'personal'})).rejects.toMatchObject({code:'checkout-open',message:expect.stringContaining((intent.expires_at as Date).toISOString())});
    expect(checkoutCalls).toHaveLength(1);expect((await db.query('SELECT * FROM credit_grants')).rows).toHaveLength(0);
  });

  it('does not fall back to a legacy price when the selected managed alias is absent',async()=>{
    const config=fixture();delete config.purchasePrices!.plus!.personal;
    await expect(checkout(config).checkout('Bearer owner',{plan:'plus',purchaseUse:'personal'})).rejects.toMatchObject({code:'price-unavailable'});
    expect(priceCalls).toEqual([]);expect(checkoutCalls).toEqual([]);
  });

  it('replays a lost response with its original personal price, key and expiry',async()=>{
    const original=await uncertainCheckout();clock=new Date(clock.getTime()+180000);
    await checkout().checkout('Bearer owner',{plan:'plus',purchaseUse:'personal'});
    expect(checkoutCalls).toHaveLength(2);expect(checkoutCalls[1]).toEqual(checkoutCalls[0]);expect(saved.size).toBe(1);
    const current=(await db.query('SELECT * FROM checkout_intents')).rows[0]!;
    expect(current.id).toBe(original.id);expect(current.expires_at).toEqual(original.expires_at);expect(current.session_id).toBe('cs_purchase_1');
  });

  it.each(['price','purchase use','merchant mode','tax mode','return origin','customer','project','plan'])('refuses a changed %s after an uncertain Session response',async change=>{
    const original=await uncertainCheckout(),config=fixture();let plan='plus',purchaseUse='personal';
    if(change==='price'){config.purchasePrices!.plus!.personal='price_plus_personal_rotated';amounts.set('price_plus_personal_rotated',4900);}
    if(change==='purchase use')purchaseUse='business';
    if(change==='merchant mode')config.merchantMode='direct';
    if(change==='tax mode')config.taxMode='not_collecting';
    if(change==='return origin')config.appOrigin='https://staging.example.test';
    if(change==='customer')await db.query("UPDATE billing_accounts SET customer_id='cus_replaced'");
    if(change==='project')config.projectId='different-project';
    if(change==='plan')plan='pro';
    await expect(checkout(config).checkout('Bearer owner',{plan,purchaseUse})).rejects.toMatchObject({status:409,code:'checkout-open',message:expect.stringContaining((original.expires_at as Date).toISOString())});
    expect(checkoutCalls).toHaveLength(1);expect(saved.size).toBe(1);
    expect((await db.query('SELECT * FROM checkout_intents')).rows[0]).toEqual(original);
  });

  it.each(['request_version','price_id','purchase_use','merchant_mode','tax_mode','return_origin','customer_id','project_id'])('refuses a missing frozen %s instead of filling it from current configuration',async column=>{
    const original=await uncertainCheckout();
    await db.query(`UPDATE checkout_intents SET ${column}=NULL`);
    const before=(await db.query('SELECT * FROM checkout_intents')).rows[0]!;
    await expect(checkout().checkout('Bearer owner',{plan:'plus',purchaseUse:'personal'})).rejects.toMatchObject({status:409,code:'checkout-open',message:expect.stringContaining((original.expires_at as Date).toISOString())});
    expect(checkoutCalls).toHaveLength(1);expect((await db.query('SELECT * FROM checkout_intents')).rows[0]).toEqual(before);
  });

  it('leaves historical unversioned intents untouched and rejects another request version',async()=>{
    await customerMapping();const id=randomUUID(),expiry=new Date(clock.getTime()+1860000);
    await db.query('INSERT INTO checkout_intents(account_id,id,plan,expires_at,created_at) VALUES($1,$2,$3,$4,$5)',[accountId,id,'plus',expiry,clock]);
    await expect(checkout().checkout('Bearer owner',{plan:'plus',purchaseUse:'personal'})).rejects.toMatchObject({code:'checkout-open'});
    expect(checkoutCalls).toEqual([]);expect((await db.query('SELECT request_version,price_id FROM checkout_intents')).rows[0]).toEqual({request_version:null,price_id:null});
    await db.query('DELETE FROM checkout_intents');await uncertainCheckout();await db.query('UPDATE checkout_intents SET request_version=2');
    await expect(checkout().checkout('Bearer owner',{plan:'plus',purchaseUse:'personal'})).rejects.toMatchObject({code:'checkout-open'});
    expect(checkoutCalls).toHaveLength(1);
  });

  it('uses a fresh key for changed purchase settings only after the stored intent expires',async()=>{
    const original=await uncertainCheckout();clock=new Date((original.expires_at as Date).getTime()+1);
    await checkout().checkout('Bearer owner',{plan:'plus',purchaseUse:'business'});
    expect(checkoutCalls).toHaveLength(2);expect(checkoutCalls[1]!.key).not.toBe(checkoutCalls[0]!.key);
    expect(checkoutCalls[1]!.price).toBe('price_plus_business');expect(checkoutCalls[1]!.expiresAt).toBe(Math.floor((clock.getTime()+1860000)/1000));
    expect((await db.query('SELECT purchase_use FROM checkout_intents')).rows[0]!.purchase_use).toBe('business');
  });

  it.each(['personal','business',null] as const)('keeps %s use during a plan change and recovery, including legacy subscriptions',async use=>{
    await currentSubscription(use);failSchedule=true;
    await expect(checkout().change('Bearer owner',{plan:'pro'})).rejects.toThrow('Schedule response lost');
    const target=use?`price_pro_${use}`:'price_pro',pending=(await db.query('SELECT * FROM plan_changes')).rows[0]!;
    expect(pending).toMatchObject({request_version:1,plan:'pro',price_id:target,purchase_use:use,state:'pending'});
    expect(scheduleCalls[0]!.price).toBe(target);failSchedule=false;
    expect(await checkout().recover()).toEqual({processed:1,failed:0});expect(scheduleCalls).toHaveLength(2);expect(scheduleCalls[1]).toEqual(scheduleCalls[0]);
    expect((await db.query('SELECT state FROM plan_changes')).rows[0]!.state).toBe('complete');
    expect((await db.query('SELECT * FROM credit_grants')).rows).toHaveLength(0);
  });

  it('does not infer purchase use from an unknown subscription price or a client override',async()=>{
    await currentSubscription('personal');subscriptions[0]!.priceId='price_foreign';
    await expect(checkout().change('Bearer owner',{plan:'pro'})).rejects.toMatchObject({status:409,code:'subscription-use-unknown'});
    await expect(checkout().change('Bearer owner',{plan:'pro',purchaseUse:'business'})).rejects.toMatchObject({code:'invalid-plan'});
    expect(scheduleCalls).toEqual([]);
  });

  it.each(['target price','current use','missing version','new version'])('fails plan-change recovery closed after %s drift',async change=>{
    await currentSubscription('personal');failSchedule=true;
    await expect(checkout().change('Bearer owner',{plan:'pro'})).rejects.toThrow('Schedule response lost');failSchedule=false;
    const config=fixture();
    if(change==='target price'){config.purchasePrices!.pro!.personal='price_pro_personal_rotated';amounts.set('price_pro_personal_rotated',14900);}
    if(change==='current use')subscriptions[0]!.priceId='price_plus_business';
    if(change==='missing version')await db.query('UPDATE plan_changes SET request_version=NULL');
    if(change==='new version')await db.query('UPDATE plan_changes SET request_version=2');
    const before=(await db.query('SELECT * FROM plan_changes')).rows[0]!;
    expect(await checkout(config).recover()).toEqual({processed:0,failed:1});expect(scheduleCalls).toHaveLength(1);
    expect((await db.query('SELECT * FROM plan_changes')).rows[0]).toEqual(before);
    await expect(checkout(config).change('Bearer owner',{plan:'pro'})).rejects.toMatchObject({code:'plan-change-review'});
    expect(scheduleCalls).toHaveLength(1);
  });

  it.each([
    ['price_plus','plus',null,4000000],['price_pro','pro',null,16000000],['price_studio','studio',null,50000000],
    ['price_plus_personal','plus','personal',4000000],['price_plus_business','plus','business',4000000],
    ['price_pro_personal','pro','personal',16000000],['price_pro_business','pro','business',16000000],
    ['price_studio_personal','studio','personal',50000000],['price_studio_business','studio','business',50000000],
  ] as const)('grants %s its tier allowance exactly once and records purchase use',async(price,plan,use,credits)=>{
    await customerMapping();invoice.lines[0]!.priceId=price;invoice.amountPaid=plan==='plus'?4900:plan==='pro'?14900:49900;
    await deliver();invoice.id='in_duplicate';await deliver('evt_duplicate');
    expect((await ledger.balance(accountId)).availableCredits).toBe(credits);
    const rows=(await db.query('SELECT plan,purchase_use FROM paid_periods')).rows;
    expect(rows).toEqual([{plan,purchase_use:use}]);expect((await db.query("SELECT * FROM credit_grants WHERE plan<>'free'")).rows).toHaveLength(1);
  });

  it.each([['personal','business'],['business','personal'],[null,'personal'],['personal',null]] as const)('rejects a renewal changing purchase use from %s to %s',async(first,next)=>{
    await customerMapping();invoice.lines[0]!.priceId=first?`price_plus_${first}`:'price_plus';await deliver();
    clock=new Date(periodEnd);const start=clock.getTime()/1000,end=new Date('2026-12-15T12:00:00Z').getTime()/1000;
    invoice={...invoice,id:'in_renewal',reason:'subscription_cycle',lines:[{...invoice.lines[0]!,priceId:next?`price_plus_${next}`:'price_plus',start,end}]};subscription.periodEnd=end;
    await deliver('evt_renewal');expect((await db.query('SELECT * FROM paid_periods')).rows).toHaveLength(1);
    expect((await db.query("SELECT state FROM billing_inbox WHERE event_id='evt_renewal'")).rows[0]!.state).toBe('queued');
    expect((await ledger.balance(accountId)).availableCredits).toBe(0);
  });

  it.each(['personal','business',null] as const)('allows a new tier on renewal while preserving %s purchase use',async use=>{
    await customerMapping();invoice.lines[0]!.priceId=use?`price_plus_${use}`:'price_plus';await deliver();
    clock=new Date(periodEnd);const start=clock.getTime()/1000,end=new Date('2026-12-15T12:00:00Z').getTime()/1000;
    invoice={...invoice,id:'in_renewal',reason:'subscription_cycle',amountPaid:14900,lines:[{...invoice.lines[0]!,priceId:use?`price_pro_${use}`:'price_pro',start,end}]};subscription.periodEnd=end;
    await deliver('evt_renewal');expect((await ledger.balance(accountId)).availableCredits).toBe(16000000);
    expect((await db.query('SELECT plan,purchase_use FROM paid_periods ORDER BY period_start')).rows).toEqual([{plan:'plus',purchase_use:use},{plan:'pro',purchase_use:use}]);
  });

  it.each([{prices:['price_unknown']},{prices:['price_plus_personal','price_plus_business']},{prices:['price_plus_personal','price_unknown']}])('rejects unsupported canonical invoice lines $prices without an allowance',async({prices})=>{
    await customerMapping();invoice.lines=prices.map(priceId=>({...invoice.lines[0]!,priceId}));await deliver();
    expect((await db.query('SELECT * FROM paid_periods')).rows).toHaveLength(0);expect((await db.query('SELECT * FROM credit_grants')).rows).toHaveLength(0);
    expect((await db.query('SELECT state FROM billing_inbox')).rows[0]!.state).toBe('queued');
  });
});
