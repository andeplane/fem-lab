// `run_script`: TypeScript against the `fem` API, the same contract as the app's script Worker
// (plan B §7.5). sucrase strips the types, the code runs against the registry proxy, and the
// Commands it issues enter the Journal exactly as a tool call would.
import { makeFemProxy, type Dispatch, type QueryFn } from '@femlab/registry';
import { transform } from 'sucrase';

/** `new Function(a, b, body)` puts `body` line 1 on source line 3, and we add one wrapper line. */
const LINE_OFFSET = 3;

/** A script that has not finished in this long is not going to; PLAN 4.10. */
export const SCRIPT_TIMEOUT_MS = 30_000;

export interface ScriptOutcome {
  result?: unknown;
  console: string[];
  error?: string;
}

const show = (v: unknown): string => (typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v)));

/** Only what survives JSON goes back over the wire. */
const plain = (v: unknown): unknown => {
  try {
    return JSON.parse(JSON.stringify(v ?? null)) as unknown;
  } catch {
    return String(v);
  }
};

/** `code: cause` plus the line the person wrote, when the stack still carries one. */
export function describe(e: unknown): string {
  const err = e as { code?: string; cause?: string; message?: string; stack?: string };
  const head = err.code ? `${err.code}: ${err.cause}` : (err.message ?? String(e));
  const at = /<anonymous>:(\d+):\d+/.exec(err.stack ?? '');
  const line = at ? Number(at[1]) - LINE_OFFSET : 0;
  return line > 0 ? `${head} (line ${line})` : head;
}

/**
 * Run `code` against `fem` and report `{ result, console, error? }`.
 *
 * ponytail: the timeout abandons the script rather than killing it — Node has no way to stop
 * synchronous code outside a Worker, and the engine call the script is waiting on is the only
 * thing it can be stuck in. Move it to a `worker_threads` Worker if a runaway loop ever matters.
 */
export async function runScript(
  code: string,
  dispatch: Dispatch,
  query: QueryFn,
  timeoutMs = SCRIPT_TIMEOUT_MS,
): Promise<ScriptOutcome> {
  const lines: string[] = [];
  const log = (...args: unknown[]): void => void lines.push(args.map(show).join(' '));
  const console = { log, info: log, warn: log, error: log, debug: log };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the script did not finish within ${timesecs(timeoutMs)}`)), timeoutMs);
  });
  try {
    const js = transform(code, { transforms: ['typescript'] }).code;
    const body = new Function('fem', 'console', `return (async () => {\n${js}\n})();`) as (
      f: unknown,
      c: unknown,
    ) => Promise<unknown>;
    const result = await Promise.race([body(makeFemProxy(dispatch, query), console), expired]);
    return { result: plain(result), console: lines };
  } catch (e) {
    return { console: lines, error: describe(e) };
  } finally {
    clearTimeout(timer);
  }
}

const timesecs = (ms: number): string => `${ms / 1000} s`;
