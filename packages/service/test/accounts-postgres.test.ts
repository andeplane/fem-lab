import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postgresAccounts } from '../src/accounts';
import { migrate } from '../src/migrations';

describe.skipIf(!process.env.TEST_DATABASE_URL)('account ownership on real Postgres', () => {
  const schema = `accounts_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 16 });
  const now = () => new Date('2026-10-14T12:00:00Z');
  const accounts = postgresAccounts(pool, now, randomUUID);
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const sql = await readFile(new URL('../migrations/001-accounts.sql', import.meta.url), 'utf8');
    // Two simultaneous deployment attempts still install exactly one receipt/schema.
    await Promise.all([0, 1].map(async () => {
      const connection = await pool.connect();
      try { await migrate(connection, [{ name: '001-accounts.sql', sql }]); } finally { connection.release(); }
    }));
  });
  afterAll(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  it('concurrent first use creates one account and preserves its identity across email changes', async () => {
    const identity = { uid: 'same-user', email: 'first@example.com' };
    const results = await Promise.all(Array.from({ length: 24 }, () => accounts.provision(identity)));
    expect(new Set(results.map(account => account.id)).size).toBe(1);
    expect(Number((await pool.query('SELECT count(*) AS count FROM accounts')).rows[0].count)).toBe(1);
    const changed = await accounts.provision({ uid: identity.uid, email: 'changed@example.com' });
    expect(changed.id).toBe(results[0]!.id); expect(changed.email).toBe('changed@example.com');
    expect(changed.createdAt).toBe(now().toISOString());
    expect((await pool.query('SELECT name FROM service_migrations')).rows).toEqual([{ name: '001-accounts.sql' }]);
  });
  it('the same email on another UID never exposes or links the first account', async () => {
    const first = await accounts.provision({ uid: 'person-a', email: 'same@example.com' });
    const second = await accounts.provision({ uid: 'person-b', email: 'same@example.com' });
    expect(first.id).not.toBe(second.id);
    await pool.query("UPDATE accounts SET status = 'deleting' WHERE id = $1", [first.id]);
    await expect(accounts.provision({ uid: 'person-a', email: 'same@example.com' })).rejects.toMatchObject({ code: 'account-inactive' });
    expect((await accounts.provision({ uid: 'person-b', email: 'same@example.com' })).id).toBe(second.id);
  });
  it('failed migration DDL and its receipt roll back together', async () => {
    const connection = await pool.connect();
    try {
      await expect(migrate(connection, [{ name: '002-broken', sql: 'CREATE TABLE rollback_probe(id int); SELECT no_such_function()' }])).rejects.toThrow();
      expect((await connection.query("SELECT to_regclass('rollback_probe') AS name")).rows).toEqual([{ name: null }]);
      expect((await connection.query("SELECT name FROM service_migrations WHERE name = '002-broken'")).rows).toEqual([]);
    } finally { connection.release(); }
  });
});
