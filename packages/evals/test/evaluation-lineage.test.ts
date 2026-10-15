import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { accountForPriorAttempts } from '../src/evaluation-lineage';
const original = { model: 'gpt-6.1-sol', maxUsd: 50, maxRequests: 400, maxInputTokens: 128000 };
function artifact(chargedOrReservedUsd: number, requests: number, overrides: Record<string, unknown> = {}) {
  const bytes = new TextEncoder().encode(JSON.stringify({ format: 'femlab-assistant-eval/1', manifest: { model: original.model }, controls: { budget: { ...original, chargedOrReservedUsd, requests, inFlightRequests: 0, stoppedReason: 'unknown usage; held', ...overrides } } }));
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}
it('charges both immutable failed attempts and a controlled probe to one original allowance, without editing any parent ledger', () => {
  const parents = [artifact(1.542097, 51), artifact(0.767005, 20)];
  const before = parents.map(p => new TextDecoder().decode(p.bytes));
  const remaining = accountForPriorAttempts(original, parents);
  expect(remaining.limits).toMatchObject({ maxUsd: 47.690898, maxRequests: 329 });
  const afterProbe = accountForPriorAttempts(original, [...parents, artifact(0.5, 2, { maxUsd: remaining.limits.maxUsd, maxRequests: remaining.limits.maxRequests })]);
  expect(afterProbe.limits).toMatchObject({ maxUsd: 47.190898, maxRequests: 327 });
  expect(afterProbe.chargedMicros + Math.floor(afterProbe.limits.maxUsd * 1e6)).toBeLessThanOrEqual(50_000_000);
  expect(parents.map(p => new TextDecoder().decode(p.bytes))).toEqual(before);
});
it('refuses altered, repeated, foreign, unresolved or exhausted parent ledgers and conservatively rounds sub-microdollar charges', () => {
  const p = artifact(1, 1);
  expect(() => accountForPriorAttempts(original, [{ ...p, sha256: 'bad' }])).toThrow('hash');
  expect(() => accountForPriorAttempts(original, [p, p])).toThrow('repeats');
  for (const overrides of [{ model: 'gpt-6-astra' }, { inFlightRequests: 1 }, { requests: 401 }, { chargedOrReservedUsd: -1 }, { maxUsd: 100 }]) expect(() => accountForPriorAttempts(original, [artifact(1, 1, overrides)])).toThrow('ledger');
  expect(() => accountForPriorAttempts(original, [artifact(50, 1)])).toThrow('exhaust');
  expect(accountForPriorAttempts(original, [artifact(0.0000001, 1)]).limits.maxUsd).toBe(49.999999);
});
