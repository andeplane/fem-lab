import Stripe from 'stripe';
import type {BillingEnvelope,BillingGateway} from './billing';

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
    async chargeCustomer(id) {
      const charge=id.startsWith('dp_')?await client.charges.retrieve(identity((await client.disputes.retrieve(id)).charge)):await client.charges.retrieve(id);
      return charge.customer?identity(charge.customer):null;
    },
  };
}
