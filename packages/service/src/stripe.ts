import Stripe from 'stripe';
import type {BillingEnvelope,BillingGateway} from './billing';
import {CheckoutNotCreated,type Payments} from './checkout';
import {ServiceFailure} from './errors';

export type BillingTaxMode='pending'|'automatic'|'not_collecting';
export type BillingMerchantMode='pending'|'direct'|'managed';
/** The host must record an explicit collection decision before enabling checkout. */
export function billingTaxMode(value:string|undefined,enabled:boolean):BillingTaxMode {
  const mode=value==='automatic'||value==='not_collecting'?value:'pending';
  if(enabled&&mode==='pending')throw new Error('BILLING_TAX_MODE must be automatic or not_collecting before enabling billing.');
  return mode;
}
/** Merchant responsibility is explicit; an account default must never select it. */
export function billingMerchantMode(value:string|undefined,enabled:boolean,taxMode:BillingTaxMode):BillingMerchantMode {
  const mode=value==='direct'||value==='managed'?value:'pending';
  if(enabled&&mode==='pending')throw new Error('BILLING_MERCHANT_MODE must be direct or managed before enabling billing.');
  if(enabled&&mode==='managed'&&taxMode!=='automatic')throw new Error('Managed Payments requires BILLING_TAX_MODE=automatic.');
  return mode;
}

const identity=(value:string|{id:string})=>typeof value==='string'?value:value.id;
/** The SDK receives the raw webhook bytes and the host clock; public payloads contain no payment PII. */
export function stripeGateway(client:Stripe,webhookSecret:string):BillingGateway {
  return {
    verify(body,signature,now):BillingEnvelope {
      const event=client.webhooks.constructEvent(Buffer.from(body),signature,webhookSecret,300,undefined,now.getTime());
      const object=event.data.object as {id:string;customer?:string|{id:string}|null};
      return {id:event.id,type:event.type,objectId:object.id,customerId:object.customer?identity(object.customer):null,live:event.livemode};
    },
    async invoice(id) {
      const invoice=await client.invoices.retrieve(id);
      if(!invoice.customer)throw new Error('Invoice requires a customer.');
      const subscription=invoice.parent?.subscription_details?.subscription;
      const lines=[];
      for await(const line of client.invoices.listLineItems(id,{limit:100})) {
        const price=line.pricing?.price_details?.price;
        lines.push({priceId:price?identity(price):null,quantity:line.quantity,
          proration:line.parent?.subscription_item_details?.proration??line.parent?.invoice_item_details?.proration??false,start:line.period.start,end:line.period.end});
        if(lines.length>100)throw new Error('Invoice exceeds the supported line count.');
      }
      return {id:invoice.id,customerId:identity(invoice.customer),subscriptionId:subscription?identity(subscription):null,status:invoice.status,currency:invoice.currency,reason:invoice.billing_reason,amountPaid:invoice.amount_paid,lines};
    },
    async subscription(id) {
      const subscription=await client.subscriptions.retrieve(id);
      return {id:subscription.id,customerId:identity(subscription.customer),status:subscription.status,cancelAtPeriodEnd:subscription.cancel_at_period_end,
        periodEnd:subscription.items.data[0]?.current_period_end??null};
    },
    async chargeCustomer(id,kind) {
      const charge=kind==='dispute'?await client.charges.retrieve(identity((await client.disputes.retrieve(id)).charge)):await client.charges.retrieve(id);
      return charge.customer?identity(charge.customer):null;
    },
  };
}

