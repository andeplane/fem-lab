// The main-thread half of script.run: a disposable Worker owns QuickJS and this host admits
// only bounded JSON registry calls while the run is active.
import {
  FemError,
  type Ack,
  type Command,
  type JournalEntry,
  type ScriptResult,
  type ScriptValidator,
  type ScriptValidation,
} from '@femlab/registry';
import { z } from 'zod';
import type { ScriptCall, ScriptReply, ScriptRequest } from './script.worker';

export type Call = (payload: Record<string, unknown>) => Promise<unknown>;

export const SCRIPT_TIMEOUT_MS = 30_000;
export const SCRIPT_MESSAGE_BYTES = 1024 * 1024;
export const SCRIPT_MAX_MESSAGES = 10_000;
export const SCRIPT_SOURCE_CHARACTERS = 64_000;

const encoder = new TextEncoder();
const messageTooLarge = (text: string): boolean =>
  text.length > SCRIPT_MESSAGE_BYTES || encoder.encode(text).byteLength > SCRIPT_MESSAGE_BYTES;

const requestId = z.number().int().nonnegative();
const messageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('done'), value: z.unknown() }),
  z.object({ kind: z.literal('failed'), value: z.object({ message: z.string(), stack: z.string().optional() }) }),
  z.object({ kind: z.literal('log'), value: z.string() }),
  z.object({ kind: z.literal('timer'), id: requestId, value: z.number().finite() }),
  z.object({ kind: z.literal('dispatch'), id: requestId, value: z.object({ cmd: z.string() }).catchall(z.unknown()) }),
  z.object({ kind: z.literal('query'), id: requestId, value: z.object({ query: z.string() }).catchall(z.unknown()) }),
]);

/** Preserve structured registry errors without importing the lazy script runtime. */
function describe(error: unknown): string {
  const value = error as { code?: string; cause?: string; message?: string; stack?: string };
  const head = value?.code ? `${value.code}: ${value.cause}` : (value?.message ?? String(error));
  const at = /(?:script.js|<anonymous>):(\d+)(?::\d+)?/.exec(value?.stack ?? '');
  const line = at ? Number(at[1]) - (at[0].startsWith('script.js') ? 1 : 3) : 0;
  return line > 0 ? `${head} (line ${line})` : head;
}

export class ScriptHost {
  private worker: Worker | null = null;
  /** Resolves the run in flight; `stop()` and the timeout settle it too. */
  private finish: ((result: ScriptResult) => void) | null = null;

  constructor(
    private readonly spawn: () => Worker,
    private readonly dispatch: Call,
    private readonly query: Call,
    private readonly validator?: ScriptValidator,
  ) {}

  validate(code: string, timeoutMs?: number): Promise<ScriptValidation> {
    if (!this.validator) throw new FemError('unsupported', 'no validation Worker is available', 'query.validateScript', 'use a host with a script validator');
    return this.validator.validate(code, timeoutMs);
  }

  get running(): boolean {
    return this.worker !== null || this.validator?.running === true;
  }

