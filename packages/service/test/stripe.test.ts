import Stripe from 'stripe';
import {describe,expect,it} from 'vitest';
import {stripeGateway} from '../src/stripe';
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
});
