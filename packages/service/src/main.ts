import pg from 'pg';
import {operationalSnapshot} from './operations';

// Operator-only, before Firebase, provider, payment, migration or recovery initialization.
// A SELECT-only database role is sufficient; this branch never starts an HTTP listener.
if (process.argv.includes('--operations')) {
  if (process.argv.includes('--recover') || process.argv.includes('--migrate')) {
    process.stdout.write(JSON.stringify({event:'service-operations',severity:'ERROR',code:'operations-invalid-mode',cause:'Operational checks cannot be combined with mutations.',where:'service.operations',suggestion:'node dist/main.mjs --operations'})+'\n');
    process.exitCode=2;
  } else {
    const pool = new pg.Pool({max:1,connectionTimeoutMillis:5000,idleTimeoutMillis:1000,statement_timeout:5000,options:(process.env.PGOPTIONS??'')+' -c statement_timeout=5000 -c default_transaction_read_only=on'});
    try {
      const limit=process.env.OPERATIONS_SIGNUP_LIMIT??'20';
      if(!/^[1-9][0-9]*$/.test(limit)||BigInt(limit)>1_000_000n)throw new Error('Invalid signup policy.');
      const snapshot=await operationalSnapshot(pool,()=>new Date(),BigInt(limit));
      process.stdout.write(JSON.stringify(snapshot)+'\n');
      process.exitCode=snapshot.alarms.length?1:0;
    } catch {
      process.stdout.write(JSON.stringify({event:'service-operations',severity:'ERROR',code:'operations-unavailable',cause:'The operational snapshot could not be read.',where:'service.operations',suggestion:'Check read-only database access and migrations, then rerun node dist/main.mjs --operations.'})+'\n');
      process.exitCode=2;
    } finally { await pool.end(); }
  }
} else { await import('./runtime.js'); }
