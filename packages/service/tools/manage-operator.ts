/** Invoked only by the authenticated operator launcher; never by a public route. */
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {debitAdjustment} from '../src/ledger';
import {suspendAccount} from '../src/administration';
import {ServiceFailure} from '../src/errors';

const [action,accountId,rawOperationId,reasonRef,grantId,subcredits]=process.argv.slice(2);
const operationId=rawOperationId?.toLowerCase();
const actorRef=process.env.FEMLAB_OPERATOR_ACTOR_REF??'';
const db=new pg.Pool({max:1,connectionTimeoutMillis:5000,statement_timeout:5000});
try{
  if(!['debit','suspend'].includes(action??'')||!accountId||!operationId||!reasonRef||!/^[-a-zA-Z0-9._]{1,64}$/.test(reasonRef)||!/^[a-f0-9]{64}$/.test(actorRef)||!(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i).test(operationId))throw new Error('Invalid authenticated operator input.');
  let result:unknown;
  if(action==='debit'){
    if(!grantId||!subcredits||process.argv.length!==8)throw new Error('Invalid debit arguments.');
    result=await debitAdjustment(db,{accountId,grantId,subcredits,idempotencyId:operationId,actorRef,reasonRef},()=>new Date());
  }else{
    if(process.argv.length!==6)throw new Error('Invalid suspension arguments.');
    const token=process.env.FEMLAB_OPERATOR_ACCESS_TOKEN,projectId=process.env.FIREBASE_PROJECT_ID;
    if(!token||!['femlab-app','femlab-app-staging'].includes(projectId??''))throw new Error('Missing verified operator credential.');
    const {initializeApp,deleteApp}=await import('firebase-admin/app');
    const {getAuth}=await import('firebase-admin/auth');
    const app=initializeApp({projectId,credential:{async getAccessToken(){return {access_token:token,expires_in:300};}}},'operator-'+randomUUID());
    try{result=await suspendAccount(db,getAuth(app),accountId);}finally{await deleteApp(app);}
  }
  process.stdout.write(JSON.stringify({event:'operator-action',action,operationId,actorRef,reasonRef,result})+'\n');
}catch(error){
  process.stdout.write(JSON.stringify({event:'operator-action',action,operationId,actorRef,reasonRef,code:error instanceof ServiceFailure?error.code:'operator-action-unavailable',cause:'The operator action did not fully complete. Private diagnostics are suppressed.',...(error instanceof ServiceFailure&&error.details?{details:error.details}:{})})+'\n');process.exitCode=1;
}finally{await db.end();}
