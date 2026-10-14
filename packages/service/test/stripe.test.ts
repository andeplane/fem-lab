import Stripe from 'stripe';
import {describe,expect,it} from 'vitest';
import {stripeGateway,stripePayments} from '../src/stripe';
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
  it('creates hosted payment URLs with server-owned parameters and a non-prorated next-period schedule',async()=>{
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
    const payments=stripePayments(new Stripe('fixture',{httpClient:Stripe.createFetchHttpClient(fetcher)}),'bpc_fixture','femlab-test');
    expect(await payments.customer({id:'11111111-1111-4111-8111-111111111111',email:'owned@example.com',createdAt:'2026-10-14T12:00:00.000Z',status:'active'},'customer-key')).toBe('cus_wire');
    expect(await payments.price('price_plus')).toMatchObject({amount:4900,interval:'month'});
    const subscription=(await payments.subscriptions('cus_wire'))[0]!;
    await payments.checkout({customer:'cus_wire',price:'price_plus',accountId:'account-one',successUrl:'https://femlab.app/?billing=success',cancelUrl:'https://femlab.app/?billing=canceled',expiresAt:2000,key:'checkout-key'});
    expect(await payments.session('cs_wire')).toMatchObject({status:'open'});
    await payments.portal('cus_wire','https://femlab.app/');await payments.schedule(subscription,'price_pro','plan-key');
    const checkout=requests.find(row=>row.path==='/v1/checkout/sessions')!;
    expect(checkout.key).toBe('checkout-key');expect(checkout.body.get('customer')).toBe('cus_wire');expect(checkout.body.get('line_items[0][price]')).toBe('price_plus');
    expect(checkout.body.get('automatic_tax[enabled]')).toBe('true');expect(checkout.body.get('consent_collection[terms_of_service]')).toBe('required');
    const phase=requests.find(row=>row.path==='/v1/subscription_schedules/sub_sched_wire')!;
    expect(phase.key).toBe('plan-key');expect(phase.body.get('phases[0][end_date]')).toBe('200');expect(phase.body.get('phases[1][start_date]')).toBe('200');
    expect(phase.body.get('phases[1][items][0][price]')).toBe('price_pro');expect(phase.body.get('proration_behavior')).toBe('none');
  });
});
