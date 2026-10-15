import Stripe from 'stripe';
import {describe,expect,it} from 'vitest';
import {billingMerchantMode,billingTaxMode,stripeGateway,stripePayments} from '../src/stripe';
import {CheckoutNotCreated} from '../src/checkout';
describe('signed Stripe transport',()=>{
  it('verifies original bytes and uses the injected signature-age clock',()=>{
    const stripe=new Stripe('fixture'),gateway=stripeGateway(stripe,'whsec_fixture'),now=new Date('2026-10-14T12:00:00Z');
    const payload=JSON.stringify({id:'evt_signed',type:'invoice.paid',livemode:false,data:{object:{id:'in_signed',customer:'cus_signed'}}});
    const signature=stripe.webhooks.generateTestHeaderString({payload,secret:'whsec_fixture',timestamp:now.getTime()/1000});
    expect(gateway.verify(new TextEncoder().encode(payload),signature,now)).toEqual({id:'evt_signed',type:'invoice.paid',objectId:'in_signed',customerId:'cus_signed',live:false});
    expect(()=>gateway.verify(new TextEncoder().encode(payload+' '),signature,now)).toThrow();
    expect(()=>gateway.verify(new TextEncoder().encode(payload),signature,new Date(now.getTime()+301000))).toThrow();
  });
  it('normalizes current invoice/subscription/refund wire fields without using customer email',async()=>{
    const fetcher:typeof fetch=async url=>{
      const path=new URL(String(url)).pathname;
      if(path==='/v1/invoices/in_wire')return Response.json({id:'in_wire',customer:{id:'cus_wire'},parent:{subscription_details:{subscription:{id:'sub_wire'}}},status:'paid',currency:'usd',billing_reason:'subscription_cycle',amount_paid:4900});
      if(path==='/v1/invoices/in_wire/lines')return Response.json({object:'list',has_more:false,data:[{id:'il_one',pricing:{price_details:{price:{id:'price_plus'}}},parent:{subscription_item_details:{proration:false}},quantity:1,period:{start:100,end:200}}]});
      if(path==='/v1/subscriptions/sub_wire')return Response.json({id:'sub_wire',customer:'cus_wire',status:'active',cancel_at_period_end:true,items:{data:[{current_period_end:200}]}});
      if(path==='/v1/disputes/dp_one')return Response.json({id:'dp_one',charge:{id:'ch_one'}});
      if(path==='/v1/charges/ch_one')return Response.json({id:'ch_one',customer:{id:'cus_wire'}});
      throw new Error('Unexpected Stripe fixture route');
    };
    const gateway=stripeGateway(new Stripe('fixture',{httpClient:Stripe.createFetchHttpClient(fetcher)}),'whsec_fixture');
    expect(await gateway.invoice('in_wire')).toEqual({id:'in_wire',customerId:'cus_wire',subscriptionId:'sub_wire',status:'paid',currency:'usd',reason:'subscription_cycle',amountPaid:4900,lines:[{priceId:'price_plus',quantity:1,proration:false,start:100,end:200}]});
    expect(await gateway.subscription('sub_wire')).toEqual({id:'sub_wire',customerId:'cus_wire',status:'active',cancelAtPeriodEnd:true,periodEnd:200});
    expect(await gateway.chargeCustomer('dp_one')).toBe('cus_wire');expect(await gateway.chargeCustomer('ch_one')).toBe('cus_wire');
  });
  it.each(['direct','managed'] as const)('creates %s payment URLs with server-owned parameters and a non-prorated next-period schedule',async(merchant)=>{
    const requests:{path:string;method:string;body:URLSearchParams;key:string|null}[]=[];
    const fetcher:typeof fetch=async(url,init)=>{
      const path=new URL(String(url)).pathname,body=new URLSearchParams(String(init?.body??''));
      requests.push({path,method:init?.method??'GET',body,key:new Headers(init?.headers).get('idempotency-key')});
      if(path==='/v1/customers/search')return Response.json({object:'search_result',has_more:false,data:[]});
      if(path==='/v1/customers')return Response.json({id:'cus_wire'});
      if(path==='/v1/prices/price_plus')return Response.json({id:'price_plus',active:true,currency:'usd',unit_amount:4900,recurring:{interval:'month',interval_count:1}});
      if(path==='/v1/subscriptions')return Response.json({object:'list',has_more:false,data:[{id:'sub_wire',customer:'cus_wire',status:'active',schedule:null,items:{data:[{price:{id:'price_plus'},quantity:1,current_period_start:100,current_period_end:200}]}}]});
      if(path.startsWith('/v1/checkout/sessions'))return Response.json({id:'cs_wire',url:'https://checkout.stripe.com/c/wire',status:'open',expires_at:2000});
      if(path==='/v1/billing_portal/sessions')return Response.json({url:'https://billing.stripe.com/p/session/wire'});
      if(path.startsWith('/v1/subscription_schedules'))return Response.json({id:'sub_sched_wire',subscription:'sub_wire'});
      throw new Error('Unexpected payment fixture route');
    };
    const payments=stripePayments(new Stripe('fixture',{httpClient:Stripe.createFetchHttpClient(fetcher)}),'bpc_fixture','femlab-test','automatic',merchant);
    expect(await payments.customer({id:'11111111-1111-4111-8111-111111111111',email:'owned@example.com',createdAt:'2026-10-14T12:00:00.000Z',status:'active'},'customer-key')).toBe('cus_wire');
    expect(await payments.price('price_plus')).toMatchObject({amount:4900,interval:'month'});
    const subscription=(await payments.subscriptions('cus_wire'))[0]!;
    await payments.checkout({customer:'cus_wire',price:'price_plus',accountId:'account-one',successUrl:'https://femlab.app/?billing=success',cancelUrl:'https://femlab.app/?billing=canceled',expiresAt:2000,key:'checkout-key'});
    expect(await payments.session('cs_wire')).toMatchObject({status:'open'});
    await payments.portal('cus_wire','https://femlab.app/');await payments.schedule(subscription,'price_pro','plan-key');
    const checkout=requests.find(row=>row.path==='/v1/checkout/sessions')!;
    expect(checkout.key).toBe('checkout-key');expect(checkout.body.get('customer')).toBe('cus_wire');expect(checkout.body.get('line_items[0][price]')).toBe('price_plus');
    expect(checkout.body.get('automatic_tax[enabled]')).toBe(merchant==='direct'?'true':null);expect(checkout.body.get('consent_collection[terms_of_service]')).toBe('required');
    expect(checkout.body.get('managed_payments[enabled]')).toBe(String(merchant==='managed'));
    expect(checkout.body.get('customer_update[name]')).toBe(merchant==='direct'?'auto':null);
    expect(checkout.body.get('tax_id_collection[enabled]')).toBe(merchant==='direct'?'true':null);
    const phase=requests.find(row=>row.path==='/v1/subscription_schedules/sub_sched_wire')!;
    expect(phase.key).toBe('plan-key');expect(phase.body.get('phases[0][end_date]')).toBe('200');expect(phase.body.get('phases[1][start_date]')).toBe('200');
    expect(phase.body.get('phases[1][items][0][price]')).toBe('price_pro');expect(phase.body.get('proration_behavior')).toBe('none');
    expect(requests.find(row=>row.path==='/v1/subscription_schedules')!.body.get('from_subscription')).toBe('sub_wire');
    expect(phase.body.get('default_settings[automatic_tax][enabled]')).toBeNull();
    expect(phase.body.get('phases[1][automatic_tax][enabled]')).toBeNull();
  });
  it.each([['direct','automatic','true'],['direct','not_collecting','false'],['managed','automatic',null]] as const)('sends explicit %s merchant / %s tax policy to hosted Checkout',async(merchant,mode,expected)=>{
    const requests:URLSearchParams[]=[];
    const fetcher:typeof fetch=async(_url,init)=>{
      requests.push(new URLSearchParams(String(init?.body??'')));
      return Response.json({id:'cs_tax',url:'https://checkout.stripe.com/c/tax',status:'open',expires_at:2000});
    };
    const payments=stripePayments(new Stripe('fixture',{httpClient:Stripe.createFetchHttpClient(fetcher)}),'bpc_fixture','femlab-test',mode,merchant);
    const input={customer:'cus_tax',price:'price_plus',accountId:'account-one',successUrl:'https://femlab.app/?billing=success',cancelUrl:'https://femlab.app/?billing=canceled',expiresAt:2000,key:'checkout-tax-key'};
    await payments.checkout(input);await payments.checkout(input);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.get('integration_identifier')).toMatch(/^femlab_hosted_ai_[a-z]{8}$/);
    expect(requests[0]!.toString()).toBe(requests[1]!.toString());
    expect(requests[0]!.get('automatic_tax[enabled]')).toBe(expected);
    expect(requests[0]!.get('managed_payments[enabled]')).toBe(String(merchant==='managed'));
    expect(requests[0]!.get('customer_update[name]')).toBe(merchant==='direct'?'auto':null);
    expect(requests[0]!.get('customer_update[address]')).toBe(merchant==='direct'?'auto':null);
    expect(requests[0]!.get('tax_id_collection[enabled]')).toBe(merchant==='direct'?'true':null);
    expect(requests[0]!.get('adaptive_pricing[enabled]')).toBeNull();
    expect(requests[0]!.get('payment_method_types[0]')).toBeNull();
    expect(requests[0]!.get('consent_collection[terms_of_service]')).toBe('required');
  });
  it.each([
    {status:400,type:'invalid_request_error',param:'expires_at',safe:true},
    {status:400,type:'invalid_request_error',param:'customer',safe:false},
    {status:400,type:'invalid_request_error',safe:false},
    {status:400,type:'api_error',param:'expires_at',safe:false},
    {status:400,type:'idempotency_error',param:'expires_at',safe:false},
    {status:400,param:'expires_at',safe:false},
    {status:401,type:'invalid_request_error',param:'expires_at',safe:false},
    {status:403,type:'invalid_request_error',param:'expires_at',safe:false},
    {status:409,type:'invalid_request_error',param:'expires_at',safe:false},
    {status:429,type:'invalid_request_error',param:'expires_at',safe:false},
    {status:500,type:'invalid_request_error',param:'expires_at',safe:false},
  ])('classifies only explicit expiry validation as not created: $status $type $param',async({status,type,param,safe})=>{
    let requests=0;
    const fetcher:typeof fetch=async()=>{requests++;return Response.json({error:{type,param,message:'Payment fixture rejection'}},{status,headers:{'Stripe-Should-Retry':'false'}})};
    const payments=stripePayments(new Stripe('fixture',{maxNetworkRetries:0,httpClient:Stripe.createFetchHttpClient(fetcher)}),'bpc_fixture','femlab-test','not_collecting','direct');
    const result=payments.checkout({customer:'cus_tax',price:'price_plus',accountId:'account-one',successUrl:'https://femlab.app/?billing=success',cancelUrl:'https://femlab.app/?billing=canceled',expiresAt:2000,key:'checkout-expiry-key'});
    if(safe)await expect(result).rejects.toBeInstanceOf(CheckoutNotCreated);
    else await expect(result).rejects.not.toBeInstanceOf(CheckoutNotCreated);
    expect(requests).toBe(1);
  });
  it('keeps a transport failure ambiguous instead of classifying it as no Session',async()=>{
    const fetcher:typeof fetch=async()=>{throw new Error('Connection lost')};
    const payments=stripePayments(new Stripe('fixture',{maxNetworkRetries:0,httpClient:Stripe.createFetchHttpClient(fetcher)}),'bpc_fixture','femlab-test','not_collecting','direct');
    await expect(payments.checkout({customer:'cus_tax',price:'price_plus',accountId:'account-one',successUrl:'https://femlab.app/?billing=success',cancelUrl:'https://femlab.app/?billing=canceled',expiresAt:2000,key:'checkout-network-key'})).rejects.toBeInstanceOf(Stripe.errors.StripeConnectionError);
  });
  it('refuses pending checkout before making a Stripe request while preserving Portal access',async()=>{
    let requests=0;
    const fetcher:typeof fetch=async()=>{requests++;return Response.json({url:'https://billing.stripe.com/p/session/fixture'})};
    const payments=stripePayments(new Stripe('fixture',{httpClient:Stripe.createFetchHttpClient(fetcher)}),'bpc_fixture','femlab-test','pending','direct');
    await expect(payments.checkout({customer:'cus_tax',price:'price_plus',accountId:'account-one',successUrl:'https://femlab.app/?billing=success',cancelUrl:'https://femlab.app/?billing=canceled',expiresAt:2000,key:'checkout-tax-key'})).rejects.toMatchObject({code:'billing-tax-pending',status:503});
    expect(requests).toBe(0);
    expect(await payments.portal('cus_tax','https://femlab.app/')).toBe('https://billing.stripe.com/p/session/fixture');
    expect(requests).toBe(1);
  });
  it('rejects enabled runtime billing without an explicit tax decision, but allows disabled webhook preparation',()=>{
    for(const value of [undefined,'pending','unknown','']){
      expect(()=>billingTaxMode(value,true)).toThrow('BILLING_TAX_MODE');
      expect(billingTaxMode(value,false)).toBe('pending');
    }
    expect(billingTaxMode('automatic',true)).toBe('automatic');
    expect(billingTaxMode('not_collecting',true)).toBe('not_collecting');
  });
  it('requires explicit runtime merchant responsibility and managed automatic tax intent',()=>{
    for(const value of [undefined,'pending','unknown','']) {
      expect(()=>billingMerchantMode(value,true,'automatic')).toThrow('BILLING_MERCHANT_MODE');
      expect(billingMerchantMode(value,false,'pending')).toBe('pending');
    }
    expect(billingMerchantMode('direct',true,'not_collecting')).toBe('direct');
    expect(billingMerchantMode('managed',true,'automatic')).toBe('managed');
    for(const tax of ['pending','not_collecting'] as const)expect(()=>billingMerchantMode('managed',true,tax)).toThrow('BILLING_TAX_MODE=automatic');
  });
  it.each([['pending','automatic','billing-merchant-pending'],['managed','not_collecting','billing-tax-pending'],['managed','pending','billing-tax-pending']] as const)('rejects incompatible %s / %s Checkout before Stripe',async(merchant,tax,code)=>{
    let requests=0;
    const fetcher:typeof fetch=async()=>{requests++;return Response.json({url:'https://billing.stripe.com/p/session/fixture'})};
    const payments=stripePayments(new Stripe('fixture',{httpClient:Stripe.createFetchHttpClient(fetcher)}),'bpc_fixture','femlab-test',tax,merchant);
    await expect(payments.checkout({customer:'cus_tax',price:'price_plus',accountId:'account-one',successUrl:'https://femlab.app/?billing=success',cancelUrl:'https://femlab.app/?billing=canceled',expiresAt:2000,key:'checkout-policy-key'})).rejects.toMatchObject({code,status:503});
    expect(requests).toBe(0);
    expect(await payments.portal('cus_tax','https://femlab.app/')).toBe('https://billing.stripe.com/p/session/fixture');
  });
  it('uses USD canonical invoices despite a localized payment presentation',async()=>{
    const fetcher:typeof fetch=async url=>{
      const path=new URL(String(url)).pathname;
      if(path==='/v1/invoices/in_local')return Response.json({id:'in_local',customer:'cus_local',parent:{subscription_details:{subscription:'sub_local'}},status:'paid',currency:'usd',billing_reason:'subscription_cycle',amount_paid:6125,
        payments:{object:'list',has_more:false,data:[{payment:{type:'payment_intent',payment_intent:{id:'pi_local',currency:'usd',amount:6125,presentment_details:{presentment_amount:70000,presentment_currency:'nok'}}}}]}});
      if(path==='/v1/invoices/in_local/lines')return Response.json({object:'list',has_more:false,data:[{id:'il_local',pricing:{price_details:{price:'price_plus'}},parent:{subscription_item_details:{proration:false}},quantity:1,period:{start:100,end:200}}]});
      throw new Error('Unexpected localized invoice route');
    };
    const gateway=stripeGateway(new Stripe('fixture',{httpClient:Stripe.createFetchHttpClient(fetcher)}),'whsec_fixture');
    expect(await gateway.invoice('in_local')).toMatchObject({currency:'usd',amountPaid:6125,customerId:'cus_local',subscriptionId:'sub_local',lines:[{priceId:'price_plus',start:100,end:200}]});
  });
});
