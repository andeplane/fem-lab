import {z} from 'zod';
import type {Account,Sql} from './accounts';
import {calendarPeriod,FREE_MONTHLY_CREDITS,supplierMicros,CREDIT_SCALE} from './credits';
import {freePolicy,type EmailFingerprint} from './free-eligibility';
import {creditLedger} from './ledger';
import {ServiceFailure} from './errors';
import {transaction,type Database} from './transactions';

export interface FreeAllowanceStatus {status:'review-required'|'eligible'|'claimed'|'revoked'|'paid'|'unavailable';credits:number;periodStartsAt:string;periodEndsAt:string}
/** Explicit monthly claims only; verified sign-in never approves a person or creates money. */
export function monthlyFreeAllowance(db:Database,account:(header:string|undefined)=>Promise<Account>,now:()=>Date,newId:()=>string,fingerprint?:EmailFingerprint) {
  async function inspect(sql:Sql,accountId:string,clock:Date){
    const period=calendarPeriod(clock),policy=await freePolicy(sql,accountId,fingerprint);
    const base={credits:FREE_MONTHLY_CREDITS,periodStartsAt:period.start.toISOString(),periodEndsAt:period.end.toISOString()};
    const blocked=(await sql.query('SELECT blocked FROM billing_accounts WHERE account_id=$1',[accountId])).rows[0]?.blocked;
    const paid=(await sql.query("SELECT id FROM credit_grants WHERE account_id=$1 AND plan<>'free' AND starts_at<=$2 AND expires_at>$2 LIMIT 1",[accountId,clock])).rows.length>0;
    const source=policy.principalId?`free-month:${policy.principalId}:${period.key}`:null;
    const previous=source?(await sql.query('SELECT account_id FROM credit_grants WHERE source=$1',[source])).rows[0]:undefined;
    const limits=(await sql.query('SELECT enabled,free_daily_micros,free_monthly_micros FROM ai_limits WHERE id=true')).rows[0];
    let status:FreeAllowanceStatus['status']=!fingerprint?'unavailable':blocked?'revoked':paid?'paid':policy.kind==='none'?(policy.state==='revoked'?'revoked':'review-required'):policy.kind!=='monthly'?'review-required':previous?'claimed':!limits?.enabled||BigInt(String(limits.free_daily_micros))<=0n?'unavailable':'eligible';
    if(status==='eligible'){
      const count=BigInt(String((await sql.query("SELECT count(*) AS n FROM credit_grants WHERE plan='free' AND source LIKE 'free-month:%' AND starts_at=$1",[period.start])).rows[0]!.n));
      const cost=supplierMicros(BigInt(FREE_MONTHLY_CREDITS)*CREDIT_SCALE);
      if((count+1n)*cost>BigInt(String(limits!.free_monthly_micros)))status='unavailable';
    }
    return {view:{...base,status},source,previous,period,blocked};
  }
  return {
    async status(accountId:string):Promise<FreeAllowanceStatus>{return (await inspect(db,accountId,now())).view;},
    async claim(header:string|undefined,body:unknown){
      if(!z.strictObject({}).safeParse(body).success)throw new ServiceFailure(422,'invalid-free-allowance','Monthly claims accept no account, amount or period overrides.','free-allowance');
      const owner=await account(header);
      return transaction(db,async sql=>{
        const active=(await sql.query('SELECT status FROM accounts WHERE id=$1 FOR UPDATE',[owner.id])).rows[0];
        if(active?.status!=='active')throw new ServiceFailure(403,'account-inactive','This account cannot claim an allowance.','free-allowance');
        const value=await inspect(sql,owner.id,now()),{view}=value;
        if(value.blocked)throw new ServiceFailure(409,'billing-review','This account needs billing review.','free-allowance');
        if(view.status==='paid')throw new ServiceFailure(409,'paid-allowance-active','Your paid period already provides an allowance.','free-allowance');
        if(view.status==='claimed'&&value.previous?.account_id!==owner.id)throw new ServiceFailure(409,'free-allowance-already-claimed','This reviewed person already claimed this month.','free-allowance');
        if(view.status==='revoked')throw new ServiceFailure(403,'free-allowance-revoked','This free allowance requires a new eligibility review.','free-allowance');
        if(view.status==='review-required')throw new ServiceFailure(403,'eligibility-required','Request an eligibility review before claiming a monthly allowance.','free-allowance');
        if(view.status==='unavailable')throw new ServiceFailure(503,'free-allowance-unavailable','The monthly free allowance is temporarily unavailable or fully allocated.','free-allowance');
        const replay=view.status==='claimed';
        if(!replay)await creditLedger(sql,now,newId,fingerprint).grantMonthlyFree({accountId:owner.id,source:value.source!,startsAt:value.period.start,expiresAt:value.period.end});
        return {...view,status:'claimed' as const,replay};
      });
    },
  };
}
export type MonthlyFreeAllowance=ReturnType<typeof monthlyFreeAllowance>;
