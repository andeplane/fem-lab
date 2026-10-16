import { FemError } from './error';

/** Encode finite scientific data without losing IEEE signed zero. Current Chromium and Node
 * provide JSON.rawJSON; normal JSON escaping still owns all strings and object keys. */
export function scientificJson(value: unknown, space?: string | number): string {
  const text = JSON.stringify(value, (_key, child: unknown) => {
    if (typeof child !== 'number') return child;
    if (!Number.isFinite(child)) throw new FemError('schema', 'scientific JSON requires finite numbers', 'json');
    return Object.is(child, -0) ? (JSON as typeof JSON & { rawJSON(text: string): unknown }).rawJSON('-0.0') : child;
  }, space);
  if (text === undefined) throw new FemError('schema', 'scientific JSON requires a JSON value', 'json');
  return text;
}
