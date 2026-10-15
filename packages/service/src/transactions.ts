import type { Sql } from './accounts';
export interface Connection extends Sql { release(): void }
export interface Database extends Sql { connect(): Promise<Connection> }
/** Short transactions only. One global admission lock makes cross-instance ceilings atomic. */
export async function transaction<T>(db: Database, operation: (sql: Sql) => Promise<T>): Promise<T> {
  const connection = await db.connect();
  try {
    await connection.query('BEGIN');
    await connection.query('SELECT pg_advisory_xact_lock(549550)');
    const value = await operation(connection);
    await connection.query('COMMIT'); return value;
  } catch (error) { await connection.query('ROLLBACK'); throw error; }
  finally { connection.release(); }
}
