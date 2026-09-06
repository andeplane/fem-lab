// The script Worker of plan B §7.5. It gets the code and one end of a MessageChannel; sucrase
// strips the TypeScript, the code runs against a `fem` proxy whose every call crosses the port
// to the main thread's Registry, so a Command a script issues enters the Journal like a click.
// Nothing else is in scope: no DOM, no engine, no network.
import { makeFemProxy } from '@femlab/registry';
import { transform } from 'sucrase';

/** `new Function(a, b, body)` puts `body` line 1 on source line 3, and we add one wrapper line. */
const LINE_OFFSET = 3;

export interface ScriptRequest {
  code: string;
  port: MessagePort;
}
export interface ScriptCall {
  id: number;
  kind: 'dispatch' | 'query';
  payload: Record<string, unknown>;
}
export type ScriptReply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: { code: string; cause: string } };
export interface ScriptDone {
  result?: unknown;
  console: string[];
  error?: string;
}

const show = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v) ?? String(v));

/** Only what survives structuredClone goes back to the main thread. */
const plain = (v: unknown): unknown => {
  try {
    return JSON.parse(JSON.stringify(v ?? null)) as unknown;
  } catch {
    return String(v);
  }
};

/** `Error: x` plus the user's line number when the stack still carries one. */
export function describe(e: unknown): string {
  const err = e as { code?: string; cause?: string; message?: string; stack?: string };
  const head = err.code ? `${err.code}: ${err.cause}` : (err.message ?? String(e));
  const at = /<anonymous>:(\d+):\d+/.exec(err.stack ?? '');
  const line = at ? Number(at[1]) - LINE_OFFSET : 0;
  return line > 0 ? `${head} (line ${line})` : head;
}

export function runScript(code: string, port: MessagePort, done: (d: ScriptDone) => void): void {
  let next = 1;
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void }>();
  port.onmessage = (m: MessageEvent<ScriptReply>) => {
    const reply = m.data;
    const waiting = pending.get(reply.id);
    if (!waiting) return;
    pending.delete(reply.id);
    if (reply.ok) waiting.resolve(reply.value);
    else waiting.reject(Object.assign(new Error(`${reply.error.code}: ${reply.error.cause}`), reply.error));
  };
  const call = (kind: 'dispatch' | 'query', payload: Record<string, unknown>): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      port.postMessage({ id, kind, payload } satisfies ScriptCall);
    });

  const lines: string[] = [];
  const log = (...args: unknown[]): void => void lines.push(args.map(show).join(' '));
  const fem = makeFemProxy(
    (c) => call('dispatch', c),
    (q) => call('query', q),
  );
  void (async () => {
    try {
      const js = transform(code, { transforms: ['typescript'] }).code;
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const body = new Function('fem', 'console', `return (async () => {\n${js}\n})();`) as (f: unknown, c: unknown) => Promise<unknown>;
      const result = await body(fem, { log, info: log, warn: log, error: log, debug: log });
      done({ result: plain(result), console: lines });
    } catch (e) {
      done({ console: lines, error: describe(e) });
    }
  })();
}

// `self.onmessage` only exists in the real Worker; the unit test imports `runScript` directly.
if (typeof self !== 'undefined' && 'postMessage' in self) {
  self.onmessage = (e: MessageEvent<ScriptRequest>) => runScript(e.data.code, e.data.port, (d) => self.postMessage(d));
}
