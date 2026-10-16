import {z} from 'zod';
import type {Account,Sql} from './accounts';
import type {Identity} from './identity';
import {ServiceFailure} from './errors';
import {transaction,type Database} from './transactions';
import {PUBLIC_CREDIT_UNIT} from '@femlab/registry';
import {CREDIT_SCALE,PUBLIC_CREDIT_SCALE} from './credits';
import type {CloudProjects} from './cloud-projects';
export interface ExportObjects {write(name:string,json:string,expires:Date):Promise<void>;url(name:string,expires:Date):Promise<string>;remove(name:string):Promise<void>}
export interface PrivacyIdentity {remove(uid:string):Promise<void>}
export interface PrivacyPayments {stopRenewal(accountId:string,customerId:string|null,key:string):Promise<void>}
interface Dependencies {db:Database;account(header:string|undefined):Promise<Account>;recentIdentity(header:string|undefined):Promise<Identity>;objects:ExportObjects;identity:PrivacyIdentity;payments?:PrivacyPayments;projects?:Pick<CloudProjects,'purge'|'metadata'>;now():Date;newId():string}
class PendingDeletion extends Error {}
const active=['preflight','reserved','dispatched','pending_reconciliation'];
/** Durable account jobs hold no prompt, chat, model file, image or export URL. */
export function accountPrivacy(deps:Dependencies) {
  const {db,now,newId}=deps;
  async function lease<T>(accountId:string,operation:()=>Promise<T>):Promise<T>{
    const key=`checkout:${accountId}`,owner=newId(),expires=new Date(now().getTime()+120000);
    const result=await db.query(`INSERT INTO billing_leases(customer_id,owner,expires_at) VALUES($1,$2,$3)
      ON CONFLICT(customer_id) DO UPDATE SET owner=EXCLUDED.owner,expires_at=EXCLUDED.expires_at WHERE billing_leases.expires_at <= $4 RETURNING owner`,[key,owner,expires,now()]);
    if(!result.rows.length)throw new ServiceFailure(409,'account-operation-pending','An account action is already running. Try again shortly.','account');
    try{return await operation()}finally{await db.query('DELETE FROM billing_leases WHERE customer_id=$1 AND owner=$2',[key,owner])}
  }
  async function exportRequest(header:string|undefined,body:unknown) {
    if(!z.strictObject({}).safeParse(body).success)throw new ServiceFailure(422,'invalid-export','Export accepts no account selector.','account');
    const account=await deps.account(header);
    return lease(account.id,async()=>{
      const row=await transaction(db,async sql=>{
        const owner=(await sql.query('SELECT status FROM accounts WHERE id=$1 FOR UPDATE',[account.id])).rows[0];if(owner?.status!=='active')throw new ServiceFailure(403,'account-inactive','This account is being deleted.','account');
        let row=(await sql.query("SELECT * FROM account_exports WHERE account_id=$1 AND state<>'expired'",[account.id])).rows[0];
        if(!row||(row.expires_at as Date)<=now()){
          if(row)await sql.query("UPDATE account_exports SET state='expired' WHERE id=$1",[row.id]);
          row=(await sql.query('INSERT INTO account_exports(id,account_id,created_at,expires_at) VALUES($1,$2,$3,$4) RETURNING *',[newId(),account.id,now(),new Date(now().getTime()+86400000)])).rows[0]!;
        }
        return row;
      });
      if(row.state==='ready'&&row.object_name)return {status:'ready',url:await deps.objects.url(String(row.object_name),new Date(Math.min(now().getTime()+900000,(row.expires_at as Date).getTime())))};
      return {status:'queued'};
    });
  }
  async function deleteRequest(header:string|undefined,body:unknown) {
    if(!z.strictObject({confirm:z.literal('DELETE')}).safeParse(body).success)throw new ServiceFailure(422,'delete-confirmation-required','Type DELETE to request account deletion.','account');
    const identity=await deps.recentIdentity(header);
    const row=(await db.query('SELECT id,status FROM accounts WHERE firebase_uid=$1',[identity.uid])).rows[0];
    if(!row)throw new ServiceFailure(404,'account-not-found','No account exists for this login.','account');
    if(row.status==='deleted')return {status:'complete'};
    await lease(String(row.id),()=>transaction(db,async sql=>{
      await sql.query("UPDATE accounts SET status='deleting',updated_at=$2 WHERE id=$1 AND status='active'",[row.id,now()]);
      await sql.query('INSERT INTO account_deletions(account_id,requested_at,updated_at) VALUES($1,$2,$2) ON CONFLICT(account_id) DO NOTHING',[row.id,now()]);
    }));
    return {status:'queued'};
  }
  async function records(sql:Sql,accountId:string) {
    const account=(await sql.query('SELECT id,email,status,created_at FROM accounts WHERE id=$1',[accountId])).rows[0];
    const tables=['credit_grants','credit_entries','credit_holds','usage_receipts','paid_periods','billing_accounts','billing_reviews','free_eligibilities'] as const;
    const data:Record<string,unknown>={format:'femlab-account/1',exportedAt:now().toISOString(),account,
      creditAccounting:{storedUnit:'subcredit',subcreditsPerLegacyCredit:Number(CREDIT_SCALE),publicCreditUnit:PUBLIC_CREDIT_UNIT,subcreditsPerPublicCredit:Number(PUBLIC_CREDIT_SCALE)}};
    let bytes=0;
    for(const table of tables){const rows=(await sql.query(`SELECT * FROM ${table} WHERE account_id=$1 LIMIT 100001`,[accountId])).rows;if(rows.length>100000)throw new Error('Account export requires support for a larger ledger.');bytes+=Buffer.byteLength(JSON.stringify(rows));if(bytes>32*1024*1024)throw new Error('Account export requires support for a larger ledger.');data[table]=rows}
    data.free_eligibility_identities=(await sql.query('SELECT i.* FROM free_eligibility_identities i JOIN free_eligibilities e ON e.id=i.eligibility_id WHERE e.account_id=$1 LIMIT 100001',[accountId])).rows;
    if((data.free_eligibility_identities as unknown[]).length>100000)throw new Error('Account export requires support for larger eligibility history.');
    data.requests=(await sql.query('SELECT id,model,plan,state,created_at,updated_at FROM ai_requests WHERE account_id=$1 ORDER BY created_at LIMIT 100001',[accountId])).rows;
    if(deps.projects)data.cloud_projects=await deps.projects.metadata(accountId);
    if((data.requests as unknown[]).length>100000)throw new Error('Account export requires support for a larger ledger.');
    const json=JSON.stringify(data);if(Buffer.byteLength(json)>32*1024*1024)throw new Error('Account export requires support for a larger ledger.');return json;
  }
  async function deletion(accountId:string) {
    await lease(accountId,async()=>{
      const row=(await db.query('SELECT d.state,a.firebase_uid,b.customer_id FROM account_deletions d JOIN accounts a ON a.id=d.account_id LEFT JOIN billing_accounts b ON b.account_id=d.account_id WHERE d.account_id=$1',[accountId])).rows[0];
      if(!row||row.state==='complete')return;
      if(row.state==='queued'){
        const uncertain=(await db.query('SELECT session_id FROM checkout_intents WHERE account_id=$1 AND expires_at>$2',[accountId,now()])).rows[0];
        if(uncertain&&!uncertain.session_id)throw new PendingDeletion('An uncertain checkout must expire before identity deletion.');
        if(row.customer_id&&!deps.payments)throw new Error('Payment cancellation must be configured before deleting a paid account.');
        if(deps.payments)await deps.payments.stopRenewal(accountId,row.customer_id?String(row.customer_id):null,`femlab-delete:${accountId}`);
        await db.query("UPDATE account_deletions SET state='renewal_canceled',updated_at=$2,last_error=NULL WHERE account_id=$1",[accountId,now()]);
      }
      // Wait for accepted AI work to be reconciled. Freezing the account prevents new admissions.
      if((await db.query('SELECT id FROM ai_requests WHERE account_id=$1 AND state=ANY($2) LIMIT 1',[accountId,active])).rows.length)throw new PendingDeletion('Accepted AI requests are still pending reconciliation.');
      const exports=(await db.query('SELECT object_name FROM account_exports WHERE account_id=$1',[accountId])).rows;
      if(deps.projects){if(!await deps.projects.purge(accountId))throw new PendingDeletion('Cloud project cleanup is still pending.');}
      else if((await db.query("SELECT to_regclass('cloud_projects') name")).rows[0]?.name&&(await db.query('SELECT 1 FROM cloud_projects WHERE account_id=$1 LIMIT 1',[accountId])).rows.length)throw new PendingDeletion('Cloud project storage must be configured before deleting this account.');
      for(const artifact of exports)if(artifact.object_name)await deps.objects.remove(String(artifact.object_name));
      if(row.state!=='identity_deleted'){await deps.identity.remove(String(row.firebase_uid));await db.query("UPDATE account_deletions SET state='identity_deleted',updated_at=$2 WHERE account_id=$1",[accountId,now()])}
      await transaction(db,async sql=>{
        await sql.query("UPDATE accounts SET firebase_uid=$2,email='',status='deleted',updated_at=$3 WHERE id=$1",[accountId,`deleted:${accountId}`,now()]);
        await sql.query('DELETE FROM account_exports WHERE account_id=$1',[accountId]);
        await sql.query('DELETE FROM checkout_intents WHERE account_id=$1',[accountId]);
        await sql.query('DELETE FROM plan_changes WHERE account_id=$1',[accountId]);
        await sql.query("UPDATE account_deletions SET state='complete',updated_at=$2,last_error=NULL WHERE account_id=$1",[accountId,now()]);
      });
    });
  }
  async function recover(){let exported=0,deleted=0,expired=0,pending=0,failed=0;
    const cleanup=(await db.query("SELECT * FROM account_exports WHERE expires_at <= $1 LIMIT 100",[now()])).rows;
    for(const row of cleanup)try{await lease(String(row.account_id),async()=>{if(row.object_name)await deps.objects.remove(String(row.object_name));await db.query("DELETE FROM account_exports WHERE account_id=$1 AND id=$2",[row.account_id,row.id]);expired++})}catch{failed++}
    const pendingExports=(await db.query("SELECT e.* FROM account_exports e JOIN accounts a ON a.id=e.account_id WHERE e.state='queued' AND e.expires_at>$1 AND a.status='active' ORDER BY e.created_at LIMIT 100",[now()])).rows;
    for(const row of pendingExports)try{await lease(String(row.account_id),async()=>{
      const fresh=(await db.query("SELECT e.id,a.status FROM account_exports e JOIN accounts a ON a.id=e.account_id WHERE e.account_id=$1 AND e.id=$2 AND e.state='queued'",[row.account_id,row.id])).rows[0];if(!fresh||fresh.id!==row.id||fresh.status!=='active')return;
      const connection=await db.connect();let data:string;try{await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');data=await records(connection,String(row.account_id));await connection.query('COMMIT')}catch(error){await connection.query('ROLLBACK');throw error}finally{connection.release()}
      const objectName=`accounts/${row.account_id}/${row.id}.json`;
      await deps.objects.write(objectName,data,row.expires_at as Date);await db.query("UPDATE account_exports SET state='ready',object_name=$2,last_error=NULL WHERE account_id=$1 AND id=$3",[row.account_id,objectName,row.id]);exported++;
    })}catch{failed++;await db.query("UPDATE account_exports SET attempts=attempts+1,last_error='export-unavailable' WHERE account_id=$1 AND id=$2",[row.account_id,row.id])}
    const deletions=(await db.query("SELECT account_id FROM account_deletions WHERE state<>'complete' ORDER BY updated_at LIMIT 100")).rows;
    for(const row of deletions)try{await deletion(String(row.account_id));if((await db.query("SELECT state FROM account_deletions WHERE account_id=$1",[row.account_id])).rows[0]?.state==='complete')deleted++}catch(error){if(error instanceof PendingDeletion||(error instanceof ServiceFailure&&error.code==='account-operation-pending'))pending++;else failed++;await db.query("UPDATE account_deletions SET attempts=attempts+1,last_error='deletion-pending',updated_at=$2 WHERE account_id=$1",[row.account_id,now()])}
    return {exported,deleted,expired,pending,failed};
  }
  return {export:exportRequest,delete:deleteRequest,recover};
}
export type AccountPrivacy=ReturnType<typeof accountPrivacy>;
