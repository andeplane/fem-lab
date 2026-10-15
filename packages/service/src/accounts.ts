import { z } from 'zod';
import type { Identity } from './identity';
import { ServiceFailure } from './errors';
import type { CreditLedger } from './ledger';
import type {CheckoutService} from './checkout';
import type {BillingMerchantMode} from './stripe';
import type {FreeAllowanceStatus} from './free-allowance';

export interface SqlResult { rows: Record<string, unknown>[]; rowCount: number | null }
export interface Sql { query(text: string, values?: unknown[]): Promise<SqlResult> }
export const AccountView = z.strictObject({ id: z.string().uuid(), email: z.string(), createdAt: z.string().datetime(), status: z.literal('active') });
export type Account = z.infer<typeof AccountView>;
export type AccountResponse = Account & { usage?: Awaited<ReturnType<CreditLedger['balance']>>;freeAllowance?:FreeAllowanceStatus; billingAvailable?: boolean;billing?:Awaited<ReturnType<CheckoutService['status']>>&{merchantMode?:BillingMerchantMode} };
export interface Accounts { provision(identity: Identity): Promise<Account> }

/** UID is the only identity key. Email changes and sign-in providers cannot mint another account. */
export function postgresAccounts(sql: Sql, now: () => Date, newId: () => string): Accounts {
  return { async provision(identity) {
    const result = await sql.query(`INSERT INTO accounts (id, firebase_uid, email, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $4) ON CONFLICT (firebase_uid) DO UPDATE
      SET email = EXCLUDED.email, updated_at = EXCLUDED.updated_at WHERE accounts.status = 'active'
      RETURNING id, email, created_at, status`, [newId(), identity.uid, identity.email, now()]);
    const row = result.rows[0];
    if (!row) throw new ServiceFailure(403, 'account-inactive', 'This account cannot use hosted AI.', 'account', 'account.contactSupport');
    return AccountView.parse({ id: row.id, email: row.email, status: row.status, createdAt: (row.created_at as Date).toISOString() });
  } };
}

export function accountReader(verify: (authorization: string | undefined) => Promise<Identity>, accounts: Accounts) {
  return async (authorization: string | undefined) => accounts.provision(await verify(authorization));
}
