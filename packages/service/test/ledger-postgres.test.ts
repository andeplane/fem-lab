import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postgresAccounts } from '../src/accounts';
import { creditLedger } from '../src/ledger';
import { migrate } from '../src/migrations';

describe.skipIf(!process.env.TEST_DATABASE_URL)('immutable grants on real Postgres', () => {
  const schema = `ledger_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 16 });
  let clock = new Date('2026-10-14T12:00:00Z');
  const ledger = creditLedger(pool, () => clock, randomUUID);
  const accounts = postgresAccounts(pool, () => clock, randomUUID);
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const migrations = await Promise.all(['001-accounts.sql', '002-credit-ledger.sql'].map(async name => ({ name, sql: await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8') })));
    const connection = await pool.connect();
    try { await migrate(connection, migrations); } finally { connection.release(); }
  });
  afterAll(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  it('concurrent account reads mint one free allowance per UTC month and no rollover', async () => {
    const account = await accounts.provision({ uid: 'monthly', email: 'monthly@example.com' });
    await Promise.all(Array.from({ length: 24 }, () => ledger.ensureFree(account.id)));
    expect((await ledger.balance(account.id)).availableCredits).toBe(200000);
    expect(Number((await pool.query('SELECT count(*) AS n FROM credit_grants WHERE account_id=$1', [account.id])).rows[0].n)).toBe(1);
    clock = new Date('2026-11-01T00:00:00Z');
    expect((await ledger.balance(account.id)).availableCredits).toBe(0);
    await ledger.ensureFree(account.id);
    expect((await ledger.balance(account.id)).availableCredits).toBe(200000);
  });
  it('deduplicates paid sources, rejects a changed account/period/plan, and expires the allowance', async () => {
    const account = await accounts.provision({ uid: 'paid', email: 'paid@example.com' });
    const other = await accounts.provision({ uid: 'other', email: 'other@example.com' });
    const input = { accountId: account.id, source: 'stripe:invoice:one', plan: 'plus' as const, startsAt: new Date('2026-11-01T00:00:00Z'), expiresAt: new Date('2026-12-01T00:00:00Z') };
    await Promise.all(Array.from({ length: 16 }, () => ledger.grant(input)));
    await ledger.ensureFree(account.id);
    expect(await ledger.balance(account.id)).toMatchObject({ plan: 'plus', availableCredits: 4000000, periodEndsAt: '2026-12-01T00:00:00.000Z' });
    expect((await ledger.balance(other.id)).availableCredits).toBe(0);
    for (const change of [{ accountId: other.id }, { plan: 'pro' as const }, { expiresAt: new Date('2026-12-02T00:00:00Z') }]) {
      await expect(ledger.grant({ ...input, ...change })).rejects.toThrow('Conflicting immutable grant');
    }
    clock = new Date('2026-12-01T00:00:00Z');
    expect(await ledger.balance(account.id)).toMatchObject({ plan: 'free', availableCredits: 0 });
  });
  it('database constraints enforce owner linkage, unique debit sources and immutable money', async () => {
    const account = await accounts.provision({ uid: 'debit', email: 'debit@example.com' });
    const other = await accounts.provision({ uid: 'different', email: 'different@example.com' });
    await ledger.ensureFree(account.id);
    const grant = (await pool.query('SELECT id FROM credit_grants WHERE account_id=$1', [account.id])).rows[0];
    const values = [randomUUID(), account.id, grant.id, 'settlement:request-1', '-300', clock];
    const insert = "INSERT INTO credit_entries(id,account_id,grant_id,source,amount,kind,created_at) VALUES($1,$2,$3,$4,$5,'usage',$6)";
    await pool.query(insert, values);
    expect((await ledger.balance(account.id)).availableCredits).toBe(199990);
    await expect(pool.query(insert, [randomUUID(), ...values.slice(1)])).rejects.toMatchObject({ code: '23505' });
    await expect(pool.query(insert, [randomUUID(), other.id, grant.id, 'cross-account', '-300', clock])).rejects.toMatchObject({ code: '23503' });
    await expect(pool.query('UPDATE credit_grants SET amount=amount+1 WHERE id=$1', [grant.id])).rejects.toThrow('immutable');
    await expect(pool.query('DELETE FROM credit_entries WHERE source=$1', ['settlement:request-1'])).rejects.toThrow('immutable');
    await expect(ledger.grant({ accountId: account.id, source: '', plan: 'free', startsAt: clock, expiresAt: clock })).rejects.toThrow('Invalid grant');
  });
});
