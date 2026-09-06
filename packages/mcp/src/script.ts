import type { Dispatch, QueryFn } from '@femlab/registry';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';

export const SCRIPT_TIMEOUT_MS = 30_000;
const MAX_MESSAGES = 10_000;
const MAX_OUTPUT = 1024 * 1024;

export interface ScriptOutcome {
  result?: unknown;
  console: string[];
  error?: string;
}

const requestId = z.number().int().nonnegative();
const messageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('done'), value: z.unknown() }),
  z.object({ kind: z.literal('failed'), value: z.object({ message: z.string(), stack: z.string().optional() }) }),
  z.object({ kind: z.literal('log'), value: z.string() }),
  z.object({ kind: z.literal('timer'), id: requestId, value: z.number().finite() }),
  z.object({ kind: z.literal('dispatch'), id: requestId, value: z.object({ cmd: z.string() }).catchall(z.unknown()) }),
  z.object({ kind: z.literal('query'), id: requestId, value: z.object({ query: z.string() }).catchall(z.unknown()) }),
]);

/** Worker and clock are host dependencies, replaceable by typed fakes. */
export interface ScriptWorker {
  on(event: 'message', listener: (value: unknown) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  postMessage(value: string): void;
  terminate(): Promise<number>;
}
export interface ScriptDeps {
  launch(code: string): ScriptWorker;
  now(): number;
  later(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  cancel(timer: ReturnType<typeof setTimeout>): void;
}
const system: ScriptDeps = {
  launch: (code) => new Worker(new URL('../dist/script-worker.js', import.meta.url), { workerData: code, resourceLimits: { maxOldGenerationSizeMb: 128 } }),
  now: () => performance.now(),
  later: (fn, ms) => setTimeout(fn, ms),
  cancel: (timer) => clearTimeout(timer),
};

/** Preserve registry causes and map the wrapper's line back to the person's source. */
export function describe(e: unknown): string {
  const err = e as { code?: string; cause?: string; message?: string; stack?: string };
  const head = err?.code ? `${err.code}: ${err.cause}` : (err?.message ?? String(e));
  const at = /(?:script.js|<anonymous>):(\d+)(?::\d+)?/.exec(err?.stack ?? '');
  const line = at ? Number(at[1]) - (at[0].startsWith('script.js') ? 1 : 3) : 0;
  return line > 0 ? `${head} (line ${line})` : head;
}

/**
 * QuickJS in a disposable Worker: only JSON registry calls, console and timers cross the
 * boundary. Deadline starts before launch. Closing the gate precedes termination, so queued
 * messages and late RPC replies cannot schedule more Commands. Admitted Commands may finish.
 */
export async function runScript(
  code: string,
  dispatch: Dispatch,
  query: QueryFn,
  timeoutMs = SCRIPT_TIMEOUT_MS,
  deps: ScriptDeps = system,
): Promise<ScriptOutcome> {
  const lines: string[] = [];
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > SCRIPT_TIMEOUT_MS) {
    return { console: lines, error: 'script timeout must be greater than 0 and at most 30000 ms' };
  }
  const deadline = deps.now() + timeoutMs;
  const timers: ReturnType<typeof setTimeout>[] = [];
  let worker: ReturnType<ScriptDeps['launch']>;
  try { worker = deps.launch(code); }
  catch (error) { return { console: lines, error: describe(error) }; }
  return new Promise((resolve) => {
    let active = true;
    let messages = 0;
    let output = 0;
    const finish = (outcome: ScriptOutcome) => {
      if (!active) return;
      active = false;
      for (const timer of timers) deps.cancel(timer);
      void worker.terminate().then(
        () => resolve(outcome),
        (error: unknown) => resolve({ console: lines, error: `script runtime termination failed: ${describe(error)}` }),
      );
    };
    const timeout = () => finish({ console: lines, error: `the script did not finish within ${timeoutMs / 1000} s` });
    const open = () => {
      if (active && deps.now() >= deadline) timeout();
      return active;
    };
    const reply = (value: unknown) => { if (open()) worker.postMessage(JSON.stringify(value)); };
    timers.push(deps.later(timeout, Math.max(0, deadline - deps.now())));
    worker.on('error', (error) => finish({ console: lines, error: describe(error) }));
    worker.on('exit', (code) => finish({ console: lines, error: `script runtime exited (${code})` }));
    worker.on('message', (text: unknown) => {
      if (!open()) return;
      if (++messages > MAX_MESSAGES || typeof text !== 'string' || text.length > MAX_OUTPUT) {
        finish({ console: lines, error: 'script exceeded its message limit' });
        return;
      }
      let message: z.infer<typeof messageSchema>;
      try { message = messageSchema.parse(JSON.parse(text)); }
      catch { finish({ console: lines, error: 'invalid script runtime message' }); return; }
      const { kind, value } = message;
      if (kind === 'done') finish({ console: lines, result: value });
      else if (kind === 'failed') finish({ console: lines, error: describe(value) });
      else if (kind === 'log') {
        output += String(value).length;
        if (output > MAX_OUTPUT) finish({ console: lines, error: 'script exceeded its console limit' });
        else lines.push(String(value));
      } else if (kind === 'timer') {
        timers.push(deps.later(() => reply({ id: message.id, timer: true }), Math.max(0, value)));
      } else {
        const id = message.id;
        void (async () => {
          try {
            if (message.kind === 'dispatch' && message.value.cmd === 'script.run') throw new Error('nested script.run is not permitted');
            const result = await (message.kind === 'dispatch' ? dispatch(message.value) : query(message.value));
            reply({ id, value: result });
          } catch (error) { reply({ id, error: describe(error) }); }
        })();
      }
    });
  });
}