  run(code: string, timeoutMs = SCRIPT_TIMEOUT_MS): Promise<ScriptResult> {
    if (this.worker) throw new FemError('unsupported', 'a script is already running', 'script.run', 'stop it with script.stop first');
    if (code.length > SCRIPT_SOURCE_CHARACTERS) {
      return Promise.resolve({ result: null, console: [], error: `script exceeds ${SCRIPT_SOURCE_CHARACTERS} characters` });
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > SCRIPT_TIMEOUT_MS) {
      return Promise.resolve({ result: null, console: [], error: 'script timeout must be greater than 0 and at most 30000 ms' });
    }

    let worker: Worker;
    try {
      worker = this.spawn();
    } catch (error) {
      return Promise.resolve({ result: null, console: [], error: describe(error) });
    }
    this.worker = worker;
    const { port1, port2 } = new MessageChannel();
    const journalEntries: JournalEntry[] = [];
    const lines: string[] = [];
    const timers: ReturnType<typeof setTimeout>[] = [];
    const deadline = performance.now() + timeoutMs;
    let active = true;
    let messages = 0;
    let output = 0;

    return new Promise<ScriptResult>((resolve) => {
      const settle = (result: ScriptResult): void => {
        if (!active) return;
        active = false;
        this.finish = null;
        for (const timer of timers) clearTimeout(timer);
        port1.close();
        worker.terminate();
        this.worker = null;
        resolve(journalEntries.length > 0 ? { ...result, journalEntries } : result);
      };
      const timeout = (): void => settle({ result: null, console: lines, error: `the script did not finish within ${timeoutMs} ms` });
      const open = (): boolean => {
        if (active && performance.now() >= deadline) timeout();
        return active;
      };
      const post = (reply: ScriptReply): void => {
        if (!open()) return;
        let text: string;
        try {
          text = JSON.stringify(reply);
        } catch (error) {
          text = JSON.stringify({ id: reply.id, error: `script RPC reply is not JSON: ${describe(error)}` });
        }
        if (messageTooLarge(text)) text = JSON.stringify({ id: reply.id, error: 'script RPC reply exceeds 1 MiB' });
        port1.postMessage(text);
      };
      const invoke = (message: ScriptCall): void => {
        if (!open()) return;
        if (message.kind === 'dispatch' && message.value['cmd'] === 'script.run') {
          post({ id: message.id, error: 'nested script.run is not permitted' });
          return;
        }
        const run = message.kind === 'query' ? this.query : this.dispatch;
        void run(message.value).then(
          (value) => {
            if (!open()) return;
            const ack = value as Partial<Ack> | null;
            const cmd = message.value[message.kind === 'dispatch' ? 'cmd' : 'query'];
            if (message.kind === 'dispatch' && typeof cmd === 'string' && !cmd.startsWith('journal.') && typeof ack?.seq === 'number' && typeof ack.hash === 'string') {
              journalEntries.push({ seq: ack.seq, cmd: message.value as Command, hashAfter: ack.hash });
            }
            post({ id: message.id, value });
          },
          (error: unknown) => post({ id: message.id, error: describe(error) }),
        );
      };

      this.finish = settle;
      timers.push(setTimeout(timeout, Math.max(0, deadline - performance.now())));
      port1.onmessage = (event: MessageEvent<unknown>) => {
        if (!open()) return;
        const text = event.data;
        if (++messages > SCRIPT_MAX_MESSAGES || typeof text !== 'string' || messageTooLarge(text)) {
          settle({ result: null, console: lines, error: 'script exceeded its message limit' });
          return;
        }
        let message: z.infer<typeof messageSchema>;
        try {
          message = messageSchema.parse(JSON.parse(text));
        } catch {
          settle({ result: null, console: lines, error: 'invalid script runtime message' });
          return;
        }
        if (message.kind === 'done') settle({ result: message.value ?? null, console: lines });
        else if (message.kind === 'failed') settle({ result: null, console: lines, error: describe(message.value) });
        else if (message.kind === 'log') {
          output += encoder.encode(message.value).byteLength;
          if (output > SCRIPT_MESSAGE_BYTES) settle({ result: null, console: lines, error: 'script exceeded its console limit' });
          else lines.push(message.value);
        } else if (message.kind === 'timer') {
          timers.push(setTimeout(() => post({ id: message.id, timer: true }), Math.max(0, message.value)));
        } else invoke(message);
      };
      worker.onerror = (event: ErrorEvent) => settle({ result: null, console: lines, error: `the script Worker failed: ${event.message}` });
      worker.postMessage({ code, port: port2 } satisfies ScriptRequest, [port2]);
    });
  }

  /** Commands the script already dispatched stay in the Journal; `journal.undo` takes them back. */
  stop(): void {
    this.validator?.stop();
    this.finish?.({ result: null, console: [], error: 'stopped' });
  }
}
