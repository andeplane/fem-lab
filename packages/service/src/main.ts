import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import pg from 'pg';
import { accountReader, postgresAccounts } from './accounts';
import { identityVerifier } from './identity';
import { migrate } from './migrations';
import { creditLedger } from './ledger';
import { serviceServer } from './http.js';

const port = Number(process.env.PORT ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
// Subsequent service slices inject the verified identity, database and provider adapters.
// Until they are wired, the process is live but explicitly not ready for inference.
const projectId = process.env.FIREBASE_PROJECT_ID;
const pool = projectId ? new pg.Pool({ max: 8, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 }) : undefined;
const now = () => new Date();
if (process.argv.includes('--migrate')) {
  if (!pool) throw new Error('FIREBASE_PROJECT_ID and database connection must be configured.');
  const directory = new URL('./migrations/', import.meta.url);
  const migrations = await Promise.all((await readdir(directory)).filter(name => name.endsWith('.sql')).sort()
    .map(async name => ({ name, sql: await readFile(new URL(name, directory), 'utf8') })));
  const connection = await pool.connect();
  try { await migrate(connection, migrations); } finally { connection.release(); await pool.end(); }
} else {
  const readAccount = pool && projectId ? accountReader(identityVerifier(getAuth(initializeApp({ projectId })), projectId, now), postgresAccounts(pool, now, randomUUID)) : undefined;
  const ledger = pool ? creditLedger(pool, now, randomUUID) : undefined;
  const account = readAccount && ledger ? async (authorization: string | undefined) => {
    const owner = await readAccount(authorization); await ledger.ensureFree(owner.id);
    return { ...owner, usage: await ledger.balance(owner.id), billingAvailable: false };
  } : undefined;
  const server = serviceServer({ now, newId: randomUUID, account,
    origins: (process.env.APP_ORIGINS ?? '').split(',').filter(Boolean),
    ready: async () => { if (!pool) return false; await pool.query('SELECT id FROM credit_grants LIMIT 0'); return true; },
  });
  server.listen(port, '0.0.0.0');
  process.once('SIGTERM', () => { server.close(() => { void pool?.end(); }); });
}
