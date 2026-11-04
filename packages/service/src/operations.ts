import type { Sql } from './accounts';

export interface OperationalAlarm { code: string; cause: string; where: 'service.operations'; suggestion: string }
export interface OperationalSnapshot {
  event: 'service-operations'; severity: 'INFO' | 'ERROR'; at: string;
  status: 'ready' | 'paused' | 'action-required'; admissionEnabled: boolean;
  requests: { active: string; pendingMetering: string; overdue: string; companyLossesToday: string };
  webhooks: { queued: string; oldestSeconds: number | null; overdue: string };
  exposure: Record<'daily' | 'monthly' | 'freeDaily' | 'freeMonthly' | 'uncertain' | 'concurrent', { value: string; limit: string }>;
  alarms: OperationalAlarm[];
}

/** One read-only statement observes one MVCC snapshot, across every API/recovery process.
 * Counts and supplier microdollars remain exact decimal strings; no owner/vendor data leaves SQL.
 * Webhooks get two ten-minute recovery intervals before they become overdue.
 */
export async function operationalSnapshot(sql: Sql, now: () => Date): Promise<OperationalSnapshot> {
  const clock = now();
  const day = new Date(Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth(), clock.getUTCDate()));
  const month = new Date(Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth(), 1));
  const row = (await sql.query(`WITH requests AS (
    SELECT count(*) FILTER (WHERE state IN ('reserved','dispatched','pending_reconciliation')) AS active,
      count(*) FILTER (WHERE state='pending_reconciliation') AS pending,
      count(*) FILTER (WHERE state IN ('preflight','reserved','dispatched','pending_reconciliation') AND deadline <= $1) AS overdue,
      COALESCE(sum(held_supplier_micros) FILTER (WHERE state IN ('reserved','dispatched','pending_reconciliation')),0) AS held,
      COALESCE(sum(held_supplier_micros) FILTER (WHERE state IN ('reserved','dispatched','pending_reconciliation') AND plan='free'),0) AS free_held
    FROM ai_requests WHERE state IN ('preflight','reserved','dispatched','pending_reconciliation')
  ), spent AS (
    SELECT COALESCE(sum(supplier_micros) FILTER (WHERE created_at >= $2),0) AS day,
      COALESCE(sum(supplier_micros) FILTER (WHERE created_at >= $3),0) AS month,
      COALESCE(sum(supplier_micros) FILTER (WHERE created_at >= $2 AND free_pool),0) AS free_day,
      COALESCE(sum(supplier_micros) FILTER (WHERE created_at >= $3 AND free_pool),0) AS free_month,
      count(*) FILTER (WHERE created_at >= $2 AND outcome='unknown') AS losses
    FROM usage_receipts WHERE created_at >= $3
  ), webhooks AS (
    SELECT count(*) AS queued, min(received_at) AS oldest,
      count(*) FILTER (WHERE received_at <= $4) AS overdue
    FROM billing_inbox WHERE state='queued'
  ) SELECT l.enabled,l.daily_micros,l.monthly_micros,l.free_daily_micros,l.free_monthly_micros,l.uncertain_micros,l.concurrent,
    r.active,r.pending,r.overdue,r.held,r.free_held,s.day,s.month,s.free_day,s.free_month,s.losses,
    w.queued,w.oldest,w.overdue AS webhook_overdue
    FROM ai_limits l CROSS JOIN requests r CROSS JOIN spent s CROSS JOIN webhooks w WHERE l.id=true`,
  [clock, day, month, new Date(clock.getTime() - 1_200_000)])).rows[0];
  if (!row || typeof row.enabled !== 'boolean') throw new Error('Operational configuration is unavailable.');
  const count = (name: string) => {
    const value = BigInt(String(row[name]));
    if (value < 0n) throw new Error('Operational counters must be nonnegative.');
    return value;
  };
  const held = count('held'), freeHeld = count('free_held');
  const exposure: OperationalSnapshot['exposure'] = {
    daily: { value: (held + count('day')).toString(), limit: count('daily_micros').toString() },
    monthly: { value: (held + count('month')).toString(), limit: count('monthly_micros').toString() },
    freeDaily: { value: (freeHeld + count('free_day')).toString(), limit: count('free_daily_micros').toString() },
    freeMonthly: { value: (freeHeld + count('free_month')).toString(), limit: count('free_monthly_micros').toString() },
    uncertain: { value: held.toString(), limit: count('uncertain_micros').toString() },
    concurrent: { value: count('active').toString(), limit: count('concurrent').toString() },
  };
  const alarms: OperationalAlarm[] = [];
  const alarm = (code: string, cause: string, suggestion: string) => alarms.push({ code, cause, where: 'service.operations', suggestion });
  if (count('pending') > 0n) alarm('metering-unknown', 'Dispatched usage is awaiting confirmation.', 'Inspect usage recovery; never release an uncertain hold manually.');
  if (count('overdue') > 0n) alarm('settlement-overdue', 'An active request has reached its recovery deadline.', 'Inspect the scheduled recovery execution and rerun node dist/main.mjs --recover if safe.');
  if (count('losses') > 0n) alarm('metering-company-loss', 'Unknown usage became a conservative company loss today.', 'Review usage recovery before admitting further supplier exposure.');
  if (count('webhook_overdue') > 0n) alarm('webhook-overdue', 'A billing event has waited at least twenty minutes.', 'Inspect billing recovery and canonical Stripe state; a browser return grants nothing.');
  for (const [name, boundary] of Object.entries(exposure)) {
    // Zero caps deliberately pause staging/free admissions. No exposure means no incident;
    // existing positive exposure remains visible/alarming even while admissions are disabled.
    if (BigInt(boundary.value) > 0n && BigInt(boundary.value) >= BigInt(boundary.limit)) {
      alarm(`ceiling-${name}`, `The ${name} admission ceiling is occupied or exceeded.`, 'Inspect the shared admission limits and existing exposure; do not raise limits automatically.');
    }
  }
  const oldest = row.oldest === null ? null : row.oldest instanceof Date ? row.oldest : new Date(String(row.oldest));
  if (oldest !== null && !Number.isFinite(oldest.getTime())) throw new Error('Operational timestamps are invalid.');
  const globallyPaused = !row.enabled || ['daily','monthly','uncertain'].some(name => exposure[name as keyof typeof exposure].limit === '0');
  return {
    event: 'service-operations', severity: alarms.length ? 'ERROR' : 'INFO', at: clock.toISOString(),
    status: alarms.length ? 'action-required' : globallyPaused ? 'paused' : 'ready', admissionEnabled: row.enabled,
    requests: { active: count('active').toString(), pendingMetering: count('pending').toString(), overdue: count('overdue').toString(), companyLossesToday: count('losses').toString() },
    webhooks: { queued: count('queued').toString(), oldestSeconds: oldest === null ? null : Math.max(0, Math.floor((clock.getTime() - oldest.getTime()) / 1000)), overdue: count('webhook_overdue').toString() },
    exposure, alarms,
  };
}
