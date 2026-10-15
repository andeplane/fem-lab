import {createHmac} from 'node:crypto';
import type {Sql} from './accounts';
import {ServiceFailure} from './errors';
import {transaction,type Database} from './transactions';

export type EmailFingerprint=(email:string)=>string;
/** Gmail aliases share a mailbox; custom domains keep their own dot/plus semantics. */
export function canonicalFreeEmail(email:string):string {
  const value=email.trim().toLowerCase(),parts=value.split('@');
  if(parts.length!==2||!parts[0]||!parts[1])throw new Error('Invalid verified email.');
  let [local,domain]=parts as [string,string];
  if(domain==='gmail.com'||domain==='googlemail.com'){domain='gmail.com';local=local.split('+')[0]!.replaceAll('.','');}
  if(!local)throw new Error('Invalid verified email.');
  return `${local}@${domain}`;
}
export function freeEmailFingerprint(secret:string):EmailFingerprint {
  if(Buffer.byteLength(secret)<32)throw new Error('Free eligibility key must contain at least 32 bytes.');
  return email=>createHmac('sha256',secret).update(canonicalFreeEmail(email)).digest('hex');
}
export interface FreePolicy {kind:'legacy'|'monthly'|'none';principalId?:string;state?:string}
/** Account access is verified by the caller; retained aliases cannot create another principal. */
export async function freePolicy(sql:Sql,accountId:string,fingerprint?:EmailFingerprint):Promise<FreePolicy> {
  const account=(await sql.query('SELECT a.email,a.status,b.blocked FROM accounts a LEFT JOIN billing_accounts b ON b.account_id=a.id WHERE a.id=$1',[accountId])).rows[0];
  if(account?.status!=='active'||account.blocked)return {kind:'none'};
  const hash=fingerprint?.(String(account.email));
  const rows=(await sql.query(`SELECT DISTINCT e.* FROM free_eligibilities e
    LEFT JOIN free_eligibility_identities i ON i.eligibility_id=e.id WHERE e.account_id=$1 OR i.fingerprint=$2`,[accountId,hash??null])).rows;
  if(!rows.length)return {kind:'legacy'};
  const row=rows[0]!;
  if(rows.length!==1||!hash||row.account_id!==accountId||row.state!=='approved'||row.email_fingerprint!==hash)return {kind:'none',principalId:String(row.id),state:String(row.state)};
  return {kind:'monthly',principalId:String(row.id),state:'approved'};
}
export function freeGrantAllowed(source:unknown,policy:FreePolicy):boolean {
  return policy.kind==='monthly'?String(source).startsWith(`free-month:${policy.principalId}:`):policy.kind==='legacy'&&!String(source).startsWith('free-month:');
}
/** Privileged operator only. HTTP/runtime database roles never approve or rebind eligibility. */
export async function manageFreeEligibility(db:Database,action:'approve'|'revoke'|'rebind',accountId:string,personReference:string,now:()=>Date,newId:()=>string,fingerprint?:EmailFingerprint) {
  if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(accountId)||!/^[A-Za-z0-9._-]{1,128}$/.test(personReference))throw new Error('Supply an account UUID and stable reviewed-person reference.');
  return transaction(db,async sql=>{
    const account=(await sql.query('SELECT email,status FROM accounts WHERE id=$1 FOR UPDATE',[accountId])).rows[0];
    const existing=(await sql.query('SELECT * FROM free_eligibilities WHERE person_reference=$1',[personReference])).rows[0];
    if(action==='revoke'){
      if(!existing||existing.account_id!==accountId)throw new ServiceFailure(409,'eligibility-conflict','This account does not have that eligibility binding.','free-allowance');
      await sql.query("UPDATE free_eligibilities SET state='revoked',updated_at=$2 WHERE id=$1",[existing.id,now()]);
      return {accountId,state:'revoked'};
    }
    if(!fingerprint)throw new ServiceFailure(503,'free-allowance-unavailable','Free eligibility verification is unavailable.','free-allowance');
    if(account?.status!=='active')throw new ServiceFailure(403,'account-inactive','Only an active verified account can be approved.','free-allowance');
    if(action==='rebind'){
      if(!existing)throw new ServiceFailure(409,'eligibility-conflict','Review the original eligibility before rebinding.','free-allowance');
      if(existing.account_id!==accountId){const previous=(await sql.query('SELECT status FROM accounts WHERE id=$1 FOR UPDATE',[existing.account_id])).rows[0];if(previous?.status==='active')throw new ServiceFailure(409,'eligibility-conflict','The previous account must be inactive before rebinding.','free-allowance');}
    }else if(existing&&existing.account_id!==accountId)throw new ServiceFailure(409,'eligibility-conflict','Use explicit rebind for an existing reviewed person.','free-allowance');
    const hash=fingerprint(String(account.email)),principal=existing?.id??newId();
    const identity=(await sql.query('SELECT eligibility_id FROM free_eligibility_identities WHERE fingerprint=$1',[hash])).rows[0];
    const bound=(await sql.query('SELECT id FROM free_eligibilities WHERE account_id=$1',[accountId])).rows[0];
    if(identity&&identity.eligibility_id!==principal||bound&&bound.id!==principal)throw new ServiceFailure(409,'eligibility-conflict','This identity or account already has a reviewed eligibility.','free-allowance');
    const clock=now();
    if(!existing)await sql.query("INSERT INTO free_eligibilities(id,person_reference,account_id,email_fingerprint,state,approved_at,updated_at) VALUES($1,$2,$3,$4,'approved',$5,$5)",[principal,personReference,accountId,hash,clock]);
    await sql.query('INSERT INTO free_eligibility_identities(fingerprint,eligibility_id,created_at) VALUES($1,$2,$3) ON CONFLICT(fingerprint) DO NOTHING',[hash,principal,clock]);
    await sql.query("UPDATE free_eligibilities SET account_id=$2,email_fingerprint=$3,state='approved',updated_at=$4 WHERE id=$1",[principal,accountId,hash,clock]);
    return {accountId,state:'approved'};
  });
}
