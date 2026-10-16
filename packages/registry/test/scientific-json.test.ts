import { expect, it } from 'vitest';
import { scientificJson } from '../src';

it('retains finite f64 bits, signed zero, ordinary JSON types and exact string escaping', () => {
  const values = [-0, 0, Number.MIN_VALUE, Number.MAX_VALUE, Math.PI, -1.234567890123456e-200];
  const text = 'literal -0, {"rawJSON":"-0"}, quote " slash \\ newline\n ☃';
  const value = { values, text, yes: true, no: false, empty: null, nested: { zero: -0 } };
  const decoded = JSON.parse(scientificJson(value)) as typeof value;
  expect(new Uint8Array(new Float64Array(decoded.values).buffer))
    .toEqual(new Uint8Array(new Float64Array(values).buffer));
  expect(Object.is(decoded.nested.zero, -0)).toBe(true);
  expect(decoded.text).toBe(text);
  expect(decoded.yes).toBe(true); expect(decoded.no).toBe(false); expect(decoded.empty).toBeNull();
});

it.each([NaN, Infinity, -Infinity])('rejects nonfinite scientific numbers instead of saving null: %s', value => {
  expect(() => scientificJson({ frames: [value] })).toThrow('finite numbers');
});

it('preserves pretty JSON indentation without altering ordinary values', () => {
  const value = { amount: 1e20, text: 'unchanged' };
  expect(scientificJson(value, 2)).toBe(JSON.stringify(value, null, 2));
  expect(scientificJson(value, '\t')).toBe(JSON.stringify(value, null, '\t'));
});

it('rejects a missing top-level JSON value', () => {
  expect(() => scientificJson(undefined)).toThrow('requires a JSON value');
});
