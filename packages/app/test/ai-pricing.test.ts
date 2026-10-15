import { describe, expect, it } from 'vitest';
import { costOf } from '../src/ai/provider';
import { OPENAI_MODELS } from '../src/ai/openai';

describe('OpenAI Standard request pricing', () => {
  it.each([
    ['gpt-6-astra', 1.5],
    ['gpt-5.6-sol', 0.6],
    ['gpt-5.5', 0.8],
    ['gpt-5.4-mini', 0.12],
  ])('prices uncached input and all output tokens for %s', (model, expected) => {
    expect(costOf(model, { input: 100_000, cacheRead: 0, output: 10_000 })).toBeCloseTo(expected, 12);
  });
  it('quotes every offered model and keeps unknown IDs unpriced', () => {
    for (const model of OPENAI_MODELS) expect(costOf(model, { input: 1, output: 1, cacheRead: 0 })).not.toBeNull();
    expect(costOf('future-model', { input: 1, output: 1, cacheRead: 0 })).toBeNull();
  });
  it('distinguishes uncached input, cache reads and the cache-write subset without double counting', () => {
    // 70k ordinary + 30k writes + 20k reads + 10k output at Astra Standard rates.
    expect(costOf('gpt-6-astra', { input: 100_000, cacheWrite: 30_000, cacheRead: 20_000, output: 10_000 })).toBeCloseTo(1.595, 12);
    expect(costOf('gpt-5.6-sol', { input: 100_000, cacheWrite: 30_000, cacheRead: 20_000, output: 10_000 })).toBeCloseTo(0.638, 12);
    expect(costOf('gpt-5.5', { input: 1, cacheWrite: 1, cacheRead: 0, output: 0 })).toBeNull();
  });
  it('applies long-context rates to the entire request only above 272k including cached input', () => {
    expect(costOf('gpt-6-astra', { input: 72_000, cacheRead: 200_000, output: 10_000 })).toBeCloseTo(1.42, 12);
    expect(costOf('gpt-6-astra', { input: 72_001, cacheRead: 200_000, output: 10_000 })).toBeCloseTo(2.59002, 12);
    expect(costOf('gpt-5.4-mini', { input: 300_000, cacheRead: 0, output: 10_000 })).toBeCloseTo(0.27, 12);
  });
});
