import type { Database } from './transactions';
import { transaction } from './transactions';
import { creditLedger } from './ledger';
import { ServiceFailure } from './errors';

/** Operator-only invitation approval. Never wire this function to a public HTTP route. */
export async function approveTrial(db: Database, accountId: string, approval: string, now: () => Date, newId: () => string) {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(accountId) || !/^[a-zA-Z0-9._-]{1,128}$/.test(approval)) throw new Error('Supply an account UUID and a stable approval reference.');
  const source = `trial:${approval}`;
  return transaction(db, async sql => {
    const owner = (await sql.query('SELECT status FROM accounts WHERE id=$1 FOR UPDATE', [accountId])).rows[0];
    if (owner?.status !== 'active') throw new ServiceFailure(403, 'account-inactive', 'Only an active account can receive a preview.', 'trial');
    const existing = (await sql.query("SELECT account_id, source, starts_at, expires_at FROM credit_grants WHERE source=$1 OR (account_id=$2 AND plan='free') ORDER BY created_at LIMIT 1", [source, accountId])).rows[0];
    if (existing) {
      if (existing.account_id !== accountId || existing.source !== source) throw new ServiceFailure(409, 'trial-already-approved', 'This account or approval has already received a preview.', 'trial');
      return { accountId, source, startsAt: (existing.starts_at as Date).toISOString(), expiresAt: (existing.expires_at as Date).toISOString(), replay: true };
    }
    const clock = now(), expiresAt = new Date(clock.getTime() + 30 * 86_400_000);
    await creditLedger(sql, () => clock, newId).grant({ accountId, source, plan: 'free', startsAt: clock, expiresAt });
    return { accountId, source, startsAt: clock.toISOString(), expiresAt: expiresAt.toISOString(), replay: false };
  });
}