/** Hosted Checkout/Portal only: card/payment credentials never pass through FEM Lab. */
export function stripePayments(client:Stripe,portalConfiguration:string,projectId:string,taxMode:BillingTaxMode,merchantMode:BillingMerchantMode):Payments {
  return {
    async customer(account,key) {
      const existing=await client.customers.search({query:`metadata['femlab_account_id']:'${account.id}' AND metadata['femlab_project']:'${projectId}'`,limit:2});
      if(existing.data.length>1)throw new Error('Ambiguous payment customer.');
      if(existing.data[0])return existing.data[0].id;
      return (await client.customers.create({email:account.email,metadata:{femlab_account_id:account.id,femlab_project:projectId}},{idempotencyKey:key})).id;
    },
    async price(id) {
      const price=await client.prices.retrieve(id);
      return {id:price.id,active:price.active,currency:price.currency,amount:price.unit_amount,interval:price.recurring?.interval??null,intervalCount:price.recurring?.interval_count??null};
    },
    async subscriptions(customer) {
      const result=[];
      for await(const subscription of client.subscriptions.list({customer,status:'all',limit:100})) {
        const item=subscription.items.data[0];
        if(subscription.items.data.length!==1||item?.quantity!==1)throw new ServiceFailure(409,'subscription-use-unknown','This subscription needs review before changing plans.','billing','account.open');
        result.push({id:subscription.id,customerId:identity(subscription.customer),status:subscription.status,priceId:item.price.id,start:item.current_period_start,end:item.current_period_end,scheduleId:subscription.schedule?identity(subscription.schedule):null});
        if(result.length>100)throw new Error('Subscription count exceeds the supported limit.');
      }
      return result;
    },
    async checkout(input) {
      if(merchantMode!=='direct'&&merchantMode!=='managed')throw new ServiceFailure(503,'billing-merchant-pending','Paid plans are unavailable until billing setup is complete.','billing');
      if(taxMode==='pending')throw new ServiceFailure(503,'billing-tax-pending','Paid plans are unavailable until billing setup is complete.','billing');
      if(merchantMode==='managed'&&taxMode!=='automatic')throw new ServiceFailure(503,'billing-tax-pending','Managed Payments tax setup is incomplete.','billing');
      // Managed Payments owns tax, customer updates and tax-ID collection. Sending
      // these direct-merchant parameters is unsupported by its Checkout contract.
      const direct:Stripe.Checkout.SessionCreateParams=merchantMode==='direct'?{
        automatic_tax:{enabled:taxMode==='automatic'},customer_update:{address:'auto',name:'auto'},tax_id_collection:{enabled:true},
      }:{};
      let session:Stripe.Checkout.Session;
      try {
        session=await client.checkout.sessions.create({mode:'subscription',customer:input.customer,client_reference_id:input.accountId,
          integration_identifier:'femlab_hosted_ai_kkdxrxlz',
          line_items:[{price:input.price,quantity:1}],success_url:input.successUrl,cancel_url:input.cancelUrl,expires_at:input.expiresAt,
          ...direct,managed_payments:{enabled:merchantMode==='managed'},billing_address_collection:'required',
          consent_collection:{terms_of_service:'required'},allow_promotion_codes:false,
          subscription_data:{metadata:{femlab_account_id:input.accountId,femlab_project:projectId}},
        },{idempotencyKey:input.key});
      } catch(error) {
        // API v1 replays saved results; only explicit expiry validation proves no Session exists.
        // https://docs.stripe.com/api/idempotent_requests
        if(error instanceof Stripe.errors.StripeInvalidRequestError&&error.rawType==='invalid_request_error'&&error.statusCode===400&&error.param==='expires_at')throw new CheckoutNotCreated('Checkout expiry was rejected before creation.');
        throw error;
      }
      return {id:session.id,url:session.url,expiresAt:session.expires_at,status:session.status};
    },
    async session(id) {const session=await client.checkout.sessions.retrieve(id);return {id:session.id,url:session.url,expiresAt:session.expires_at,status:session.status};},
    async portal(customer,returnUrl) {return (await client.billingPortal.sessions.create({customer,return_url:returnUrl,configuration:portalConfiguration})).url;},
    async schedule(subscription,price,key,receipt) {
      const id=subscription.scheduleId??(await client.subscriptionSchedules.create({from_subscription:subscription.id},{idempotencyKey:`femlab-schedule:${subscription.id}`})).id;
      const schedule=await client.subscriptionSchedules.retrieve(id);
      if(schedule.id!==id||!schedule.subscription||identity(schedule.subscription)!==subscription.id)throw new Error('Schedule subscription mismatch.');
      await receipt(schedule.id);
      await client.subscriptionSchedules.update(schedule.id,{end_behavior:'release',proration_behavior:'none',phases:[
        {start_date:subscription.start,end_date:subscription.end,items:[{price:subscription.priceId,quantity:1}],proration_behavior:'none'},
        {start_date:subscription.end,duration:{interval:'month',interval_count:1},items:[{price,quantity:1}],proration_behavior:'none'},
      ]},{idempotencyKey:key});
      return schedule.id;
    },
  };
}
