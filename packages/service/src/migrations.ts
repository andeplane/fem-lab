import type { Sql } from './accounts';

/** Caller holds a connection: advisory lock serializes deployments; DDL and its receipt commit together. */
export async function migrate(sql: Sql, migrations: { name: string; sql: string }[]): Promise<void> {
  await sql.query('BEGIN');
  try {
    await sql.query('SELECT pg_advisory_xact_lock(546547)');
    await sql.query('CREATE TABLE IF NOT EXISTS service_migrations (name text PRIMARY KEY)');
    const applied = new Set((await sql.query('SELECT name FROM service_migrations')).rows.map(row => row.name));
    for (const migration of migrations) {
      if (applied.has(migration.name)) continue;
      await sql.query(migration.sql);
      await sql.query('INSERT INTO service_migrations (name) VALUES ($1)', [migration.name]);
    }
    await sql.query('COMMIT');
  } catch (error) { await sql.query('ROLLBACK'); throw error; }
}
