import type { Usage } from '@femlab/ai';
import type { Sql } from './accounts';
import { calendarPeriod, CREDIT_SCALE, maximumCharge, PLANS, supplierMicros, TARIFF_VERSION, usageCharge, type PlanId } from './credits';
import { ServiceFailure } from './errors';
import { transaction, type Database } from './transactions';

const active = ['preflight', 'reserved', 'dispatched', 'pending_reconciliation'];
const held = ['reserved', 'dispatched', 'pending_reconciliation'];
type Row = Record<string, unknown>;
const integer = (value: unknown) => BigInt(String(value));
export interface Receipt {
  requestId: string; outcome: string; usage: Usage | null; chargedCredits: number;
  chargedSubcredits: string; tariffVersion: string;
}
export interface RequestStatus { id: string; state: string; model: string; plan: PlanId; maxOutput: number; replay: boolean; receipt: Receipt | null }
export interface Prepare {
  accountId: string; key: string; digest: string; turnId: string; round: number; model: string; maxOutput: number;
}
function publicReceipt(row: Row | undefined): Receipt | null {
  return row ? { requestId: String(row.request_id), outcome: String(row.outcome), usage: row.usage as Usage | null,
    chargedCredits: Number(integer(row.charged_subcredits)) / Number(CREDIT_SCALE), chargedSubcredits: String(row.charged_subcredits), tariffVersion: String(row.tariff_version) } : null;
}
async function receipt(sql: Sql, id: string) { return publicReceipt((await sql.query('SELECT * FROM usage_receipts WHERE request_id=$1', [id])).rows[0]); }
async function status(sql: Sql, row: Row, replay: boolean): Promise<RequestStatus> {
  const final = await receipt(sql, String(row.id));
  const state = final ? final.outcome === 'confirmed' ? 'settled' : final.outcome === 'unknown' ? 'company_loss' : 'released' : String(row.state);
  return { id: String(row.id), state, model: String(row.model), plan: row.plan as PlanId, maxOutput: Number(row.max_output), replay, receipt: final };
}
async function eligibleGrants(sql: Sql, accountId: string, clock: Date) {
  const rows = (await sql.query(`SELECT g.*, g.amount
    + COALESCE((SELECT sum(e.amount) FROM credit_entries e WHERE e.grant_id=g.id),0)
    - COALESCE((SELECT sum(h.amount) FROM credit_holds h JOIN ai_requests r ON r.id=h.request_id WHERE h.grant_id=g.id AND r.state=ANY($3)),0) AS available
    FROM credit_grants g WHERE account_id=$1 AND starts_at <= $2 AND expires_at > $2 ORDER BY expires_at,id`, [accountId, clock, held])).rows;
  const paid = rows.some(row => row.plan !== 'free');
  return rows.filter(row => paid ? row.plan !== 'free' : row.plan === 'free');
}
async function owned(sql: Sql, accountId: string, id: string) {
  const row = (await sql.query('SELECT * FROM ai_requests WHERE id=$1 AND account_id=$2', [id, accountId])).rows[0];
  if (!row) throw new ServiceFailure(404, 'request-not-found', 'This AI request is not available.', 'usage');
  return row;
}
export function reservations(db: Database, now: () => Date, newId: () => string) {
  async function prepare(input: Prepare): Promise<RequestStatus> {
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(input.key) || !/^[a-f0-9]{64}$/.test(input.digest)) throw new ServiceFailure(400, 'invalid-idempotency-key', 'Supply a valid request key.', 'request');
    return transaction(db, async sql => {
      const clock = now();
      const previous = (await sql.query('SELECT * FROM ai_requests WHERE account_id=$1 AND idempotency_key=$2', [input.accountId, input.key])).rows[0];
      if (previous) {
        if (previous.body_digest !== input.digest) throw new ServiceFailure(409, 'request-conflict', 'This request key was already used for different content.', 'request');
        return status(sql, previous, true);
      }
      const account = (await sql.query('SELECT status FROM accounts WHERE id=$1 FOR UPDATE', [input.accountId])).rows[0];
      if (account?.status !== 'active') throw new ServiceFailure(403, 'account-inactive', 'This account cannot use hosted AI.', 'account');
      const limits = (await sql.query('SELECT * FROM ai_limits WHERE id=true')).rows[0];
      if (!limits?.enabled) throw new ServiceFailure(503, 'ai-unavailable', 'Hosted AI is temporarily unavailable.', 'admission');
      const existing = (await sql.query('SELECT id FROM ai_requests WHERE account_id=$1 AND state=ANY($2) LIMIT 1', [input.accountId, active])).rows;
      if (existing.length) throw new ServiceFailure(429, 'request-outstanding', 'An AI request is running or awaiting usage confirmation.', 'admission', 'account.refresh');
      const minute = new Date(clock.getTime() - 60_000);
      const rate = (await sql.query(`SELECT count(*) FILTER(WHERE account_id=$1) AS own, count(*) AS total FROM ai_requests WHERE created_at >= $2`, [input.accountId, minute])).rows[0]!;
      const losses = (await sql.query("SELECT count(*) AS n FROM usage_receipts WHERE account_id=$1 AND outcome='unknown' AND created_at >= $2", [input.accountId, new Date(clock.getTime() - 86_400_000)])).rows[0]!;
      if (integer(rate.own) >= 20n || integer(rate.total) >= 200n || integer(losses.n) >= 3n) throw new ServiceFailure(429, 'rate-limited', 'Too many AI requests. Try again later.', 'admission');
      const grants = await eligibleGrants(sql, input.accountId, clock);
      const plan = grants.reduce<PlanId>((best, row) => PLANS[row.plan as PlanId].credits > PLANS[best].credits ? row.plan as PlanId : best, 'free');
      if (!(PLANS[plan].models as readonly string[]).includes(input.model)) throw new ServiceFailure(403, 'model-not-in-plan', 'Choose a model included in your plan.', 'model', 'ai.setModel');
      if (grants.reduce((sum, row) => sum + integer(row.available), 0n) <= 0n) throw new ServiceFailure(402, 'credits-exhausted', 'Your AI allowance is used up.', 'admission', 'account.open');
      const id = newId(), output = Math.min(input.maxOutput, PLANS[plan].maxOutput);
      await sql.query(`INSERT INTO ai_requests(id,account_id,idempotency_key,body_digest,turn_id,round,model,plan,tariff_version,state,max_output,created_at,updated_at,deadline)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'preflight',$10,$11,$11,$12)`, [id,input.accountId,input.key,input.digest,input.turnId,input.round,input.model,plan,TARIFF_VERSION,output,clock,new Date(clock.getTime()+120_000)]);
      return { id, state: 'preflight', model: input.model, plan, maxOutput: output, replay: false, receipt: null };
    });
  }
  async function reserve(accountId: string, id: string, inputTokens: number): Promise<RequestStatus> {
    return transaction(db, async sql => {
      const row = await owned(sql, accountId, id), clock = now();
      if (row.state !== 'preflight') throw new ServiceFailure(409, 'request-state', 'This request cannot be admitted again.', 'admission');
      if ((row.deadline as Date) <= clock) throw new ServiceFailure(409, 'request-expired', 'This request expired before generation.', 'admission');
      const account = (await sql.query('SELECT status FROM accounts WHERE id=$1 FOR UPDATE', [accountId])).rows[0];
      if (account?.status !== 'active') throw new ServiceFailure(403, 'account-inactive', 'This account cannot use hosted AI.', 'account');
      // Launch context ceiling, including images, schemas and encrypted continuation. Never truncate.
      if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || inputTokens > (row.plan==='free'?64_000:128_000)) throw new ServiceFailure(422, 'context-too-large', 'Reduce conversation context or start a new chat.', 'admission', 'ai.newChat');
      const heldCredits = maximumCharge(String(row.model), inputTokens, Number(row.max_output), String(row.tariff_version)), cost = supplierMicros(heldCredits);
      const limits = (await sql.query('SELECT * FROM ai_limits WHERE id=true')).rows[0]!;
      const day = new Date(Date.UTC(clock.getUTCFullYear(),clock.getUTCMonth(),clock.getUTCDate())), month = calendarPeriod(clock).start;
      const exposure = (await sql.query(`SELECT COALESCE(sum(held_supplier_micros),0) AS held, count(*) AS active,
        COALESCE(sum(held_supplier_micros) FILTER(WHERE plan='free'),0) AS free FROM ai_requests WHERE state=ANY($1)`, [held])).rows[0]!;
      const spent = (await sql.query(`SELECT COALESCE(sum(supplier_micros) FILTER(WHERE created_at >= $1),0) AS day,
        COALESCE(sum(supplier_micros) FILTER(WHERE created_at >= $2),0) AS month,
        COALESCE(sum(supplier_micros) FILTER(WHERE created_at >= $1 AND free_pool),0) AS free FROM usage_receipts`, [day,month])).rows[0]!;
      if (!limits.enabled || integer(exposure.active) >= integer(limits.concurrent) || integer(exposure.held)+cost > integer(limits.uncertain_micros) ||
        integer(exposure.held)+integer(spent.day)+cost > integer(limits.daily_micros) || integer(exposure.held)+integer(spent.month)+cost > integer(limits.monthly_micros) ||
        (row.plan === 'free' && integer(exposure.free)+integer(spent.free)+cost > integer(limits.free_daily_micros))) throw new ServiceFailure(503, 'spend-limit', 'Hosted AI has reached its current service limit. Try again later.', 'admission');
      const recentTokens = (await sql.query('SELECT COALESCE(sum(input_tokens),0) AS n FROM ai_requests WHERE account_id=$1 AND created_at >= $2', [accountId,new Date(clock.getTime()-60_000)])).rows[0]!;
      if (integer(recentTokens.n)+BigInt(inputTokens) > 512_000n) throw new ServiceFailure(429, 'token-rate-limited', 'Too much AI context in a short period. Try again later.', 'admission');
      const grants = await eligibleGrants(sql, accountId, clock);
      // A plan can expire while input is counted; recheck entitlement against the current grants.
      const currentPlan = grants.reduce<PlanId>((best, grant) => PLANS[grant.plan as PlanId].credits > PLANS[best].credits ? grant.plan as PlanId : best, 'free');
      if (currentPlan !== row.plan) throw new ServiceFailure(409, 'plan-changed', 'Your plan changed. Refresh your account before retrying.', 'admission', 'account.refresh');
      if (grants.reduce((sum, grant) => sum+integer(grant.available),0n) < heldCredits) throw new ServiceFailure(402, 'credits-insufficient', 'This request needs more credits than you have available. Reduce context or output.', 'admission', 'account.open');
      let remaining = heldCredits;
      for (const grant of grants) {
        const available = integer(grant.available), amount = remaining < available ? remaining : available;
        if (amount <= 0n) continue;
        await sql.query('INSERT INTO credit_holds(request_id,account_id,grant_id,amount) VALUES($1,$2,$3,$4)', [id,accountId,grant.id,amount.toString()]);
        remaining -= amount; if (remaining === 0n) break;
      }
      await sql.query("UPDATE ai_requests SET state='reserved',input_tokens=$2,held_subcredits=$3,held_supplier_micros=$4,updated_at=$5,deadline=$6 WHERE id=$1", [id,inputTokens,heldCredits.toString(),cost.toString(),clock,new Date(clock.getTime()+1_200_000)]);
      return status(sql, { ...row, state: 'reserved' }, false);
    });
  }
  async function dispatch(accountId: string, id: string): Promise<void> {
    await transaction(db, async sql => {
      const row = await owned(sql, accountId, id);
      if (row.state !== 'reserved' || (row.deadline as Date) <= now()) throw new ServiceFailure(409, 'request-state', 'This request cannot be dispatched.', 'admission');
      const account = (await sql.query('SELECT status FROM accounts WHERE id=$1', [accountId])).rows[0];
      if (account?.status !== 'active') throw new ServiceFailure(403, 'account-inactive', 'This account cannot use hosted AI.', 'account');
      await sql.query("UPDATE ai_requests SET state='dispatched',updated_at=$2 WHERE id=$1", [id,now()]);
    });
  }
  async function providerId(accountId: string, id: string, provider: string): Promise<void> {
    if (!/^resp_[a-zA-Z0-9_-]{1,200}$/.test(provider)) throw new Error('Invalid provider response identity.');
    await db.query("UPDATE ai_requests SET provider_id=$3,updated_at=$4 WHERE id=$1 AND account_id=$2 AND state=ANY($5) AND (provider_id IS NULL OR provider_id=$3)", [id,accountId,provider,now(),['dispatched','pending_reconciliation']]);
  }
  async function finish(accountId: string, id: string, usage: Usage | null, outcome: 'confirmed'|'undispatched'|'unknown'|'provider-rejected'): Promise<Receipt> {
    return transaction(db, async sql => {
      const row = await owned(sql,accountId,id), previous = await receipt(sql,id);
      if (previous) return previous;
      if (outcome === 'confirmed' && (!usage || !['dispatched','pending_reconciliation'].includes(String(row.state)))) throw new Error('Cannot settle unconfirmed or undispatched usage.');
      if (outcome === 'undispatched' && !['preflight','reserved'].includes(String(row.state))) throw new Error('Cannot release a possibly billed request.');
      if (outcome === 'provider-rejected' && (row.state !== 'dispatched' || row.provider_id)) throw new Error('Cannot classify a started response as rejected.');
      if (outcome === 'unknown' && (!['dispatched','pending_reconciliation'].includes(String(row.state)) || now().getTime()-(row.created_at as Date).getTime() < 86_400_000)) throw new Error('Unconfirmed usage remains held for recovery.');
      const actual = usage ? usageCharge(String(row.model),usage,String(row.tariff_version)) : 0n, ceiling = integer(row.held_subcredits), charged = actual < ceiling ? actual : ceiling;
      let remaining = charged;
      const allocations = (await sql.query('SELECT * FROM credit_holds WHERE request_id=$1 ORDER BY grant_id', [id])).rows;
      for (const allocation of allocations) {
        const amount = remaining < integer(allocation.amount) ? remaining : integer(allocation.amount);
        if (amount <= 0n) continue;
        await sql.query("INSERT INTO credit_entries(id,account_id,grant_id,source,amount,kind,created_at) VALUES($1,$2,$3,$4,$5,'usage',$6)", [newId(),accountId,allocation.grant_id,`usage:${id}:${allocation.grant_id}`,(-amount).toString(),now()]);
        remaining -= amount;
      }
      const cost = outcome === 'unknown' ? integer(row.held_supplier_micros) : supplierMicros(actual);
      const loss = outcome === 'unknown' ? cost : supplierMicros(actual-charged);
      await sql.query(`INSERT INTO usage_receipts(request_id,account_id,model,tariff_version,usage,charged_subcredits,supplier_micros,company_loss_micros,free_pool,outcome,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id,accountId,row.model,row.tariff_version,usage ? JSON.stringify(usage) : null,charged.toString(),cost.toString(),loss.toString(),row.plan==='free',outcome,now()]);
      const state = outcome === 'unknown' ? 'company_loss' : outcome === 'confirmed' ? 'settled' : 'released';
      await sql.query('UPDATE ai_requests SET state=$2,updated_at=$3 WHERE id=$1', [id,state,now()]);
      return (await receipt(sql,id))!;
    });
  }
  async function pending(accountId: string,id: string): Promise<void> {
    await db.query("UPDATE ai_requests SET state='pending_reconciliation',updated_at=$3 WHERE id=$1 AND account_id=$2 AND state='dispatched'", [id,accountId,now()]);
  }
  async function recover(lookup: (providerId: string) => Promise<Usage | undefined>): Promise<{ released: number; settled: number; pending: number; losses: number }> {
    const rows = (await db.query('SELECT * FROM ai_requests WHERE state=ANY($1) AND (deadline <= $2 OR state=$3) ORDER BY created_at LIMIT 200', [active,now(),'pending_reconciliation'])).rows;
    const result = { released:0, settled:0, pending:0, losses:0 };
    for (const row of rows) {
      const id=String(row.id), accountId=String(row.account_id);
      if (['preflight','reserved'].includes(String(row.state))) { await finish(accountId,id,null,'undispatched'); result.released++; continue; }
      let usage: Usage | undefined;
      if (row.provider_id) { try { usage=await lookup(String(row.provider_id)); } catch { /* uncertain provider lookup retains the hold */ } }
      if (usage) { await finish(accountId,id,usage,'confirmed'); result.settled++; }
      else if (now().getTime()-(row.created_at as Date).getTime() >= 86_400_000) { await finish(accountId,id,null,'unknown'); result.losses++; }
      else { await pending(accountId,id); result.pending++; }
    }
    return result;
  }
  return { prepare,reserve,dispatch,providerId,pending,settle:(accountId:string,id:string,usage:Usage)=>finish(accountId,id,usage,'confirmed'),release:(accountId:string,id:string)=>finish(accountId,id,null,'undispatched'),recover,
    rejected:(accountId:string,id:string)=>finish(accountId,id,null,'provider-rejected'),
    status:async(accountId:string,id:string)=>status(db,await owned(db,accountId,id),true) };
}
export type Reservations = ReturnType<typeof reservations>;
