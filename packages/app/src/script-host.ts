// The main-thread half of `script.run` (plan B §7.5): spawn the script Worker, keep one end of a
// MessageChannel wired to the Registry so the script's `fem` calls are real Commands, and kill
// the Worker on `script.stop` or the timeout. The Worker factory is injected, so the unit test
// drives the whole protocol with a fake.
import { FemError, type ScriptResult } from '@femlab/registry';
import type { ScriptCall, ScriptDone, ScriptReply } from './script.worker';

export type Call = (payload: Record<string, unknown>) => Promise<unknown>;

const DEFAULT_TIMEOUT = 60_000;

export class ScriptHost {
  private worker: Worker | null = null;
  /** Resolves the run in flight; `stop()` and the timeout settle it too. */
  private finish: ((r: ScriptResult) => void) | null = null;

  constructor(
    private readonly spawn: () => Worker,
    private readonly dispatch: Call,
    private readonly query: Call,
  ) {}

  get running(): boolean {
    return this.worker !== null;
  }

  run(code: string, timeoutMs = DEFAULT_TIMEOUT): Promise<ScriptResult> {
    if (this.worker) throw new FemError('unsupported', 'a script is already running', 'script.run', 'stop it with script.stop first');
    const worker = this.spawn();
    this.worker = worker;
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = (e: MessageEvent<ScriptCall>) => {
      const { id, kind, payload } = e.data;
      const run = kind === 'query' ? this.query : this.dispatch;
      run(payload).then(
        (value) => port1.postMessage({ id, ok: true, value } satisfies ScriptReply),
        (e: unknown) => {
          const err = e as { code?: string; cause?: string; message?: string };
          port1.postMessage({ id, ok: false, error: { code: err.code ?? 'internal', cause: err.cause ?? err.message ?? String(e) } } satisfies ScriptReply);
        },
      );
    };

    return new Promise<ScriptResult>((resolve) => {
      const settle = (r: ScriptResult): void => {
        if (!this.finish) return;
        this.finish = null;
        clearTimeout(timer);
        port1.close();
        this.worker?.terminate();
        this.worker = null;
        resolve(r);
      };
      this.finish = settle;
      const timer = setTimeout(() => settle({ result: null, console: [], error: `the script did not finish within ${timeoutMs} ms` }), timeoutMs);
      worker.onmessage = (e: MessageEvent<ScriptDone>) => settle({ result: e.data.result ?? null, console: e.data.console, ...(e.data.error ? { error: e.data.error } : {}) });
      worker.onerror = (e: ErrorEvent) => settle({ result: null, console: [], error: `the script Worker failed: ${e.message}` });
      worker.postMessage({ code, port: port2 }, [port2]);
    });
  }

  /** Commands the script already dispatched stay in the Journal; `journal.undo` takes them back. */
  stop(): void {
    this.finish?.({ result: null, console: [], error: 'stopped' });
  }
}
