import { describe, expect, it } from 'vitest';
import { calendarPeriod, maximumCharge, PLANS, supplierMicros, usageCharge } from '../src/credits';

describe('integer token tariffs', () => {
  it('matches an independently priced ordinary/cached/output example', () => {
    // 6k input ($.0045), 4k cached ($.0003), 1k output including reasoning ($.0045).
    const amount = usageCharge('gpt-5.4-mini', { input: 6000, cacheRead: 4000, output: 1000 });
    expect(amount).toBe(372000n); expect(supplierMicros(amount)).toBe(9300n);
  });
  it('bills cache writes once, separately from uncached input and reads', () => {
    // 80 ordinary + 20 cache writes + 50 reads + 30 output = $.0026.
    const amount = usageCharge('gpt-6-astra', { input: 100, cacheWrite: 20, cacheRead: 50, output: 30 });
    expect(amount).toBe(104000n); expect(supplierMicros(amount)).toBe(2600n);
  });
  it('reserves the more expensive cache-write possibility and all output/reasoning', () => {
    expect(maximumCharge('gpt-6-astra', 100, 30)).toBe(110000n);
    expect(maximumCharge('gpt-5.4-mini', 100, 30)).toBe(8400n);
    expect(maximumCharge('gpt-6-astra', 272001, 2)).toBe(272007000n);
    expect(maximumCharge('gpt-6-astra', 272000, 2)).toBe(136004000n);
    expect(usageCharge('gpt-6-astra', { input: 272001, cacheRead: 0, output: 2 })).toBe(217606800n);
    expect(usageCharge('gpt-6-astra', { input: 272000, cacheRead: 1, output: 2 })).toBe(217606080n);
  });
  it('rounds supplier microdollars upward without floating point', () => {
    expect(supplierMicros(0n)).toBe(0n); expect(supplierMicros(1n)).toBe(1n);
    expect(supplierMicros(40n)).toBe(1n); expect(supplierMicros(41n)).toBe(2n);
    expect(() => supplierMicros(-1n)).toThrow();
  });
  it.each([-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid provider counts %s', value => {
    expect(() => usageCharge('gpt-5.4-mini', { input: value, cacheRead: 0, output: 0 })).toThrow();
    expect(() => maximumCharge('gpt-5.4-mini', 0, value)).toThrow();
  });
  it('rejects unknown models and unsupported/inconsistent cache writes', () => {
    expect(() => maximumCharge('invented', 10, 10)).toThrow();
    expect(() => usageCharge('gpt-5.4-mini', { input: 1, cacheRead: 0, cacheWrite: 1, output: 0 })).toThrow();
    expect(() => usageCharge('gpt-6-astra', { input: 1, cacheRead: 0, cacheWrite: 2, output: 0 })).toThrow();
  });
  it('uses UTC calendar months, including leap days and year rollover', () => {
    expect(calendarPeriod(new Date('2028-02-29T23:59:59Z'))).toEqual({ key: '2028-02', start: new Date('2028-02-01T00:00:00Z'), end: new Date('2028-03-01T00:00:00Z') });
    expect(calendarPeriod(new Date('2026-12-31T23:30:00-02:00')).key).toBe('2027-01');
    expect(() => calendarPeriod(new Date(NaN))).toThrow();
    expect(PLANS.free.credits).toBe(200000); expect(PLANS.plus.priceUsd).toBe(49);
  });
});
