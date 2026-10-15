import { grantFreeFixture } from './free-fixture';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {postgresAccounts,type AccountResponse} from '../src/accounts';
import {creditLedger} from '../src/ledger';
import {migrate} from '../src/migrations';
import {CheckoutNotCreated,checkoutService,type Payments,type PaymentSubscription} from '../src/checkout';
import {ServiceFailure} from '../src/errors';
import {serviceServer} from '../src/http';

describe.skipIf(!process.env.TEST_DATABASE_URL)('account-owned checkout on real Postgres',()=>{
  const schema=`checkout_${randomUUID().replaceAll('-','')}`,admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
  const db=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`,max:16});
  let clock=new Date('2026-10-14T12:00:00Z');
  const now=()=>new Date(clock),accounts=postgresAccounts(db,now,randomUUID),ledger=creditLedger(db,now,randomUUID);
  let calls:{customer:number;checkout:number;portal:string[];schedule:string[];keys:string[]},customerId='cus_owner',redirect='https://checkout.stripe.com/c/fixture',currency='usd',subs:PaymentSubscription[]=[],scheduleFails=false;
  const sessions=new Map<string,{id:string;url:string|null;expiresAt:number;status:string|null}>();
  const paymentCalls:Parameters<Payments['checkout']>[0][]=[];
  const payments:Payments={
    async customer(){calls.customer++;return customerId;},
    async price(id){return {id,active:true,currency,amount:id==='price_plus'?4900:id==='price_pro'?14900:49900,interval:'month',intervalCount:1};},
    async subscriptions(customer){return subs.filter(sub=>sub.customerId===customer);},
    async checkout(input){calls.checkout++;paymentCalls.push(input);const session={id:'cs_fixture',url:redirect,expiresAt:input.expiresAt,status:'open'};sessions.set(session.id,session);return session;},
    async session(id){return sessions.get(id)!;},
    async portal(customer){calls.portal.push(customer);return 'https://billing.stripe.com/p/session/fixture';},
    async schedule(_sub,price,key,receipt){calls.schedule.push(price);calls.keys.push(key);subs[0]!.scheduleId='sub_sched_fixture';await receipt('sub_sched_fixture');if(scheduleFails)throw new Error('fixture outage');return 'sub_sched_fixture';},
  };
  const owner=async(header:string|undefined)=>{if(!header?.startsWith('Bearer '))throw new ServiceFailure(401,'login-required','Sign in.','identity');return accounts.provision({uid:header.slice(7),email:`${header.slice(7)}@example.com`});};
  const config={enabled:true,live:false,merchantMode:'direct' as const,taxMode:'not_collecting' as const,projectId:'femlab-test',appOrigin:'https://femlab.app',prices:{plus:'price_plus',pro:'price_pro',studio:'price_studio'}};
  const service=checkoutService(db,payments,config,owner,now,randomUUID);
  const servers:ReturnType<typeof serviceServer>[]=[];
  afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}});
  beforeAll(async()=>{
    await admin.query(`CREATE SCHEMA ${schema}`);const dir=new URL('../migrations/',import.meta.url);
    const migrations=await Promise.all((await readdir(dir)).filter(name=>name.endsWith('.sql')).sort().map(async name=>({name,sql:await readFile(new URL(name,dir),'utf8')})));
    const connection=await db.connect();try{await migrate(connection,migrations);}finally{connection.release();}
  });
  beforeEach(async()=>{clock=new Date('2026-10-14T12:00:00Z');await db.query('TRUNCATE accounts CASCADE');await db.query('TRUNCATE billing_leases');calls={customer:0,checkout:0,portal:[],schedule:[],keys:[]};customerId='cus_owner';redirect='https://checkout.stripe.com/c/fixture';currency='usd';subs=[];scheduleFails=false;sessions.clear();paymentCalls.length=0;});
  afterAll(async()=>{await db.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  it('rejects client-selected customer/price/return authority and inactive billing before vendor calls',async()=>{
    for(const extra of [{customerId:'cus_other'},{priceId:'price_other'},{returnUrl:'https://evil.example'},{accountId:randomUUID()}])await expect(service.checkout('Bearer owner',{plan:'plus',...extra})).rejects.toMatchObject({code:'invalid-plan'});
    await expect(service.checkout(undefined,{plan:'plus'})).rejects.toMatchObject({status:401});
    const disabled=checkoutService(db,payments,{...config,enabled:false},owner,now,randomUUID);
    await expect(disabled.checkout('Bearer owner',{plan:'plus'})).rejects.toMatchObject({code:'billing-unavailable'});
    expect(calls.customer).toBe(0);expect(calls.checkout).toBe(0);
  });
  it('uses one durable customer/checkout intent across simultaneous and repeated attempts',async()=>{
    const results=await Promise.allSettled(Array.from({length:16},()=>service.checkout('Bearer owner',{plan:'plus'})));
    expect(results.some(result=>result.status==='fulfilled')).toBe(true);expect(calls.customer).toBe(1);expect(calls.checkout).toBe(1);
    expect(await service.checkout('Bearer owner',{plan:'plus'})).toEqual({url:'https://checkout.stripe.com/c/fixture'});
    expect(calls.checkout).toBe(1);expect((await db.query('SELECT * FROM checkout_intents')).rows).toHaveLength(1);
    expect(paymentCalls[0]).toMatchObject({customer:'cus_owner',price:'price_plus',successUrl:'https://femlab.app/?billing=success',cancelUrl:'https://femlab.app/?billing=canceled'});
    expect(paymentCalls[0]!.expiresAt-now().getTime()/1000).toBe(1860);
    await expect(service.checkout('Bearer owner',{plan:'pro'})).rejects.toMatchObject({code:'checkout-open'});
    expect((await db.query('SELECT * FROM credit_grants')).rows).toHaveLength(0); // checkout/redirect grants nothing
  });
  it('recovers a rejected creation after its expiry window ages and concurrent retries create one payable Session',async()=>{
    let rejectConfiguration=true,created=0;
    const attempts:Parameters<Payments['checkout']>[0][]=[];
    const recovering=checkoutService(db,{...payments,async checkout(input){
      attempts.push(input);
      if(rejectConfiguration)throw new Error('Payment configuration rejected before creation');
      if(input.expiresAt-now().getTime()/1000<1800)throw new CheckoutNotCreated('Expiry rejected before creation');
      created++;const session={id:`cs_recovered_${created}`,url:`https://checkout.stripe.com/c/recovered_${created}`,expiresAt:input.expiresAt,status:'open'};
      sessions.set(session.id,session);return session;
    }},config,owner,now,randomUUID);
    await expect(recovering.checkout('Bearer owner',{plan:'plus'})).rejects.toThrow('configuration rejected');
    const original=(await db.query('SELECT * FROM checkout_intents')).rows[0]!;
    expect(original.session_id).toBeNull();
    clock=new Date(clock.getTime()+180000);rejectConfiguration=false;
    const results=await Promise.allSettled(Array.from({length:16},()=>recovering.checkout('Bearer owner',{plan:'plus'})));
    const fulfilled=results.filter(result=>result.status==='fulfilled');
    expect(fulfilled.length).toBeGreaterThan(0);
    for(const result of fulfilled)expect(result.value).toEqual({url:'https://checkout.stripe.com/c/recovered_1'});
    expect(created).toBe(1);expect(sessions.size).toBe(1);expect(attempts).toHaveLength(3);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(attempts[2]!.key).not.toBe(attempts[0]!.key);
    expect(attempts[2]!.expiresAt-now().getTime()/1000).toBe(1860);
    const current=(await db.query('SELECT * FROM checkout_intents')).rows;
    expect(current).toHaveLength(1);expect(current[0]!.id).not.toBe(original.id);expect(current[0]!.session_id).toBe('cs_recovered_1');
    expect((await db.query('SELECT * FROM credit_grants')).rows).toHaveLength(0);
  });
  it('replays a timed-out successful creation with the exact original key and parameters after several minutes',async()=>{
    let created=0;
    const attempts:Parameters<Payments['checkout']>[0][]=[],saved=new Map<string,Awaited<ReturnType<Payments['checkout']>>>();
    const uncertain=checkoutService(db,{...payments,async checkout(input){
      attempts.push(input);
      // Stripe API v1 returns a saved successful response before attempting a fresh creation.
      const replay=saved.get(input.key);if(replay)return replay;
      if(input.expiresAt-now().getTime()/1000<1800)throw new CheckoutNotCreated('Expiry rejected before creation');
      created++;const session={id:`cs_uncertain_${created}`,url:`https://checkout.stripe.com/c/uncertain_${created}`,expiresAt:input.expiresAt,status:'open'};
      saved.set(input.key,session);sessions.set(session.id,session);throw new Error('Connection lost after successful creation');
    }},config,owner,now,randomUUID);
    await expect(uncertain.checkout('Bearer owner',{plan:'plus'})).rejects.toThrow('Connection lost');
    const original=(await db.query('SELECT * FROM checkout_intents')).rows[0]!;
    expect(original.session_id).toBeNull();
    clock=new Date(clock.getTime()+180000);
    const results=await Promise.allSettled(Array.from({length:16},()=>uncertain.checkout('Bearer owner',{plan:'plus'})));
    const fulfilled=results.filter(result=>result.status==='fulfilled');
    expect(fulfilled.length).toBeGreaterThan(0);
    for(const result of fulfilled)expect(result.value).toEqual({url:'https://checkout.stripe.com/c/uncertain_1'});
    expect(created).toBe(1);expect(sessions.size).toBe(1);expect(attempts).toHaveLength(2);expect(attempts[1]).toEqual(attempts[0]);
    const current=(await db.query('SELECT * FROM checkout_intents')).rows[0]!;
    expect(current.id).toBe(original.id);expect(current.expires_at).toEqual(original.expires_at);expect(current.session_id).toBe('cs_uncertain_1');
  });
  it('bounds safe expiry recreation to one retry without granting credits',async()=>{
    let attempts=0;
    const rejected=checkoutService(db,{...payments,async checkout(){attempts++;throw new CheckoutNotCreated('Expiry rejected before creation');}},config,owner,now,randomUUID);
    await expect(rejected.checkout('Bearer owner',{plan:'plus'})).rejects.toMatchObject({code:'checkout-unavailable'});
    expect(attempts).toBe(2);expect((await db.query('SELECT * FROM checkout_intents')).rows).toHaveLength(0);
    expect((await db.query('SELECT * FROM credit_grants')).rows).toHaveLength(0);
  });
  it.each(['recorded Session','replaced intent'])('preserves a concurrently %s instead of resetting it after rejection',async(change)=>{
    let attempts=0;const replacement=randomUUID();
    const changing=checkoutService(db,{...payments,async checkout(){
      attempts++;
      if(change==='recorded Session')await db.query("UPDATE checkout_intents SET session_id='cs_recorded',session_url='https://checkout.stripe.com/c/recorded'");
      else await db.query('UPDATE checkout_intents SET id=$1',[replacement]);
      throw new CheckoutNotCreated('Expiry rejected before creation');
    }},config,owner,now,randomUUID);
    await expect(changing.checkout('Bearer owner',{plan:'plus'})).rejects.toMatchObject({code:'checkout-unavailable'});
    expect(attempts).toBe(1);
    const current=(await db.query('SELECT * FROM checkout_intents')).rows;
    expect(current).toHaveLength(1);
    if(change==='recorded Session')expect(current[0]!.session_id).toBe('cs_recorded');
    else expect(current[0]!.id).toBe(replacement);
  });
  it('opens only the authenticated customer portal and refuses a foreign customer link',async()=>{
    await expect(service.portal('Bearer other')).rejects.toMatchObject({code:'no-subscription'});
    await service.checkout('Bearer owner',{plan:'plus'});await service.portal('Bearer owner');expect(calls.portal).toEqual(['cus_owner']);
    await expect(service.portal('Bearer other')).rejects.toMatchObject({code:'no-subscription'});
  });
  it('serves owned Portal management and its public signal while sales and a paid account are financially frozen',async()=>{
    const account=await owner('Bearer owner');
    await db.query("INSERT INTO billing_accounts(account_id,customer_id,subscription_status,blocked,updated_at) VALUES($1,'cus_owner','active',true,$2)",[account.id,now()]);
    await ledger.grant({accountId:account.id,source:'paid-frozen',plan:'plus',startsAt:now(),expiresAt:new Date('2026-11-14T12:00:00Z')});
    const paused=checkoutService(db,payments,{...config,enabled:false},owner,now,randomUUID);
    const server=serviceServer({now,newId:randomUUID,ready:async()=>true,payments:paused,account:async header=>{
      const active=await owner(header);return {...active,usage:await ledger.balance(active.id),billing:await paused.status(active.id)};
    }});
    servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening');
    const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post=(path:string,authorization?:string,body:unknown={})=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(authorization?{authorization}:{})},body:JSON.stringify(body)});
    const profile=await fetch(base+'/v1/account',{headers:{authorization:'Bearer owner'}});
    expect(profile.status).toBe(200);const publicProfile=await profile.json() as AccountResponse;
    expect(publicProfile.billing).toMatchObject({available:false,canManage:true,reviewRequired:true});
    expect(publicProfile.usage).toMatchObject({plan:'free',availableCredits:0});
    expect(JSON.stringify(publicProfile)).not.toContain('cus_owner');
    const portal=await post('/v1/billing/portal','Bearer owner');expect(portal.status).toBe(200);
    expect(await portal.json()).toEqual({url:'https://billing.stripe.com/p/session/fixture'});expect(calls.portal).toEqual(['cus_owner']);
    expect((await post('/v1/billing/portal')).status).toBe(401);
    expect((await post('/v1/billing/portal','Bearer other')).status).toBe(409);
    expect((await post('/v1/billing/portal','Bearer owner',{customerId:'cus_other'})).status).toBe(422);
    const other=await owner('Bearer other');expect(await paused.status(other.id)).toMatchObject({available:false,canManage:false});
    for(const path of ['/v1/billing/checkout','/v1/billing/plan'])expect((await post(path,'Bearer owner',{plan:'pro'})).status).toBe(503);
    expect(calls.customer).toBe(0);expect(calls.checkout).toBe(0);expect(calls.schedule).toEqual([]);expect(calls.portal).toEqual(['cus_owner']);
    expect((await db.query('SELECT * FROM checkout_intents')).rows).toHaveLength(0);expect((await db.query('SELECT * FROM plan_changes')).rows).toHaveLength(0);
  });
  it.each(['deleting','deleted'])('refuses Portal management for a %s account even after an earlier identity read',async status=>{
    const account=await owner('Bearer owner');await db.query("INSERT INTO billing_accounts(account_id,customer_id,updated_at) VALUES($1,'cus_owner',$2)",[account.id,now()]);
    const paused=checkoutService(db,payments,{...config,enabled:false},owner,now,randomUUID);
    const staleIdentity=checkoutService(db,payments,{...config,enabled:false},async()=>account,now,randomUUID);
    expect(await paused.status(account.id)).toMatchObject({canManage:true});
    await db.query('UPDATE accounts SET status=$2 WHERE id=$1',[account.id,status]);
    expect(await paused.status(account.id)).toMatchObject({canManage:false});
    await expect(paused.portal('Bearer owner')).rejects.toMatchObject({code:'account-inactive'});
    await expect(staleIdentity.portal('Bearer owner')).rejects.toMatchObject({code:'account-inactive'});expect(calls.portal).toEqual([]);
  });
  it('validates the configured monthly amount/currency and the redirect origin',async()=>{
    currency='eur';await expect(service.checkout('Bearer owner',{plan:'plus'})).rejects.toMatchObject({code:'price-unavailable'});expect(calls.checkout).toBe(0);
    currency='usd';redirect='https://checkout.stripe.com.evil.example/c';await expect(service.checkout('Bearer owner',{plan:'plus'})).rejects.toThrow('Untrusted payment redirect');
    expect(()=>checkoutService(db,payments,{...config,appOrigin:'https://femlab.app/unsafe?return=evil'},owner,now,randomUUID)).toThrow('configured HTTPS origin');
  });
  it('schedules a next-period change without replacing or minting the current allowance',async()=>{
    const account=await owner('Bearer owner');await grantFreeFixture(ledger, account.id, now());
    await db.query('INSERT INTO billing_accounts(account_id,customer_id,updated_at) VALUES($1,$2,$3)',[account.id,'cus_owner',now()]);
    const end=new Date('2026-11-14T12:00:00Z');
    await ledger.grant({accountId:account.id,source:'paid-existing',plan:'plus',startsAt:now(),expiresAt:end});
    subs=[{id:'sub_one',customerId:'cus_owner',status:'active',priceId:'price_plus',start:now().getTime()/1000,end:end.getTime()/1000,scheduleId:null}];
    await expect(service.checkout('Bearer owner',{plan:'pro'})).rejects.toMatchObject({code:'subscription-exists'});
    expect(await service.change('Bearer owner',{plan:'pro'})).toEqual({plan:'pro',effectiveAt:end.toISOString()});expect(calls.schedule).toEqual(['price_pro']);
    expect((await ledger.balance(account.id)).availableCredits).toBe(10000000);
    expect((await service.status(account.id)).scheduledPlan).toEqual({plan:'pro',effectiveAt:end.toISOString(),processing:false});
    await service.change('Bearer owner',{plan:'studio'});await service.change('Bearer owner',{plan:'pro'});
    expect(calls.schedule).toEqual(['price_pro','price_studio','price_pro']);
    expect(new Set(calls.keys).size).toBe(3);
    await db.query('UPDATE billing_accounts SET blocked=true WHERE account_id=$1',[account.id]);
    await expect(service.change('Bearer owner',{plan:'studio'})).rejects.toMatchObject({code:'billing-review'});
  });
  it('recovers an already accepted frozen plan change during a sales pause without accepting new changes',async()=>{
    const account=await owner('Bearer owner');await db.query('INSERT INTO billing_accounts(account_id,customer_id,updated_at) VALUES($1,$2,$3)',[account.id,'cus_owner',now()]);
    const end=new Date('2026-11-14T12:00:00Z');subs=[{id:'sub_one',customerId:'cus_owner',status:'active',priceId:'price_plus',start:now().getTime()/1000,end:end.getTime()/1000,scheduleId:null}];
    scheduleFails=true;await expect(service.change('Bearer owner',{plan:'pro'})).rejects.toThrow('fixture outage');
    expect((await service.status(account.id)).scheduledPlan).toMatchObject({plan:'pro',processing:true});
    const pending=(await db.query('SELECT * FROM plan_changes')).rows[0]!;
    expect(pending).toMatchObject({request_version:2,price_id:'price_pro',purchase_use:null,state:'pending'});
    const paused=checkoutService(db,payments,{...config,enabled:false},owner,now,randomUUID);
    await expect(paused.change('Bearer owner',{plan:'studio'})).rejects.toMatchObject({code:'billing-unavailable'});
    await expect(paused.checkout('Bearer owner',{plan:'studio'})).rejects.toMatchObject({code:'billing-unavailable'});
    expect((await db.query('SELECT * FROM plan_changes')).rows[0]).toEqual(pending);
    scheduleFails=false;expect(await paused.recover()).toEqual({processed:1,failed:0});expect(calls.keys[0]).toBe(calls.keys[1]);expect(calls.schedule).toEqual(['price_pro','price_pro']);
    expect((await service.status(account.id)).scheduledPlan).toMatchObject({processing:false});
  });
  it.each(['financial review','deleting','deleted','unversioned'])('keeps accepted recovery closed for %s during a sales pause',async reason=>{
    const account=await owner('Bearer owner');await db.query("INSERT INTO billing_accounts(account_id,customer_id,updated_at) VALUES($1,'cus_owner',$2)",[account.id,now()]);
    const end=new Date('2026-11-14T12:00:00Z');subs=[{id:'sub_one',customerId:'cus_owner',status:'active',priceId:'price_plus',start:now().getTime()/1000,end:end.getTime()/1000,scheduleId:null}];
    scheduleFails=true;await expect(service.change('Bearer owner',{plan:'pro'})).rejects.toThrow('fixture outage');scheduleFails=false;
    if(reason==='financial review')await db.query('UPDATE billing_accounts SET blocked=true WHERE account_id=$1',[account.id]);
    else if(reason==='unversioned')await db.query('UPDATE plan_changes SET request_version=NULL WHERE account_id=$1',[account.id]);
    else await db.query('UPDATE accounts SET status=$2 WHERE id=$1',[account.id,reason]);
    const paused=checkoutService(db,payments,{...config,enabled:false},owner,now,randomUUID);
    expect(await paused.recover()).toEqual({processed:0,failed:reason==='unversioned'?1:0});expect(calls.schedule).toEqual(['price_pro']);
    expect((await db.query('SELECT state FROM plan_changes')).rows[0]!.state).toBe('pending');
  });
});
