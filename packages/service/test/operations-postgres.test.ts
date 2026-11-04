import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrations';
import { operationalSnapshot } from '../src/operations';

describe.skipIf(!process.env.TEST_DATABASE_URL)('operator alarms on real Postgres', () => {
  const suffix = randomUUID().replaceAll('-', '');
  const schema = `operations_${suffix}`, role = `operations_reader_${suffix}`;
  const admin = new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
  // Bound SQL before Vitest's test deadline, so a timed-out query cannot overlap the
  // next fixture's table reset and create a misleading lock/deadlock cascade.
  const settings = {connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`,max:2,statement_timeout:2000,connectionTimeoutMillis:2000};
  const db = new pg.Pool(settings), otherProcess = new pg.Pool(settings);
  const reader = new pg.Pool({...settings,options:`-c search_path=${schema} -c role=${role} -c default_transaction_read_only=on`});
  const directory = fileURLToPath(new URL('../',import.meta.url));
  let clock = new Date('2026-11-01T00:00:00.500Z');
  let account: string;
  const now = () => clock;
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const names = (await readdir(new URL('../migrations/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort();
    const connection = await db.connect();
    try {await migrate(connection,await Promise.all(names.map(async name=>({name,sql:await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8')}))));}
    finally {connection.release();}
    await admin.query(`CREATE ROLE ${role} NOLOGIN`);
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await admin.query(`GRANT SELECT ON ${schema}.ai_limits,${schema}.ai_requests,${schema}.usage_receipts,${schema}.billing_inbox TO ${role}`);
    const build = spawnSync(process.execPath,['build.mjs'],{cwd:directory,encoding:'utf8',timeout:30000});
    expect(build.status,build.stderr).toBe(0);
  },45000);
  beforeEach(async () => {
    clock = new Date('2026-11-01T00:00:00.500Z');
    await db.query('TRUNCATE accounts,billing_inbox CASCADE');
    await db.query('UPDATE ai_limits SET enabled=true,daily_micros=1000000,monthly_micros=10000000,free_daily_micros=1000000,free_monthly_micros=10000000,uncertain_micros=1000000,concurrent=16');
    account = randomUUID();
    await db.query('INSERT INTO accounts(id,firebase_uid,email,created_at,updated_at) VALUES($1,$2,$3,$4,$4)',[account,'private-owner-needle','private-owner-needle@example.com',clock]);
  });
  afterAll(async () => {
    await reader.end();await db.end();await otherProcess.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.query(`DROP ROLE IF EXISTS ${role}`);await admin.end();
  });
  async function request(state='reserved',held='0',plan='free',createdAt=clock) {
    const id = randomUUID();
    await otherProcess.query(`INSERT INTO ai_requests(id,account_id,idempotency_key,body_digest,turn_id,round,model,plan,tariff_version,state,max_output,held_supplier_micros,created_at,updated_at,deadline)
      VALUES($1::uuid,$2,$1::text,$3,'private-turn-needle',0,'gpt-5.4-mini',$4,'2026-10-14.v1',$5,1,$6,$7,$7,$8)`,
    [id,account,'a'.repeat(64),plan,state,held,createdAt,new Date(clock.getTime()+1200000)]);
    return id;
  }
  async function receipt(amount: string,createdAt=clock,free=true,outcome='confirmed') {
    const id = await request(outcome==='unknown'?'company_loss':'settled','0',free?'free':'plus',createdAt);
    await db.query(`INSERT INTO usage_receipts(request_id,account_id,model,tariff_version,charged_subcredits,supplier_micros,company_loss_micros,free_pool,outcome,created_at)
      VALUES($1,$2,'private-model-needle','2026-10-14.v1',0,$3,$4,$5,$6,$7)`,[id,account,amount,outcome==='unknown'?amount:'0',free,outcome,createdAt]);
  }
  const codes = async () => (await operationalSnapshot(reader,now)).alarms.map(alarm=>alarm.code);
  function cli(args=['--operations'],extra: NodeJS.ProcessEnv={}) {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    const result = spawnSync(process.execPath,['dist/main.mjs',...args],{
      cwd:directory,encoding:'utf8',timeout:15000,
      env:{...process.env,PGHOST:url.hostname,PGPORT:url.port||'5432',PGDATABASE:url.pathname.slice(1),PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),
        PGOPTIONS:`-c search_path=${schema} -c role=${role} -c default_transaction_read_only=on`,
        FIREBASE_PROJECT_ID:'invalid-firebase-needle',OPENAI_API_KEY:'sk-private-provider-needle',STRIPE_SECRET_KEY:'sk_live_private-stripe-needle',PORT:'not-an-http-port',...extra},
    });
    expect(result.error).toBeUndefined();
    return {...result,json:JSON.parse(result.stdout) as Record<string,unknown>};
  }
  it('reads with SELECT-only privileges and reports an empty intentionally paused service without alarms',async () => {
    await db.query('UPDATE ai_limits SET enabled=false,daily_micros=0,monthly_micros=0,free_daily_micros=0,free_monthly_micros=0,uncertain_micros=0');
    const snapshot = await operationalSnapshot(reader,now);
    expect(snapshot).toMatchObject({status:'paused',admissionEnabled:false,severity:'INFO',alarms:[],requests:{active:'0',overdue:'0'},webhooks:{queued:'0',oldestSeconds:null}});
    await expect(reader.query('UPDATE ai_limits SET enabled=true')).rejects.toThrow();
    const run = cli();expect(run.status,run.stderr).toBe(0);expect(run.json).toMatchObject({status:'paused',alarms:[]});
  });
  it('observes cross-process state, keeps held exposure across UTC rollover and counts company cost once',async () => {
    await request('reserved','3','free',new Date('2026-10-30T23:00:00Z'));
    await request('released','999');
    await receipt('500',new Date('2026-10-31T23:59:59.999Z'));
    await receipt('7',clock,true,'unknown');
    await receipt('13',clock,false);
    const snapshot = await operationalSnapshot(reader,now);
    expect(snapshot.exposure).toMatchObject({daily:{value:'23'},monthly:{value:'23'},freeDaily:{value:'10'},freeMonthly:{value:'10'},uncertain:{value:'3'},concurrent:{value:'1'}});
    expect(snapshot.requests.companyLossesToday).toBe('1');
    expect(await operationalSnapshot(otherProcess,now)).toEqual(snapshot);
    expect(snapshot.alarms.map(alarm=>alarm.code)).toEqual(['metering-company-loss']);
  });
  it('keeps prior-day paid and free spend in the month while excluding the previous month',async () => {
    clock = new Date('2026-11-15T12:30:00Z');
    await request('reserved','3','free',new Date('2026-10-30T23:00:00Z'));
    await request('reserved','5','plus');
    await receipt('100',new Date('2026-10-31T23:59:59.999Z'),true);
    await receipt('200',new Date('2026-10-31T23:59:59.999Z'),false);
    await receipt('17',new Date('2026-11-14T23:59:59.999Z'),true);
    await receipt('23',new Date('2026-11-14T23:59:59.999Z'),false);
    await receipt('7',clock,true);
    await receipt('11',clock,false);
    const snapshot = await operationalSnapshot(reader,now);
    expect(snapshot.exposure).toMatchObject({daily:{value:'26'},monthly:{value:'66'},freeDaily:{value:'10'},freeMonthly:{value:'27'},uncertain:{value:'8'},concurrent:{value:'2'}});
    expect(snapshot.alarms).toEqual([]);
  });
  it.each([
    ['daily_micros','daily'],['monthly_micros','monthly'],['free_daily_micros','freeDaily'],['free_monthly_micros','freeMonthly'],['uncertain_micros','uncertain'],
  ])('reports the exact occupied %s boundary and no alarm one microdollar below it',async (column,name) => {
    await request('reserved','25');await db.query(`UPDATE ai_limits SET ${column}=26`);
    expect(await codes()).not.toContain(`ceiling-${name}`);
    await db.query(`UPDATE ai_limits SET ${column}=25`);expect(await codes()).toEqual([`ceiling-${name}`]);
    await db.query('UPDATE ai_limits SET enabled=false');expect(await codes()).toEqual([`ceiling-${name}`]);
  });
  it('preserves integer supplier exposure above Number.MAX_SAFE_INTEGER and reports full concurrency',async () => {
    await request('reserved','9007199254740993','plus');
    await db.query('UPDATE ai_limits SET daily_micros=9007199254740994,monthly_micros=9007199254740994,uncertain_micros=9007199254740994,concurrent=1');
    const snapshot = await operationalSnapshot(reader,now);
    expect(snapshot.exposure.daily).toEqual({value:'9007199254740993',limit:'9007199254740994'});
    expect(snapshot.alarms.map(alarm=>alarm.code)).toEqual(['ceiling-concurrent']);
  });
  it('classifies unknown usage, overdue settlement and the exact twenty-minute webhook deadline without leaking identifiers',async () => {
    const id = await request('pending_reconciliation','5');
    await db.query('UPDATE ai_requests SET deadline=$2 WHERE id=$1',[id,clock]);
    await db.query(`INSERT INTO billing_inbox(event_id,event_type,object_id,customer_id,digest,live,retry_at,received_at)
      VALUES('private-event-needle','invoice.paid','private-invoice-needle','private-customer-needle','private-digest-needle',false,$1,$2)`,[clock,new Date(clock.getTime()-1200000+1)]);
    expect(await codes()).toEqual(['metering-unknown','settlement-overdue']);
    clock = new Date(clock.getTime()+1);
    const snapshot = await operationalSnapshot(reader,now);
    expect(snapshot.webhooks).toEqual({queued:'1',oldestSeconds:1200,overdue:'1'});
    expect(snapshot.alarms.map(alarm=>alarm.code)).toEqual(['metering-unknown','settlement-overdue','webhook-overdue']);
    expect(JSON.stringify(snapshot)).not.toContain('private-');
    expect(snapshot.alarms.every(alarm=>alarm.where==='service.operations'&&alarm.cause.length>0&&alarm.suggestion.length>0)).toBe(true);
    // Actual built CLI runs with a SELECT-only role despite invalid provider/auth/HTTP setup.
    const before = await db.query('SELECT * FROM ai_requests ORDER BY id');
    const run = cli();expect(run.status,run.stderr).toBe(1);expect(run.json).toMatchObject({severity:'ERROR',status:'action-required'});
    expect(JSON.stringify(run.json)).not.toContain('private-');
    expect(await db.query('SELECT * FROM ai_requests ORDER BY id')).toEqual(before);
  });
  it('returns a fixed unavailable signal and exit2 for read/configuration failures, distinct from an operational alarm',async () => {
    const missing = cli(['--operations'],{PGOPTIONS:'-c search_path=missing_private_schema'});
    expect(missing.status).toBe(2);expect(missing.json).toMatchObject({code:'operations-unavailable',severity:'ERROR',where:'service.operations'});
    expect(JSON.stringify(missing.json)).not.toContain('private');
    const conflict = cli(['--operations','--recover'],{PGHOST:'invalid-private-host'});
    expect(conflict.status).toBe(2);expect(conflict.json).toMatchObject({code:'operations-invalid-mode'});
    expect(JSON.stringify(conflict.json)).not.toContain('private');
  });
});
