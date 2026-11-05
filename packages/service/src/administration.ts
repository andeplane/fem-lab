import type {Sql} from './accounts';
import {ServiceFailure} from './errors';

/** Structurally implemented by Firebase Admin Auth; injected in tests. */
export interface SuspensionIdentity {
  updateUser(uid:string,properties:{disabled:true}):Promise<unknown>;
  revokeRefreshTokens(uid:string):Promise<void>;
}
/** Administrative suspension is an identity action, not account deletion.
 * Disable first so a failed revocation remains fail-closed and safely retryable.
 * Existing admitted streams retain their ordinary metering/settlement lifecycle.
 */
export async function suspendAccount(sql:Sql,identity:SuspensionIdentity,accountId:string){
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(accountId))
    throw new ServiceFailure(422,'invalid-account','Supply the account UUID.','operator.suspension');
  const row=(await sql.query("SELECT firebase_uid FROM accounts WHERE id=$1 AND status='active'",[accountId])).rows[0];
  if(!row)throw new ServiceFailure(404,'suspension-account-unavailable','The target account is unavailable.','operator.suspension');
  let disabled=false;
  try {await identity.updateUser(String(row.firebase_uid),{disabled:true});disabled=true;await identity.revokeRefreshTokens(String(row.firebase_uid));}
  catch {throw new ServiceFailure(503,'suspension-incomplete','Identity suspension did not fully complete. Retry the same target.','operator.suspension',null,disabled?{disabled:true}:{disableConfirmed:false});}
  return {accountId:accountId.toLowerCase(),disabled:true,sessionsRevoked:true};
}
