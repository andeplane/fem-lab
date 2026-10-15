import {z} from 'zod';
import type {Account} from './accounts';
import type {BillingConfig} from './billing';
import {PLANS,type PlanId} from './credits';
import {ServiceFailure} from './errors';
import {transaction,type Database} from './transactions';
import {billingPrices,type PurchaseUse} from './billing-prices';
import type {BillingMerchantMode,BillingTaxMode} from './stripe';

export const PlanChangeInput=z.strictObject({plan:z.enum(['plus','pro','studio'])});
export const CheckoutInput=PlanChangeInput.extend({purchaseUse:z.enum(['personal','business']).optional()});
export type PaidPlan=Exclude<PlanId,'free'>;
export interface PaymentPrice {id:string;active:boolean;currency:string;amount:number|null;interval:string|null;intervalCount:number|null}
export interface PaymentSession {id:string;url:string|null;expiresAt:number;status:string|null}
/** The payment provider confirmed expiry validation failed before a Session was created. */
export class CheckoutNotCreated extends Error {}
export interface PaymentSubscription {id:string;customerId:string;status:string;priceId:string;start:number;end:number;scheduleId:string|null}
export interface Payments {
  customer(account:Account,key:string):Promise<string>;
  price(id:string):Promise<PaymentPrice>;
  subscriptions(customer:string):Promise<PaymentSubscription[]>;
  checkout(input:{customer:string;price:string;accountId:string;successUrl:string;cancelUrl:string;expiresAt:number;key:string}):Promise<PaymentSession>;
  session(id:string):Promise<PaymentSession>;
  portal(customer:string,returnUrl:string):Promise<string>;
  /** Persist the provider-owned schedule identity before its first update. */
  schedule(subscription:PaymentSubscription,price:string,key:string,receipt:(id:string)=>Promise<void>):Promise<string>;
}
export interface CheckoutConfig extends BillingConfig {enabled:boolean;appOrigin:string;merchantMode:BillingMerchantMode;taxMode:BillingTaxMode;projectId:string}
// Bump for fixed wire, SDK/API version or header changes (including integration_identifier).
const CHECKOUT_REQUEST_VERSION=1;
const PLAN_CHANGE_REQUEST_VERSION=2;
function redirect(url:string|null,allowed:string):string {
  if(!url)throw new Error('Missing payment redirect.');
  const parsed=new URL(url);
  if(parsed.origin!==`https://${allowed}`||parsed.username||parsed.password)throw new Error('Untrusted payment redirect.');
  return url;
}
/** A server-owned customer and one durable checkout intent; callbacks alone never grant credits. */
export function checkoutService(db:Database,payments:Payments,config:CheckoutConfig,account:(header:string|undefined)=>Promise<Account>,now:()=>Date,newId:()=>string) {
  const catalog=billingPrices(config);
  const origin=new URL(config.appOrigin);
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('Payment return origin must be a configured HTTPS origin.');
  const returnUrl=origin.href;
  async function owner(header:string|undefined) {
    if(!config.enabled)throw new ServiceFailure(503,'billing-unavailable','Paid plans are not available yet.','billing');
    return account(header);
  }
  async function priced(plan:PaidPlan,use:PurchaseUse|null=null) {
    const selected=catalog.select(plan,use);
    if(!selected)throw new ServiceFailure(503,'price-unavailable','This plan is temporarily unavailable for the selected use.','billing');
    const price=await payments.price(selected);
    if(price.id!==selected||!price.active||price.currency!=='usd'||price.amount!==PLANS[plan].priceUsd*100||price.interval!=='month'||price.intervalCount!==1)throw new ServiceFailure(503,'price-unavailable','This plan is temporarily unavailable.','billing');
    return price.id;
  }
  async function customer(owner:Account):Promise<string> {
    const previous=(await db.query('SELECT customer_id,blocked FROM billing_accounts WHERE account_id=$1',[owner.id])).rows[0];
    if(previous?.blocked)throw new ServiceFailure(409,'billing-review','Your billing account needs review before changing a plan.','billing','account.open');
    if(previous)return String(previous.customer_id);
    const id=await payments.customer(owner,`femlab-customer:${owner.id}`);
    if(!/^cus_[a-zA-Z0-9_]+$/.test(id))throw new Error('Invalid payment customer.');
    await db.query('INSERT INTO billing_accounts(account_id,customer_id,updated_at) VALUES($1,$2,$3) ON CONFLICT(account_id) DO NOTHING',[owner.id,id,now()]);
    const actual=(await db.query('SELECT customer_id FROM billing_accounts WHERE account_id=$1',[owner.id])).rows[0];
    if(actual?.customer_id!==id)throw new Error('Customer creation conflict.');
    return id;
  }
  async function lock<T>(accountId:string,operation:()=>Promise<T>):Promise<T> {
    const key=`checkout:${accountId}`,id=newId();
    const result=await db.query(`INSERT INTO billing_leases(customer_id,owner,expires_at) VALUES($1,$2,$3)
      ON CONFLICT(customer_id) DO UPDATE SET owner=EXCLUDED.owner,expires_at=EXCLUDED.expires_at WHERE billing_leases.expires_at <= $4 RETURNING owner`,[key,id,new Date(now().getTime()+120000),now()]);
    if(!result.rows.length)throw new ServiceFailure(409,'billing-operation-pending','A billing action is already running. Try again shortly.','billing');
    try{if((await db.query('SELECT status FROM accounts WHERE id=$1',[accountId])).rows[0]?.status!=='active')throw new ServiceFailure(403,'account-inactive','This account is being deleted.','account');return await operation();}finally{await db.query('DELETE FROM billing_leases WHERE customer_id=$1 AND owner=$2',[key,id]);}
  }
  async function subscription(customerId:string) {
    const subscriptions=(await payments.subscriptions(customerId)).filter(row=>!['canceled','incomplete_expired'].includes(row.status));
    if(subscriptions.some(row=>row.customerId!==customerId)||subscriptions.length>1)throw new ServiceFailure(409,'billing-review','Your billing account needs review before changing a plan.','billing');
    return subscriptions[0];
  }
  function sourceMatches(row:Record<string,unknown>,current:PaymentSubscription):boolean {
    return row.source_subscription_id===current.id&&row.source_price_id===current.priceId&&
      row.source_period_start instanceof Date&&row.source_period_start.getTime()===current.start*1000&&
      row.effective_at instanceof Date&&row.effective_at.getTime()===current.end*1000&&
      (row.source_schedule_id!==null?row.source_schedule_id===current.scheduleId:row.schedule_id===null||row.schedule_id===current.scheduleId);
  }
  async function scheduleChange(row:Record<string,unknown>,current:PaymentSubscription,price:string):Promise<void> {
    if(!sourceMatches(row,current))throw new ServiceFailure(409,'plan-change-review','The original subscription settings changed. Billing support must review this plan change.','billing','account.open');
    // When creation lost its response, replay the original from_subscription key;
    // never adopt an arbitrary newly attached schedule as the update target.
    const frozen={...current,scheduleId:(row.schedule_id??row.source_schedule_id) as string|null};
    let received=false;
    const scheduleId=await payments.schedule(frozen,price,`femlab-plan:${row.operation_id}`,async id=>{
      if(!/^sub_sched_[a-zA-Z0-9_]+$/.test(id)||(current.scheduleId!==null&&current.scheduleId!==id))
        throw new ServiceFailure(409,'plan-change-review','The subscription schedule changed. Billing support must review this plan change.','billing','account.open');
      const saved=await db.query("UPDATE plan_changes SET schedule_id=$2,updated_at=$3 WHERE account_id=$1 AND operation_id=$4 AND state='pending' AND (schedule_id IS NULL OR schedule_id=$2) RETURNING schedule_id",[row.account_id,id,now(),row.operation_id]);
      if(!saved.rows.length)throw new Error('Plan change schedule receipt conflict.');
      received=true;
    });
    if(!received)throw new Error('Missing durable schedule receipt.');
    await db.query("UPDATE plan_changes SET state='complete',updated_at=$3 WHERE account_id=$1 AND operation_id=$4 AND schedule_id=$2",[row.account_id,scheduleId,now(),row.operation_id]);
  }
  return {
    async checkout(header:string|undefined,body:unknown) {
      const caller=await owner(header),parsed=CheckoutInput.safeParse(body);
      if(!parsed.success)throw new ServiceFailure(422,'invalid-plan','Choose a supported plan.','billing');
      const use=parsed.data.purchaseUse??null;
      if(config.merchantMode==='managed'&&!use)throw new ServiceFailure(422,'purchase-use-required','Choose personal or business use before starting checkout.','billing','account.open');
      return lock(caller.id,async()=>{
        const price=await priced(parsed.data.plan,use),customerId=await customer(caller);
        if(await subscription(customerId))throw new ServiceFailure(409,'subscription-exists','Use your account to schedule a plan change or manage the current subscription.','billing','account.open');
        const paid=(await db.query("SELECT id FROM credit_grants WHERE account_id=$1 AND plan<>'free' AND expires_at>$2 LIMIT 1",[caller.id,now()])).rows;
        if(paid.length)throw new ServiceFailure(409,'paid-period-active','Your paid allowance lasts until its period ends. Schedule changes through your account.','billing','account.open');
        let intent=(await db.query('SELECT * FROM checkout_intents WHERE account_id=$1',[caller.id])).rows[0];
        if(intent&&intent.expires_at as Date > now()) {
          if(intent.request_version!==CHECKOUT_REQUEST_VERSION||intent.plan!==parsed.data.plan||intent.price_id!==price||intent.purchase_use!==use||
            intent.merchant_mode!==config.merchantMode||intent.tax_mode!==config.taxMode||intent.return_origin!==returnUrl||intent.customer_id!==customerId||intent.project_id!==config.projectId)
            throw new ServiceFailure(409,'checkout-open',`Checkout retains its original purchase settings until ${(intent.expires_at as Date).toISOString()}. Complete it or wait before changing use or plan.`,'billing','account.open');
          if(intent.session_id) {
            const existing=await payments.session(String(intent.session_id));
            if(existing.status==='open'&&existing.expiresAt*1000>now().getTime())return {url:redirect(existing.url,'checkout.stripe.com')};
            if(existing.status==='complete')throw new ServiceFailure(409,'checkout-completed','Payment is processing. Refresh your account for the allowance.','billing','account.refresh');
            intent=undefined;
          }
        } else intent=undefined;
        for(let retry=0;;retry++) {
          if(!intent) {
            const id=newId();
            await db.query(`INSERT INTO checkout_intents(account_id,id,plan,expires_at,created_at,request_version,price_id,purchase_use,merchant_mode,tax_mode,return_origin,customer_id,project_id)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
              ON CONFLICT(account_id) DO UPDATE SET id=EXCLUDED.id,plan=EXCLUDED.plan,session_id=NULL,session_url=NULL,expires_at=EXCLUDED.expires_at,created_at=EXCLUDED.created_at,
              request_version=EXCLUDED.request_version,price_id=EXCLUDED.price_id,purchase_use=EXCLUDED.purchase_use,merchant_mode=EXCLUDED.merchant_mode,tax_mode=EXCLUDED.tax_mode,
              return_origin=EXCLUDED.return_origin,customer_id=EXCLUDED.customer_id,project_id=EXCLUDED.project_id`,[caller.id,id,parsed.data.plan,new Date(now().getTime()+1860000),now(),CHECKOUT_REQUEST_VERSION,price,use,config.merchantMode,config.taxMode,returnUrl,customerId,config.projectId]);
            intent=(await db.query('SELECT * FROM checkout_intents WHERE account_id=$1',[caller.id])).rows[0]!;
          }
          let session:PaymentSession;
          try {
            session=await payments.checkout({customer:customerId,price,accountId:caller.id,successUrl:returnUrl+'?billing=success',cancelUrl:returnUrl+'?billing=canceled',expiresAt:Math.floor((intent.expires_at as Date).getTime()/1000),key:`femlab-checkout:${intent.id}`});
          } catch(error) {
            // An uncertain result must keep its original key AND parameters for provider replay.
            if(!(error instanceof CheckoutNotCreated))throw error;
            const removed=await db.query('DELETE FROM checkout_intents WHERE account_id=$1 AND id=$2 AND session_id IS NULL RETURNING id',[caller.id,intent.id]);
            if(!removed.rows.length||retry===1)throw new ServiceFailure(503,'checkout-unavailable','Checkout could not start. Try again shortly.','billing','account.open');
            intent=undefined;
            continue;
          }
          const url=redirect(session.url,'checkout.stripe.com');
          await db.query('UPDATE checkout_intents SET session_id=$2,session_url=$3,expires_at=$4 WHERE account_id=$1 AND id=$5',[caller.id,session.id,url,new Date(session.expiresAt*1000),intent.id]);
          return {url};
        }
      });
    },
    async portal(header:string|undefined,body:unknown={}) {
      const caller=await owner(header);
      if(!z.strictObject({}).safeParse(body).success)throw new ServiceFailure(422,'invalid-billing-request','This billing action accepts no customer or return-location overrides.','billing');
      const mapping=(await db.query('SELECT customer_id FROM billing_accounts WHERE account_id=$1',[caller.id])).rows[0];
      if(!mapping)throw new ServiceFailure(409,'no-subscription','Choose a paid plan before opening subscription management.','billing','account.open');
      return {url:redirect(await payments.portal(String(mapping.customer_id),returnUrl),'billing.stripe.com')};
    },
    async change(header:string|undefined,body:unknown) {
      const caller=await owner(header),parsed=PlanChangeInput.safeParse(body);
      if(!parsed.success)throw new ServiceFailure(422,'invalid-plan','Choose a supported plan.','billing');
      return lock(caller.id,async()=>{
        const customerId=await customer(caller),current=await subscription(customerId);
        if(!current||current.status!=='active')throw new ServiceFailure(409,'no-active-subscription','An active paid subscription is required to schedule a change.','billing');
        const selection=catalog.get(current.priceId);
        if(!selection)throw new ServiceFailure(409,'subscription-use-unknown','This subscription needs review before changing plans. Manage it through billing support.','billing','account.open');
        const use=selection.purchaseUse,price=await priced(parsed.data.plan,use);
        const effectiveAt=new Date(current.end*1000);
        if(effectiveAt<=now())throw new ServiceFailure(409,'period-changing','Your billing period is changing. Refresh and try again.','billing','account.refresh');
        const operation=await transaction(db,async sql=>{
          const previous=(await sql.query('SELECT * FROM plan_changes WHERE account_id=$1',[caller.id])).rows[0];
          if(previous?.plan===parsed.data.plan&&(previous.effective_at as Date).getTime()===effectiveAt.getTime()) {
            if(previous.request_version!==PLAN_CHANGE_REQUEST_VERSION||previous.price_id!==price||previous.purchase_use!==use||!sourceMatches(previous,current))throw new ServiceFailure(409,'plan-change-review','The original scheduled purchase settings need review before retrying.','billing','account.open');
            return previous;
          }
          const id=newId();
          await sql.query(`INSERT INTO plan_changes(account_id,plan,effective_at,operation_id,state,updated_at,price_id,purchase_use,request_version,source_subscription_id,source_price_id,source_period_start,source_schedule_id) VALUES($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9,$10,$11,$12)
            ON CONFLICT(account_id) DO UPDATE SET plan=EXCLUDED.plan,effective_at=EXCLUDED.effective_at,operation_id=EXCLUDED.operation_id,state='pending',schedule_id=NULL,updated_at=EXCLUDED.updated_at,
            price_id=EXCLUDED.price_id,purchase_use=EXCLUDED.purchase_use,request_version=EXCLUDED.request_version,source_subscription_id=EXCLUDED.source_subscription_id,
            source_price_id=EXCLUDED.source_price_id,source_period_start=EXCLUDED.source_period_start,source_schedule_id=EXCLUDED.source_schedule_id`,[caller.id,parsed.data.plan,effectiveAt,id,now(),price,use,PLAN_CHANGE_REQUEST_VERSION,current.id,current.priceId,new Date(current.start*1000),current.scheduleId]);
          return (await sql.query('SELECT * FROM plan_changes WHERE account_id=$1',[caller.id])).rows[0]!;
        });
        if(operation.state!=='complete') {
          await scheduleChange(operation,current,price);
        }
        return {plan:parsed.data.plan,effectiveAt:effectiveAt.toISOString()};
      });
    },
    async status(accountId:string) {
      const mapping=(await db.query('SELECT subscription_status,cancel_at_period_end,period_end,blocked FROM billing_accounts WHERE account_id=$1',[accountId])).rows[0];
      const change=(await db.query("SELECT plan,effective_at,state FROM plan_changes WHERE account_id=$1 AND (effective_at>$2 OR state='pending')",[accountId,now()])).rows[0];
      return {available:config.enabled,status:mapping?.subscription_status??'none',cancelAtPeriodEnd:Boolean(mapping?.cancel_at_period_end),periodEndsAt:(mapping?.period_end as Date|undefined)?.toISOString()??null,reviewRequired:Boolean(mapping?.blocked),scheduledPlan:change?{plan:change.plan,effectiveAt:(change.effective_at as Date).toISOString(),processing:change.state==='pending'}:null};
    },
    async recover() {
      if(!config.enabled)return {processed:0,failed:0};
      const rows=(await db.query("SELECT p.*,b.customer_id FROM plan_changes p JOIN accounts a ON a.id=p.account_id JOIN billing_accounts b ON b.account_id=p.account_id WHERE p.state='pending' AND a.status='active' AND NOT b.blocked ORDER BY p.updated_at LIMIT 100")).rows;
      let processed=0,failed=0;
      for(const row of rows)try {
        await lock(String(row.account_id),async()=>{
          const fresh=(await db.query("SELECT operation_id,state FROM plan_changes WHERE account_id=$1",[row.account_id])).rows[0];
          if(!fresh||fresh.operation_id!==row.operation_id||fresh.state!=='pending')return;
          const current=await subscription(String(row.customer_id));
          if(!current||current.status!=='active'||current.end*1000!==(row.effective_at as Date).getTime()||current.end*1000<=now().getTime())throw new Error('Plan change needs review after its original period.');
          const selection=catalog.get(current.priceId);
          if(row.request_version!==PLAN_CHANGE_REQUEST_VERSION||!selection||row.purchase_use!==selection.purchaseUse||row.price_id!==catalog.select(row.plan as PaidPlan,selection.purchaseUse)||!sourceMatches(row,current))throw new Error('Plan change purchase settings require review.');
          const price=await priced(row.plan as PaidPlan,selection.purchaseUse);
          await scheduleChange(row,current,price);processed++;
        });
      }catch{failed++;}
      return {processed,failed};
    },
  };
}
export type CheckoutService=ReturnType<typeof checkoutService>;
