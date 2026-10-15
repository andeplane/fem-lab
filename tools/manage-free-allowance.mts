import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {freeEmailFingerprint,manageFreeEligibility} from '../packages/service/src/free-eligibility.ts';
import {ServiceFailure} from '../packages/service/src/errors.ts';
const [action,accountId,reference]=process.argv.slice(2);
const db=new pg.Pool({max:1,connectionTimeoutMillis:10000});
try{
  if(!['approve','revoke','rebind'].includes(action??'')||!accountId||!reference||process.argv.length!==5)throw new Error('Invalid operator arguments.');
  const key=process.env.FREE_ELIGIBILITY_HMAC_KEY;
  const result=await manageFreeEligibility(db,action as 'approve'|'revoke'|'rebind',accountId,reference,()=>new Date(),randomUUID,key?freeEmailFingerprint(key):undefined);
  console.log(JSON.stringify(result));
}catch(error){console.error(JSON.stringify({code:error instanceof ServiceFailure?error.code:'eligibility-operation-unavailable',cause:'Eligibility update did not complete. No credentials or identity fingerprints are logged.'}));process.exitCode=1;}
finally{await db.end();}
