import type { EngineError } from './generated/engine';

export type ErrorCode = EngineError['code'];

/**
 * The one error shape of the whole system: the engine's `Error` schema, thrown as a JS Error so
 * hosts can `catch` it and the AI can read `code`, `cause`, `where` and `suggestion` unchanged.
 */
export class FemError extends Error implements EngineError {
  override readonly name = 'FemError';
  constructor(
    readonly code: ErrorCode,
    override readonly cause: string,
    readonly where: string | null = null,
    readonly suggestion: string | null = null,
  ) {
    super(`${code}: ${cause}`);
  }

  toJSON(): EngineError {
    return { code: this.code, cause: this.cause, where: this.where, suggestion: this.suggestion };
  }
}

/** Names sharing the namespace of `name` (`geometry.*`), or all of them; for `suggestion` texts. */
export function nearest(name: string, known: Iterable<string>): string {
  const all = [...known];
  const ns = name.split('.')[0];
  const same = all.filter((k) => k.split('.')[0] === ns);
  return (same.length > 0 ? same : all).join(', ');
}
