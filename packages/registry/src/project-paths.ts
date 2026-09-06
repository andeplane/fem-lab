import { FemError } from './error';

/** Split on `/` or `\`, dropping empty and `.` segments. Does not judge; see `assertInside`. */
export function normalisePath(p: string): string[] {
  return p.split(/[\\/]/).filter((s) => s !== '' && s !== '.');
}

/**
 * The path check behind every `file.*` Command: relative, inside the project folder, no `..`, no
 * drive letter, no `:` or control characters in a segment. Returns the normalised segments.
 * Scoping is structural too (handles are walked segment by segment); this gives a clean `file.scope`
 * error instead of a browser exception.
 */
export function assertInside(p: string): string[] {
  const refuse = (cause: string) => new FemError('file.scope', cause, `path '${p}'`, 'use a path relative to the project folder, like `reports/beam.md`');
  if (/^[\\/]/.test(p) || /^[A-Za-z]:/.test(p)) throw refuse('absolute paths are outside the project folder');
  const segments = normalisePath(p);
  if (segments.length === 0) throw refuse('the path is empty');
  for (const s of segments) {
    if (s === '..') throw refuse('`..` would leave the project folder');
    // eslint-disable-next-line no-control-regex
    if (/[:\x00-\x1f\x7f]/.test(s)) throw refuse(`segment '${s}' contains a character that is not allowed`);
  }
  return segments;
}
