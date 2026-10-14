import type { Usage } from '@femlab/ai';
import { ServiceFailure } from './errors';

/** One public credit is 30 integer subcredits. Tariff v1 is fixed for every receipt. */
export const CREDIT_SCALE = 30n;
export const TARIFF_VERSION = '2026-10-14.v1';
export const PLANS = {
  free: { priceUsd: 0, credits: 200_000, models: ['gpt-5.4-mini'], maxOutput: 2048 },
  plus: { priceUsd: 49, credits: 4_000_000, models: ['gpt-5.4-mini', 'gpt-6-astra'], maxOutput: 8192 },
  pro: { priceUsd: 149, credits: 16_000_000, models: ['gpt-5.4-mini', 'gpt-6-astra'], maxOutput: 16000 },
  studio: { priceUsd: 499, credits: 50_000_000, models: ['gpt-5.4-mini', 'gpt-6-astra'], maxOutput: 16000 },
} as const;
export type PlanId = keyof typeof PLANS;
interface Tariff { input: bigint; cached: bigint; output: bigint; write?: bigint; longContext?: boolean }
const tariffs: Record<string, Tariff> = {
  'gpt-5.4-mini': { input: 30n, cached: 3n, output: 180n },
  'gpt-6-astra': { input: 400n, cached: 40n, write: 500n, output: 2000n, longContext: true },
};
function tariff(model: string): Tariff {
  const found = tariffs[model];
  if (!found) throw new ServiceFailure(400, 'model-unavailable', 'This model is not available for hosted AI.', 'model', 'ai.setModel');
  return found;
}
function count(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Provider usage must contain nonnegative safe integers.');
  return BigInt(value);
}
/** Input excludes cache reads, but includes writes. Output includes provider reasoning. */
export function usageCharge(model: string, usage: Usage): bigint {
  const rate = tariff(model), input = count(usage.input), output = count(usage.output), cached = count(usage.cacheRead), written = count(usage.cacheWrite ?? 0);
  if (written > input || (written > 0n && rate.write === undefined)) throw new Error('Provider reported unsupported cache writes.');
  const long = rate.longContext && input + cached > 272_000n;
  const inputCharge = (input - written) * rate.input + cached * rate.cached + written * (rate.write ?? rate.input);
  return inputCharge * (long ? 2n : 1n) + output * rate.output * (long ? 3n : 2n) / 2n;
}
/** Uncached or cache-write input, whichever costs more, plus the entire reasoning/output ceiling. */
export function maximumCharge(model: string, inputTokens: number, maxOutput: number): bigint {
  const rate = tariff(model), input = count(inputTokens), output = count(maxOutput);
  const long = rate.longContext && input > 272_000n;
  const inputRate = rate.write && rate.write > rate.input ? rate.write : rate.input;
  return input * inputRate * (long ? 2n : 1n) + output * rate.output * (long ? 3n : 2n) / 2n;
}
/** Supplier baseline for v1: $0.75 per million credits, rounded upward in USD microdollars. */
export function supplierMicros(subcredits: bigint): bigint {
  if (subcredits < 0n) throw new Error('Supplier cost cannot be negative.');
  return (subcredits + 39n) / 40n;
}
export function calendarPeriod(now: Date) {
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid grant clock.');
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end, key: start.toISOString().slice(0, 7) };
}
