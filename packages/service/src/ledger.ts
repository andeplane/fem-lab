import type { Sql } from './accounts';
import { calendarPeriod, balanceCredits, CREDIT_SCALE, FREE_MONTHLY_CREDITS, PLANS, TARIFF_VERSION, type PlanId } from './credits';
import type {PublicCreditUnit} from '@femlab/registry';
import {freePolicy,freeGrantAllowed,type EmailFingerprint} from './free-eligibility';

export interface Grant {
  accountId: string; source: string; plan: PlanId; startsAt: Date; expiresAt: Date;
}
export function creditLedger(sql: Sql, now: () => Date, newId: () => string, fingerprint?:EmailFingerprint) {
  async function grantAmount(input: Grant, credits:number): Promise<void> {
    const clock = now();
    if (!input.source || input.source.length > 256 || !Number.isFinite(input.startsAt.getTime()) || !Number.isFinite(input.expiresAt.getTime()) || input.expiresAt <= input.startsAt) throw new Error('Invalid grant source or period.');
    const amount = BigInt(credits) * CREDIT_SCALE;
    await sql.query(`INSERT INTO credit_grants (id, account_id, source, plan, tariff_version, amount, starts_at, expires_at, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (source) DO NOTHING`,
    [newId(), input.accountId, input.source, input.plan, TARIFF_VERSION, amount.toString(), input.startsAt, input.expiresAt, clock]);
    // A replay must be the same grant, including account/period, rather than a silently accepted conflict.
    const row = (await sql.query('SELECT account_id, plan, starts_at, expires_at FROM credit_grants WHERE source=$1', [input.source])).rows[0];
    if (!row || row.account_id !== input.accountId || row.plan !== input.plan || (row.starts_at as Date).getTime() !== input.startsAt.getTime() || (row.expires_at as Date).getTime() !== input.expiresAt.getTime()) throw new Error('Conflicting immutable grant source.');
  }
  async function balance(accountId: string,unit?:PublicCreditUnit) {
    const clock = now();
    const rows = (await sql.query(`SELECT g.id, g.plan, g.source, g.amount, g.expires_at, g.starts_at,
      g.amount + COALESCE((SELECT sum(e.amount) FROM credit_entries e WHERE e.grant_id=g.id),0)
      - COALESCE((SELECT sum(h.amount) FROM credit_holds h JOIN ai_requests r ON r.id=h.request_id
        WHERE h.grant_id=g.id AND r.state=ANY($3)),0) AS remaining
      FROM credit_grants g LEFT JOIN billing_accounts b ON b.account_id=g.account_id
      WHERE g.account_id=$1 AND g.starts_at <= $2 AND g.expires_at > $2 AND NOT COALESCE(b.blocked,false)
      ORDER BY g.expires_at, g.id`, [accountId, clock, ['reserved','dispatched','pending_reconciliation']])).rows;
    const activePaid = rows.filter(row => row.plan !== 'free').sort((a, b) => PLANS[b.plan as PlanId].credits - PLANS[a.plan as PlanId].credits)[0];
    // Paid grants replace the free allowance for their period; a dormant free row is not extra spend.
    const policy=activePaid?undefined:await freePolicy(sql,accountId,fingerprint);
    const eligible = rows.filter(row => activePaid ? row.plan !== 'free' : row.plan === 'free'&&freeGrantAllowed(row.source,policy!));
    const total = eligible.reduce((sum, row) => sum + BigInt(String(row.amount)), 0n);
    const remaining = eligible.reduce((sum, row) => sum + BigInt(String(row.remaining)), 0n);
    const plan = (activePaid?.plan ?? 'free') as PlanId;
    const period = calendarPeriod(clock);
    const reserved = (await sql.query('SELECT COALESCE(sum(held_subcredits),0) AS amount FROM ai_requests WHERE account_id=$1 AND state=ANY($2)', [accountId, ['reserved','dispatched','pending_reconciliation']])).rows[0]!;
    return { plan, totalCredits: balanceCredits(total,unit), availableCredits: balanceCredits(remaining,unit), reservedCredits: balanceCredits(BigInt(String(reserved.amount)),unit),
      periodEndsAt: (activePaid?.expires_at as Date | undefined ?? eligible[0]?.expires_at as Date | undefined ?? period.end).toISOString(), models: [...PLANS[plan].models], maxOutput: PLANS[plan].maxOutput, contextLimit:plan==='free'?64000:128000, tariffVersion: TARIFF_VERSION };
  }
  // Free grants require an explicit operator approval, just as paid grants require an invoice.
  // Reading an account, calling completions or crossing a month boundary cannot mint money.
  return { grant:(input:Grant)=>grantAmount(input,PLANS[input.plan].credits), balance,
    async grantMonthlyFree(input:Omit<Grant,'plan'>){
      if(!/^free-month:[a-f0-9-]{36}:\d{4}-\d{2}$/.test(input.source))throw new Error('Invalid monthly allowance source.');
      await grantAmount({...input,plan:'free'},FREE_MONTHLY_CREDITS);
    } };
}
export type CreditLedger = ReturnType<typeof creditLedger>;
