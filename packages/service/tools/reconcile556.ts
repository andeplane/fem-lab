/** Operator-only, disposable Cloud SQL recovery drill using actual Stripe TEST reads.
 * Not a production entry point. Generated QA inbox envelopes are not signed webhooks.
 */
import {createHash,randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import Stripe from 'stripe';
import {migrate} from '../src/migrations';
import {postgresAccounts} from '../src/accounts';
import {creditLedger} from '../src/ledger';
import {billingLifecycle,type BillingConfig,type BillingEnvelope} from '../src/billing';
import {stripeGateway} from '../src/stripe';

interface Fixture {invoiceId:string;customerId:string;subscriptionId:string;chargeId:string;refundId:string}
interface Configuration {fixtures:Fixture[];catalog:Omit<BillingConfig,'live'>;seedHashes?:Record<string,string>}
class DrillFailure extends Error {constructor(readonly code:string){super(code)}}
const check:(condition:unknown,code:string)=>asserts condition=(condition,code)=>{if(!condition)throw new DrillFailure(code)};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const phase=process.argv[2];let where='guard';
let db:pg.Pool|undefined;
try {
  check(phase==='seed'||phase==='reconcile','invalid-phase');
  check(/^femlab_qa556_financial_[a-z0-9_]+$/.test(process.env.PGDATABASE??''),'dedicated-database-required');
  check(/^qa556_financial_[a-z0-9]+$/.test(process.env.PGUSER??''),'dedicated-role-required');
  const key=process.env.STRIPE_SECRET_KEY??'';
  check(/^(rk|sk)_test_/.test(key),'test-only-credential-required');
  const config=JSON.parse(await readFile(process.env.QA_RECONCILE_CONFIG??'','utf8')) as Configuration;
  check(Array.isArray(config.fixtures)&&config.fixtures.length>0&&config.fixtures.length<=4,'bounded-fixtures-required');
  const reads:string[]=[];
  const client=new Stripe(key,{maxNetworkRetries:0,timeout:15000,httpClient:Stripe.createFetchHttpClient(async(input,init)=>{
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    check(url.origin==='https://api.stripe.com'&&init?.method==='GET','read-only-stripe-boundary');
    reads.push(url.pathname);return fetch(input,init);
  })});
  const gateway=stripeGateway(client,'unused-no-webhook-verification-in-this-drill');
  where='canonical-test-read';
  const canonical=[];
  for(const fixture of config.fixtures){
    const rawInvoice=await client.invoices.retrieve(fixture.invoiceId),rawSub=await client.subscriptions.retrieve(fixture.subscriptionId);
    const charge=await client.charges.retrieve(fixture.chargeId),refund=await client.refunds.retrieve(fixture.refundId);
    check(!rawInvoice.livemode&&!rawSub.livemode&&!charge.livemode,'unexpected-live-object');
    const invoice=await gateway.invoice(fixture.invoiceId),subscription=await gateway.subscription(fixture.subscriptionId);
    const customer=await gateway.chargeCustomer(fixture.chargeId,'charge');
    check(invoice.customerId===fixture.customerId&&subscription.customerId===fixture.customerId&&customer===fixture.customerId,'canonical-customer-mismatch');
    check(invoice.subscriptionId===fixture.subscriptionId&&subscription.id===fixture.subscriptionId,'canonical-subscription-mismatch');
    check(invoice.status==='paid'&&invoice.currency==='usd'&&invoice.lines.length===1,'canonical-paid-invoice-required');
    check(charge.refunded&&refund.status==='succeeded'&&refund.charge===fixture.chargeId,'canonical-refund-required');
    canonical.push({fixture,invoice,subscription});
  }
  where='isolated-database';
  db=new pg.Pool({max:4,connectionTimeoutMillis:5000,statement_timeout:5000});
  check((await db.query('SELECT current_database() AS name')).rows[0].name===process.env.PGDATABASE,'database-binding-mismatch');
  if(phase==='seed'){
    const directory=new URL('../migrations/',import.meta.url);
    const migrations=await Promise.all((await readdir(directory)).filter(name=>name.endsWith('.sql')).sort().map(async name=>({name,sql:await readFile(new URL(name,directory),'utf8')})));
    const connection=await db.connect();try{await migrate(connection,migrations);}finally{connection.release();}
    check((await db.query('SELECT count(*)::int AS n FROM accounts')).rows[0].n===0,'empty-owned-database-required');
    await db.query('UPDATE ai_limits SET enabled=false');
  }
  check((await db.query('SELECT enabled FROM ai_limits')).rows[0].enabled===false,'admissions-must-remain-paused');
  const now=()=>new Date(),ledger=creditLedger(db,now,randomUUID),accounts=postgresAccounts(db,now,randomUUID);
  const billing=billingLifecycle(db,gateway,{live:false,...config.catalog},now,randomUUID);
  const tables=['credit_grants','credit_entries','credit_holds','paid_periods'];
  async function immutableHashes(){
    const result:Record<string,string>={};
    for(const table of tables){
      const rows=(await db!.query(`SELECT row_to_json(t) AS row FROM ${table} t`)).rows.map(row=>JSON.stringify(row.row)).sort();
      result[table]=hash(rows.join('\n'));
    }
    return result;
  }
  async function enqueue(fixture:Fixture,index:number,kind:'invoice.paid'|'invoice.payment_succeeded'|'charge.refunded'|'customer.subscription.updated',tag:string){
    const event:BillingEnvelope={id:`evt_qa556_financial_${tag}_${index}`,type:kind,objectId:kind==='charge.refunded'?fixture.chargeId:kind==='customer.subscription.updated'?fixture.subscriptionId:fixture.invoiceId,customerId:fixture.customerId,live:false};
    // Trusted operator backfill from freshly retrieved canonical TEST object identities.
    // This deliberately bypasses receive/verify; no new signed-webhook delivery is claimed.
    await db!.query(`INSERT INTO billing_inbox(event_id,event_type,object_id,customer_id,digest,live,retry_at,received_at)
      VALUES($1,$2,$3,$4,$5,false,$6,$6) ON CONFLICT(event_id) DO NOTHING`,[event.id,event.type,event.objectId,event.customerId,hash(JSON.stringify(event)),now()]);
  }
  const beforeHashes=phase==='reconcile'?await immutableHashes():undefined;
  if(phase==='reconcile'){
    check(config.seedHashes&&JSON.stringify(beforeHashes)===JSON.stringify(config.seedHashes),'restored-immutable-hash-mismatch');
    check((await db.query('SELECT count(*)::int AS n FROM billing_accounts WHERE blocked')).rows[0].n===0,'snapshot-must-precede-refund-reconciliation');
  }
  where='recover-canonical-inbox';
  for(const [index,{fixture}] of canonical.entries()){
    if(phase==='seed'){
      const uid='qa556-financial-'+hash(fixture.customerId).slice(0,16);
      const owner=await accounts.provision({uid,email:uid+'@example.invalid'});
      await db.query('INSERT INTO billing_accounts(account_id,customer_id,updated_at) VALUES($1,$2,$3)',[owner.id,fixture.customerId,now()]);
      await enqueue(fixture,index,'invoice.paid','paid');
    }else{
      await enqueue(fixture,index,'invoice.payment_succeeded','paid_replay');
      await enqueue(fixture,index,'charge.refunded','refund');
      await enqueue(fixture,index,'customer.subscription.updated','subscription');
    }
  }
  const first=await billing.recover(),second=await billing.recover();
  check(first.failed===0&&second.failed===0&&second.processed===0,'canonical-recovery-failed-or-not-idempotent');
  check((await db.query("SELECT count(*)::int AS n FROM billing_inbox WHERE state='queued'")).rows[0].n===0,'queued-event-remains');
  const expected=config.fixtures.length;
  check((await db.query('SELECT count(*)::int AS n FROM credit_grants')).rows[0].n===expected,'paid-grant-count-mismatch');
  check((await db.query('SELECT count(*)::int AS n FROM paid_periods')).rows[0].n===expected,'paid-period-count-mismatch');
  const afterHashes=await immutableHashes();
  if(phase==='reconcile'){
    check(JSON.stringify(afterHashes)===JSON.stringify(beforeHashes),'reconciliation-mutated-immutable-ledger');
    check((await db.query('SELECT count(*)::int AS n FROM billing_accounts WHERE blocked')).rows[0].n===expected,'canonical-refund-did-not-block');
    check((await db.query('SELECT count(*)::int AS n FROM billing_reviews')).rows[0].n===expected,'refund-review-count-mismatch');
  }
  const balances=[];
  for(const item of canonical){
    const row=(await db.query('SELECT account_id,subscription_id,subscription_status,blocked FROM billing_accounts WHERE customer_id=$1',[item.fixture.customerId])).rows[0];
    check(row.subscription_id===item.subscription.id&&row.subscription_status===item.subscription.status,'canonical-subscription-state-mismatch');
    const balance=await ledger.balance(String(row.account_id),'usd-milli-v1');
    check(phase==='seed'?balance.availableCredits>0:balance.availableCredits===0,'eligible-balance-mismatch');
    balances.push({invoiceHash:hash(item.fixture.invoiceId),chargeHash:hash(item.fixture.chargeId),customerHash:hash(item.fixture.customerId),subscriptionHash:hash(item.fixture.subscriptionId),invoiceStatus:item.invoice.status,currency:item.invoice.currency,amountPaid:item.invoice.amountPaid,periodStart:new Date(item.invoice.lines[0]!.start*1000).toISOString(),periodEnd:new Date(item.invoice.lines[0]!.end*1000).toISOString(),subscriptionStatus:item.subscription.status,refunded:true,blocked:row.blocked,availableCredits:balance.availableCredits,creditUnit:'usd-milli-v1'});
  }
  check((await db.query('SELECT enabled FROM ai_limits')).rows[0].enabled===false,'admissions-reopened');
  process.stdout.write(JSON.stringify({event:'qa556-stripe-recovery',phase,at:now().toISOString(),stripeMode:'test',httpMethods:['GET'],readCount:reads.length,envelopeAuthority:'operator-canonical-backfill-not-signed-webhooks',admissionsPaused:true,firstRecovery:first,secondRecovery:second,paidGrants:expected,paidPeriods:expected,immutableHashes:afterHashes,balances})+'\n');
}catch(error){
  process.stdout.write(JSON.stringify({event:'qa556-stripe-recovery',phase,success:false,where,code:error instanceof DrillFailure?error.code:'canonical-or-database-operation-failed'})+'\n');process.exitCode=1;
}finally{await db?.end();}
