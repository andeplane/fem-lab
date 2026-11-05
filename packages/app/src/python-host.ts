// Typed, bounded RPC between the owning registry Producer and a disposable Python worker.
import { FemError, type ScriptResult } from '@femlab/registry';
import type { Call } from './script-host';
import schema from '../../registry/src/generated/runtime-schema';
const engineCommands = new Set<string>(schema.commands.oneOf.map(variant => variant.properties.cmd.const));
const engineQueries = new Set<string>(schema.queries.oneOf.map(variant => variant.properties.query.const));
export interface PythonResult extends ScriptResult { plots?: string[] }
export class PythonHost {
  private worker: Worker | null = null;
  private finish: ((result: PythonResult) => void) | null = null;
  constructor(private readonly spawn: () => Worker, private readonly dispatch: Call, private readonly query: Call) {}
  get running(): boolean { return this.worker !== null; }
  run(code: string, timeoutMs = 30_000): Promise<PythonResult> {
    if (this.worker) throw new FemError('unsupported', 'a Python notebook is already running', 'script.run');
    if (code.length > 64_000 || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) return Promise.resolve({ result: null, console: [], error: 'Python source limit is 64000 characters; execution deadline is 1..30000 ms' });
    const worker = this.spawn(); this.worker = worker;
    const lines: string[] = []; const plots: string[] = [];
    let active = true, messages = 0, bytes = 0;
    // The separate startup deadline allows the optional Python/numpy download on a cold cache.
    let timer: ReturnType<typeof setTimeout>;
    return new Promise(resolve => {
      const settle = (value: PythonResult): void => {
        if (!active) return; active = false; clearTimeout(timer); worker.terminate(); this.worker = null; this.finish = null;
        resolve({ ...value, plots });
      };
      const fail = (error: unknown) => settle({ result: null, console: lines, error: error instanceof Error ? error.message : String(error) });
      this.finish = settle;
      timer = setTimeout(() => fail('Python could not initialize within 120000 ms; check network access and try again'), 120_000);
      worker.onerror = event => fail(event.message);
      worker.onmessage = async (event: MessageEvent<unknown>) => {
        if (!active) return;
        if (++messages > 10_000) { fail('Python exceeded its message limit'); return; }
        const msg = event.data as { kind?: string; id?: number; op?: string; payload?: Record<string, unknown>; value?: unknown };
        if (msg.kind === 'ready') { clearTimeout(timer); timer = setTimeout(() => fail(`Python did not finish within ${timeoutMs} ms`), timeoutMs); worker.postMessage({ kind: 'run', code }); }
        else if (msg.kind === 'log' || msg.kind === 'plot') {
          if (typeof msg.value !== 'string') { fail('invalid Python output'); return; }
          bytes += new TextEncoder().encode(msg.value).byteLength;
          if (bytes > 8 * 1024 * 1024) { fail('Python output exceeds 8 MiB'); return; }
          if (msg.kind === 'plot') plots.push(msg.value); else lines.push(msg.value);
        } else if (msg.kind === 'done') settle({ result: null, console: lines });
        else if (msg.kind === 'failed') fail(msg.value);
        else if (msg.kind === 'rpc') {
          if (!Number.isSafeInteger(msg.id) || !msg.payload || typeof msg.payload !== 'object' || Array.isArray(msg.payload) || !['dispatch', 'query'].includes(msg.op ?? '')) { fail('invalid Python registry call'); return; }
          const payload = msg.payload;
          const name = payload[msg.op === 'query' ? 'query' : 'cmd'];
          // Python is an analysis client, not a route into credentials, account changes or scripts.
          if (typeof name !== 'string' || !(msg.op === 'query' ? engineQueries : engineCommands).has(name)) {
            worker.postMessage({ kind: 'reply', id: msg.id, error: 'Python may only call engine Commands and Queries' }); return;
          }
          try {
            if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > 1024 * 1024) throw new FemError('unsupported', 'Python RPC request exceeds 1 MiB', 'script.run');
            const value = await (msg.op === 'query' ? this.query : this.dispatch)(payload);
            if (!active) return;
            const data = value as Record<string, unknown>;
            // Preserve scientific f64 fields across the worker boundary without JSON encoding
            // or renderer f32 conversion. Python receives a numpy view of this transferred buffer.
            if (name === 'query.field' && Array.isArray(data?.values)) {
              const values = Float64Array.from(data.values as number[]);
              worker.postMessage({ kind: 'reply', id: msg.id, value: { ...data, values } }, [values.buffer]);
            } else worker.postMessage({ kind: 'reply', id: msg.id, value });
          } catch (error) { if (active) worker.postMessage({ kind: 'reply', id: msg.id, error: error instanceof Error ? error.message : String(error) }); }
        } else fail('invalid Python worker message');
      };
      worker.postMessage({ kind: 'init' });
    });
  }
  stop(): void { this.finish?.({ result: null, console: [], error: 'stopped' }); }
}
