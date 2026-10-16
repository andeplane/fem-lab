import {expect,it} from 'vitest';
import {PUBLIC_CREDIT_UNIT,PUBLIC_PLAN_CREDITS,legacyCreditsToPublic} from '../src/credit-units';
it('declares supplier-dollar credits and preserves fractional legacy usage',()=>{
  expect(PUBLIC_CREDIT_UNIT).toBe('usd-milli-v1');
  expect(PUBLIC_PLAN_CREDITS).toEqual({free:5000,plus:7500,pro:12000,studio:37500});
  expect(legacyCreditsToPublic(0)).toBe(0);
  expect(legacyCreditsToPublic(112)).toBe(0.084);
  expect(legacyCreditsToPublic(6_666_666)).toBe(4999.9995);
  expect(legacyCreditsToPublic(10_000_000)).toBe(7500);
});
