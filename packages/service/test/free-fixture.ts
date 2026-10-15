import { calendarPeriod } from '../src/credits';
import type { CreditLedger } from '../src/ledger';
/** Test setup explicitly approves a free grant. The production HTTP API cannot do this. */
export async function grantFreeFixture(ledger: CreditLedger, accountId: string, clock: Date) {
  const period = calendarPeriod(clock);
  await ledger.grant({ accountId, source: `fixture:${accountId}:${period.key}`, plan: 'free', startsAt: period.start, expiresAt: period.end });
}
