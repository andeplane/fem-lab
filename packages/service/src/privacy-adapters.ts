import type {Storage} from '@google-cloud/storage';
import type {Auth} from 'firebase-admin/auth';
import type Stripe from 'stripe';
import type {ExportObjects,PrivacyIdentity,PrivacyPayments} from './privacy';
export function exportObjects(storage:Storage,bucketName:string):ExportObjects {
  const bucket=storage.bucket(bucketName);
  return {
    async write(name,json,expires){await bucket.file(name).save(json,{resumable:false,timeout:10000,contentType:'application/json',metadata:{cacheControl:'private,no-store',metadata:{expiresAt:expires.toISOString()}}})},
    async url(name,expires){const [url]=await bucket.file(name).getSignedUrl({version:'v4',action:'read',expires,responseDisposition:'attachment; filename="femlab-account.json"',responseType:'application/json'});return url},
    async remove(name){await bucket.file(name).delete({ignoreNotFound:true})},
  };
}
export function privacyIdentity(auth:Auth):PrivacyIdentity{return{async remove(uid){try{await auth.deleteUser(uid)}catch(error){if((error as {code?:string}).code!=='auth/user-not-found')throw error}}}}
/** Canonical customer ownership is checked again; cancellation keys survive job retries. */
export function privacyPayments(client:Stripe,projectId:string):PrivacyPayments {
  return {async stopRenewal(accountId,customerId,key){
    const customers=customerId?[await client.customers.retrieve(customerId)]:
      (await client.customers.search({query:`metadata['femlab_account_id']:'${accountId}' AND metadata['femlab_project']:'${projectId}'`,limit:100})).data;
    if(customers.length>1)throw new Error('Customer deletion requires billing review.');
    for(const customer of customers){if(customer.deleted)continue;
      if(customer.metadata.femlab_account_id!==accountId||customer.metadata.femlab_project!==projectId)throw new Error('Payment customer ownership mismatch.');
      let count=0;
      for await(const session of client.checkout.sessions.list({customer:customer.id,status:'open',limit:100})){if(++count>1000)throw new Error('Too many open checkout sessions.');await client.checkout.sessions.expire(session.id,{},{idempotencyKey:`${key}:expire:${session.id}`})}
      count=0;
      for await(const sub of client.subscriptions.list({customer:customer.id,status:'all',limit:100})){
        if(++count>1000)throw new Error('Too many subscriptions.');if(['canceled','incomplete_expired'].includes(sub.status))continue;
        const schedule=typeof sub.schedule==='string'?sub.schedule:sub.schedule?.id;
        if(schedule)await client.subscriptionSchedules.release(schedule,{},{idempotencyKey:`${key}:release:${schedule}`});
        if(['active','trialing'].includes(sub.status))await client.subscriptions.update(sub.id,{cancel_at_period_end:true},{idempotencyKey:`${key}:cancel:${sub.id}`});
        else await client.subscriptions.cancel(sub.id,{invoice_now:false,prorate:false},{idempotencyKey:`${key}:cancel:${sub.id}`});
        const confirmed=await client.subscriptions.retrieve(sub.id);if(!confirmed.cancel_at_period_end&&confirmed.status!=='canceled')throw new Error('Subscription cancellation is not confirmed.');
      }
      await client.customers.update(customer.id,{email:'',name:'',phone:'',address:'',shipping:''},{idempotencyKey:`${key}:contact`});
    }
  }};
}
