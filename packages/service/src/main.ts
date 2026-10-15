import { Storage } from '@google-cloud/storage';
import { accountPrivacy } from './privacy';
import { exportObjects, privacyIdentity, privacyPayments } from './privacy-adapters';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import pg from 'pg';
import OpenAI from 'openai';
import Stripe from 'stripe';
import { accountReader, postgresAccounts } from './accounts';
import { identityVerifier } from './identity';
import { migrate } from './migrations';
import { creditLedger } from './ledger';
import { reservations } from './reservations';
import { completionService } from './completions';
import { openaiGateway } from './provider';
import {billingMerchantMode,billingTaxMode,stripeGateway,stripePayments} from './stripe';
import {billingLifecycle} from './billing';
import {checkoutService} from './checkout';
import { serviceServer } from './http.js';
import {freeEmailFingerprint} from './free-eligibility';
import {monthlyFreeAllowance} from './free-allowance';

const port = Number(process.env.PORT ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
// Subsequent service slices inject the verified identity, database and provider adapters.
// Until they are wired, the process is live but explicitly not ready for inference.
const projectId = process.env.FIREBASE_PROJECT_ID;
const pool = projectId ? new pg.Pool({ max: 8, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 }) : undefined;
const now = () => new Date();
const fingerprint=process.env.FREE_ELIGIBILITY_HMAC_KEY?freeEmailFingerprint(process.env.FREE_ELIGIBILITY_HMAC_KEY):undefined;
const auth=projectId?getAuth(initializeApp({projectId})):undefined;

const prices={plus:process.env.STRIPE_PRICE_PLUS??'',pro:process.env.STRIPE_PRICE_PRO??'',studio:process.env.STRIPE_PRICE_STUDIO??''};
const purchasePrices={
  plus:{personal:process.env.STRIPE_PRICE_PLUS_PERSONAL??'',business:process.env.STRIPE_PRICE_PLUS_BUSINESS??''},
  pro:{personal:process.env.STRIPE_PRICE_PRO_PERSONAL??'',business:process.env.STRIPE_PRICE_PRO_BUSINESS??''},
  studio:{personal:process.env.STRIPE_PRICE_STUDIO_PERSONAL??'',business:process.env.STRIPE_PRICE_STUDIO_BUSINESS??''},
};
const billingMode=process.env.BILLING_MODE==='live'?'live':'test';
const billingEnabled=process.env.BILLING_ENABLED==='true';
const taxMode=billingTaxMode(process.env.BILLING_TAX_MODE,billingEnabled);
const merchantMode=billingMerchantMode(process.env.BILLING_MERCHANT_MODE,billingEnabled,taxMode);
const stripeKey=process.env.STRIPE_SECRET_KEY;
const stripe=stripeKey&&new RegExp(`^(sk|rk)_${billingMode}_`).test(stripeKey)?new Stripe(stripeKey,{timeout:5000,maxNetworkRetries:1}):undefined;
const billing=pool&&stripe&&process.env.STRIPE_WEBHOOK_SECRET&&Object.values(prices).every(price=>/^price_[a-zA-Z0-9_]+$/.test(price))?
  billingLifecycle(pool,stripeGateway(stripe,process.env.STRIPE_WEBHOOK_SECRET),{live:process.env.BILLING_MODE==='live',prices,purchasePrices},now,randomUUID):undefined;
const privacy=pool&&auth&&projectId&&process.env.EXPORT_BUCKET?accountPrivacy({db:pool,account:accountReader(identityVerifier(auth,projectId,now),postgresAccounts(pool,now,randomUUID)),recentIdentity:identityVerifier(auth,projectId,now,{maxAuthenticationAge:300}),objects:exportObjects(new Storage({projectId,retryOptions:{maxRetries:2,totalTimeout:30}}),process.env.EXPORT_BUCKET),identity:privacyIdentity(auth),payments:stripe?privacyPayments(stripe,projectId):undefined,now,newId:randomUUID}):undefined;
if (process.argv.includes('--migrate')) {
  if (!pool) throw new Error('FIREBASE_PROJECT_ID and database connection must be configured.');
  const directory = new URL('./migrations/', import.meta.url);
  const migrations = await Promise.all((await readdir(directory)).filter(name => name.endsWith('.sql')).sort()
    .map(async name => ({ name, sql: await readFile(new URL(name, directory), 'utf8') })));
  const connection = await pool.connect();
  try { await migrate(connection, migrations); } finally { connection.release(); await pool.end(); }
} else if(process.argv.includes('--recover')) {
  if(!pool) throw new Error('Recovery requires a configured database.');
  try {
    // store:false does not archive Responses for retrieval. Unknown usage is resolved conservatively.
    const result=await reservations(pool,now,randomUUID,fingerprint).recover(async()=>undefined);
    process.stdout.write(JSON.stringify({event:'usage-recovery',...result})+'\n');
    if(privacy){const result=await privacy.recover();process.stdout.write(JSON.stringify({event:'privacy-recovery',severity:result.failed?'ERROR':'INFO',...result})+'\n');if(result.failed)process.exitCode=1;}
    if(billing){const payments=await billing.recover();process.stdout.write(JSON.stringify({event:'billing-recovery',severity:payments.failed?'ERROR':'INFO',...payments})+'\n');if(payments.failed)process.exitCode=1;}
    if(stripe&&billing&&projectId&&process.env.STRIPE_PORTAL_CONFIGURATION&&process.env.APP_RETURN_ORIGIN) {
      const plans=await checkoutService(pool,stripePayments(stripe,process.env.STRIPE_PORTAL_CONFIGURATION,projectId,taxMode,merchantMode),{live:billingMode==='live',prices,purchasePrices,merchantMode,taxMode,projectId,enabled:billingEnabled,appOrigin:process.env.APP_RETURN_ORIGIN},async()=>{throw new Error('Interactive authentication is not available in a job.');},now,randomUUID).recover();
      process.stdout.write(JSON.stringify({event:'plan-change-recovery',severity:plans.failed?'ERROR':'INFO',...plans})+'\n');if(plans.failed)process.exitCode=1;
    }
  } finally { await pool.end(); }
} else {
  const readAccount = pool && projectId ? accountReader(identityVerifier(auth!, projectId, now), postgresAccounts(pool, now, randomUUID)) : undefined;
  const payments=pool&&stripe&&billing&&readAccount&&projectId&&process.env.STRIPE_PORTAL_CONFIGURATION&&process.env.APP_RETURN_ORIGIN?
    checkoutService(pool,stripePayments(stripe,process.env.STRIPE_PORTAL_CONFIGURATION,projectId,taxMode,merchantMode),{live:process.env.BILLING_MODE==='live',prices,purchasePrices,merchantMode,taxMode,projectId,enabled:billingEnabled,appOrigin:process.env.APP_RETURN_ORIGIN},readAccount,now,randomUUID):undefined;
  const ledger = pool ? creditLedger(pool, now, randomUUID,fingerprint) : undefined;
  const holds=pool?reservations(pool,now,randomUUID,fingerprint):undefined;
  const freeAllowance=pool&&readAccount?monthlyFreeAllowance(pool,readAccount,now,randomUUID,fingerprint):undefined;
  const provider=process.env.OPENAI_API_KEY?openaiGateway(new OpenAI({apiKey:process.env.OPENAI_API_KEY,baseURL:'https://api.openai.com/v1',maxRetries:0,timeout:900000})):undefined;
  const completions=readAccount&&ledger&&holds&&provider?completionService({account:readAccount,ledger,reservations:holds,provider}):undefined;
  const account = readAccount && ledger ? async (authorization: string | undefined) => {
    const owner = await readAccount(authorization);
    const status=await payments?.status(owner.id);
    return { ...owner, usage: await ledger.balance(owner.id),freeAllowance:await freeAllowance?.status(owner.id), billingAvailable:billingEnabled&&Boolean(payments),billing:status?{...status,merchantMode}:undefined };
  } : undefined;
  const server = serviceServer({ now, newId: randomUUID, account,completions,billing,payments,privacy,freeAllowance,
    heartbeat(callback){const timer=setInterval(callback,15000); return()=>clearInterval(timer);},
    origins: (process.env.APP_ORIGINS ?? '').split(',').filter(Boolean),
    ready: async () => { if (!pool||!completions||!privacy||!fingerprint) return false; const versions=await pool.query("SELECT name FROM service_migrations WHERE name='010-free-monthly-allowance.sql'"); return versions.rowCount===1; },
  });
  server.listen(port, '0.0.0.0');
  server.requestTimeout=120000; server.headersTimeout=30000;
  process.once('SIGTERM', () => { server.close(() => { void pool?.end(); }); });
}
