import {createHash} from 'node:crypto';
import type {PlanId} from './credits';
import {PLANS} from './credits';
import {creditLedger} from './ledger';
import {ServiceFailure} from './errors';
import {transaction,type Database} from './transactions';

export interface BillingEnvelope {id:string;type:string;objectId:string;customerId:string|null;live:boolean}
export interface BillingInvoice {
  id:string;customerId:string;subscriptionId:string|null;status:string|null;currency:string;reason:string|null;amountPaid:number;
  lines:{priceId:string|null;quantity:number|null;proration:boolean;start:number;end:number}[];
}
export interface BillingSubscription {id:string;customerId:string;status:string;cancelAtPeriodEnd:boolean;periodEnd:number|null}
export interface BillingGateway {
  verify(body:Uint8Array,signature:string,now:Date):BillingEnvelope;
  invoice(id:string):Promise<BillingInvoice>;
  subscription(id:string):Promise<BillingSubscription>;
  chargeCustomer(id:string):Promise<string|null>;
}
export interface BillingConfig {live:boolean;prices:Record<Exclude<PlanId,'free'>,string>}
const supported=new Set(['invoice.paid','invoice.payment_succeeded','invoice.payment_failed','customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','charge.refunded','charge.dispute.created']);

/** Signed inbox first; bounded inline processing belongs to the request, retries to a scheduled Job. */
export function billingLifecycle(db:Database,gateway:BillingGateway,config:BillingConfig,now:()=>Date,newId:()=>string) {
  async function receive(body:Uint8Array,signature:string|undefined) {
    let event:BillingEnvelope;
    try {event=gateway.verify(body,signature??'',now());}
    catch {throw new ServiceFailure(400,'invalid-webhook','The payment webhook signature is invalid.','billing');}
    if(event.live!==config.live) throw new ServiceFailure(400,'billing-mode-mismatch','This payment event belongs to a different environment.','billing');
    if(!/^evt_[a-zA-Z0-9_]+$/.test(event.id)||!event.objectId||event.objectId.length>256) throw new ServiceFailure(400,'invalid-webhook','The payment event is invalid.','billing');
    const digest=createHash('sha256').update(JSON.stringify(event)).digest('hex');
    await db.query(`INSERT INTO billing_inbox(event_id,event_type,object_id,customer_id,digest,live,retry_at,received_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT(event_id) DO NOTHING`,[event.id,event.type,event.objectId,event.customerId,digest,event.live,now()]);
    const row=(await db.query('SELECT digest FROM billing_inbox WHERE event_id=$1',[event.id])).rows[0];
    if(row?.digest!==digest) throw new ServiceFailure(409,'billing-event-conflict','A payment event identity was reused with different content.','billing');
    // Network/processing failure leaves a durable inbox item; never depend on work after ACK.
    try {await process(event.id);} catch { /* the retry receipt below is durable */ }
    return {received:true};
  }
  async function process(id:string):Promise<boolean> {
    const event=(await db.query("SELECT * FROM billing_inbox WHERE event_id=$1 AND state='queued'",[id])).rows[0];
    if(!event)return false;
    if(!supported.has(String(event.event_type))) {await db.query("UPDATE billing_inbox SET state='done',processed_at=$2 WHERE event_id=$1",[id,now()]);return true;}
    // A signed customer hint only selects the lease. Canonical Stripe data determines ownership.
    const lockKey=String(event.customer_id??event.object_id),owner=newId();
    const lease=await db.query(`INSERT INTO billing_leases(customer_id,owner,expires_at) VALUES($1,$2,$3)
      ON CONFLICT(customer_id) DO UPDATE SET owner=EXCLUDED.owner,expires_at=EXCLUDED.expires_at
      WHERE billing_leases.expires_at <= $4 RETURNING owner`,[lockKey,owner,new Date(now().getTime()+120000),now()]);
    if(!lease.rows.length)return false;
    try {
      const type=String(event.event_type),objectId=String(event.object_id);
      let invoice:BillingInvoice|undefined,subscription:BillingSubscription|undefined,customerId:string|null=null;
      if(type.startsWith('invoice.')) {
        invoice=await gateway.invoice(objectId);customerId=invoice.customerId;
        if(invoice.subscriptionId)subscription=await gateway.subscription(invoice.subscriptionId);
      } else if(type.startsWith('customer.subscription.')) {subscription=await gateway.subscription(objectId);customerId=subscription.customerId;}
      else customerId=await gateway.chargeCustomer(objectId);
      await transaction(db,async sql=>{
        const liveLease=(await sql.query('SELECT owner,expires_at FROM billing_leases WHERE customer_id=$1',[lockKey])).rows[0];
        if(liveLease?.owner!==owner||(liveLease.expires_at as Date)<=now())throw new Error('Billing lease expired.');
        const fresh=(await sql.query("SELECT state FROM billing_inbox WHERE event_id=$1 FOR UPDATE",[id])).rows[0];
        if(fresh?.state==='done')return;
        if(event.customer_id&&customerId!==event.customer_id)throw new Error('Canonical customer mismatch.');
        const account=(await sql.query('SELECT b.*,a.status FROM billing_accounts b JOIN accounts a ON a.id=b.account_id WHERE customer_id=$1 FOR UPDATE',[customerId])).rows[0];
        if(account&&subscription) {
          if(subscription.customerId!==customerId)throw new Error('Subscription customer mismatch.');
          if(invoice&&invoice.subscriptionId!==subscription.id)throw new Error('Canonical subscription mismatch.');
          if(account.subscription_id&&account.subscription_id!==subscription.id&&!['none','canceled','incomplete_expired'].includes(String(account.subscription_status)))throw new Error('A second subscription requires billing review.');
          await sql.query('UPDATE billing_accounts SET subscription_id=$2,subscription_status=$3,cancel_at_period_end=$4,period_end=$5,updated_at=$6 WHERE account_id=$1',
            [account.account_id,subscription.id,subscription.status,subscription.cancelAtPeriodEnd,subscription.periodEnd?new Date(subscription.periodEnd*1000):null,now()]);
        }
        if(account&&(type==='charge.refunded'||type==='charge.dispute.created')) {
          await sql.query('INSERT INTO billing_reviews(event_id,account_id,reason,created_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[id,account.account_id,type,now()]);
          await sql.query('UPDATE billing_accounts SET blocked=true,updated_at=$2 WHERE account_id=$1',[account.account_id,now()]);
        }
        if(account?.status==='active'&&invoice?.status==='paid'&&subscription&&['invoice.paid','invoice.payment_succeeded'].includes(type)&&['subscription_create','subscription_cycle'].includes(invoice.reason??'')) {
          const lines=invoice.lines.filter(line=>!line.proration&&line.quantity===1&&Object.values(config.prices).includes(line.priceId??''));
          if(invoice.currency!=='usd'||lines.length!==1||invoice.lines.some(line=>line.proration))throw new Error('Unsupported paid invoice.');
          const line=lines[0]!,plan=Object.entries(config.prices).find(([,price])=>price===line.priceId)![0] as Exclude<PlanId,'free'>;
          const duration=line.end-line.start;
          if(!Number.isSafeInteger(line.start)||!Number.isSafeInteger(line.end)||duration<28*86400||duration>32*86400||invoice.amountPaid<PLANS[plan].priceUsd*100)throw new Error('Unsupported invoice period or payment amount.');
          const source=`paid:${subscription.id}:${line.start}`;
          // Different invoice IDs for the same period do not mint another allowance.
          const previous=(await sql.query('SELECT * FROM paid_periods WHERE account_id=$1 AND subscription_id=$2 AND period_start=$3',[account.account_id,subscription.id,new Date(line.start*1000)])).rows[0];
          if(previous&&(previous.plan!==plan||(previous.period_end as Date).getTime()!==line.end*1000))throw new Error('Conflicting paid period.');
          if(!previous) {
            const overlap=(await sql.query("SELECT id FROM credit_grants WHERE account_id=$1 AND plan<>'free' AND starts_at < $2 AND expires_at > $3 LIMIT 1",[account.account_id,new Date(line.end*1000),new Date(line.start*1000)])).rows;
            if(overlap.length)throw new Error('Overlapping paid periods require billing review.');
            await creditLedger(sql,now,newId).grant({accountId:String(account.account_id),source,plan,startsAt:new Date(line.start*1000),expiresAt:new Date(line.end*1000)});
            await sql.query('INSERT INTO paid_periods(invoice_id,account_id,subscription_id,period_start,period_end,plan,grant_source) VALUES($1,$2,$3,$4,$5,$6,$7)',[invoice.id,account.account_id,subscription.id,new Date(line.start*1000),new Date(line.end*1000),plan,source]);
          }
        }
        await sql.query("UPDATE billing_inbox SET state='done',processed_at=$2,last_error=NULL WHERE event_id=$1",[id,now()]);
      });
      return true;
    } catch(error) {
      await db.query("UPDATE billing_inbox SET attempts=attempts+1,last_error='billing-processing-unavailable',retry_at=$2 WHERE event_id=$1 AND state='queued'",[id,new Date(now().getTime()+60000)]);
      throw error;
    } finally {await db.query('DELETE FROM billing_leases WHERE customer_id=$1 AND owner=$2',[lockKey,owner]);}
  }
  async function recover() {
    const rows=(await db.query("SELECT event_id FROM billing_inbox WHERE state='queued' AND retry_at <= $1 ORDER BY received_at LIMIT 100",[now()])).rows;
    let processed=0,failed=0;
    for(const row of rows)try {if(await process(String(row.event_id)))processed++;}catch {failed++;}
    return {processed,failed};
  }
  return {receive,process,recover};
}
export type BillingLifecycle=ReturnType<typeof billingLifecycle>;
