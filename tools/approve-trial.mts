import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {approveTrial} from '../packages/service/src/trials.ts';
const [accountId, approval] = process.argv.slice(2);
if (!accountId || !approval || process.argv.length !== 4) throw new Error('Usage: approve-trial.mts ACCOUNT_UUID APPROVAL_REFERENCE');
const db = new pg.Pool({max: 1, connectionTimeoutMillis: 10000});
try { console.log(JSON.stringify(await approveTrial(db, accountId, approval, () => new Date(), randomUUID))); }
finally { await db.end(); }
