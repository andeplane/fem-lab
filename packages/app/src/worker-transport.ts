// `EngineTransport` over a Worker. Calls are serialised (the engine is single-instance and
// `&mut self`), progress is routed back to the caller, and cancel is terminate + recreate +
// replay of the Journal so far (plan B §4.2, §5.3).
import type { Ack, Command, EngineTransport, ExportSpec, ExportedFile, Field, FieldData, FrameResult, ModelFile, Progress, Query, QueryResult, Surface } from '@femlab/registry';
import { FemError, decodeBulk } from '@femlab/registry';
import type { AppOp, AppReq, AppRes } from './protocol';

export interface EngineOptions {
  gpu: boolean;
  threads: number;
}

/** `Surface` plus the one fact only the engine knows: whether it drew the Mesh or the geometry. */
export interface AppSurface extends Surface {
  source: 'mesh' | 'geometry';
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: unknown): void;
  onProgress?: (p: Progress) => void;
}

/** One Journal entry as `replay_hashes` wants it. */
interface ShadowEntry {
  seq: number;
  cmd: Command;
  hashAfter: string;
}

export class WorkerTransport implements EngineTransport {
  private worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** The queue: every call waits for the previous one to settle. */
  private tail: Promise<unknown> = Promise.resolve();
  /**
   * Journal shadow for cancel-by-replay. Append-only in `seq` order, so an undo (which only
   * lowers `revision`) keeps the entries a redo needs; a new Command after an undo overwrites
   * the tail at its own `seq`.
   */
  private shadow: ShadowEntry[] = [];
  private revision = 0;
  /** Set while `cancel()` is tearing the worker down, so in-flight calls reject as `cancelled`. */
  private cancelling = false;
  /** Set while a crash is being recovered from, so the replay's own calls are not recovered. */
  private restarting = false;
  /**
   * One sink for every progress message. Calls are serialised, so at most one Command can be
   * reporting at a time and the app needs no per-call plumbing to drive `Solving n %`.
   */
  private sink: ((p: Progress) => void) | null = null;

  constructor(
    private readonly spawn: () => Worker,
    private readonly opts: EngineOptions,
  ) {
    this.worker = this.wire(spawn());
  }

  /** Where every Command's progress goes; the app renders the last message it saw. */
  onProgress(cb: (p: Progress) => void): void {
    this.sink = cb;
  }

  /** Boots the wasm module; resolves with the engine version. */
  async init(): Promise<{ engineVersion: string }> {
    return (await this.call('create', this.opts)) as { engineVersion: string };
  }

  async dispatch(cmd: Command, onProgress?: (p: Progress) => void): Promise<Ack> {
    const ack = (await this.call('dispatch', cmd, onProgress)) as Ack;
    this.record(cmd, ack);
    return ack;
  }

  async query(q: Query): Promise<QueryResult> {
    const value = await this.call('query', q);
    if (q.query === 'query.frame') {
      const frame = value as Omit<FrameResult, 'values'> & { values: Float64Array };
      // The public schema is JSON (number[]), in every host. The wire uses an f64 staging
      // buffer only; converting here preserves scientific precision and the registry type.
      return { ...frame, values: Array.from(frame.values) };
    }
    return value as QueryResult;
  }

  async surface(): Promise<AppSurface> {
    return (await this.call('surface')) as AppSurface;
  }

  field(step: string, field: Field, component?: number): Promise<FieldData> {
    return this.call('field', { step, field, component }) as Promise<FieldData>;
  }

  export(spec: ExportSpec): Promise<ExportedFile> {
    return this.call('export', spec) as Promise<ExportedFile>;
  }

  async exportFile(): Promise<ModelFile> {
    return (await this.call('exportFile')) as ModelFile;
  }

  async importFile(file: ModelFile): Promise<Ack> {
    const ack = (await this.call('importFile', file)) as Ack;
    this.shadow = (file.journal?.entries ?? []) as unknown as ShadowEntry[];
    this.revision = ack.revision;
    return ack;
  }

  /** Σ i for i in 1..=n on the engine's GPU; the `gpu` smoke calls it through `window.fem`. */
  gpuSelfTest(n: number): Promise<number> {
    return this.call('gpuSelfTest', { n }) as Promise<number>;
  }

  /**
   * There is no way to interrupt wasm from outside, so cancelling is: kill the Worker, start a
   * new one, and replay the Journal without its solves.
   */
  async cancel(): Promise<void> {
    this.cancelling = true;
    for (const [, p] of this.pending) p.reject(new FemError('cancelled', 'the running Command was cancelled', null, 'the Model is back at the last completed Command'));
    this.cancelling = false;
    await this.restart();
  }

  /** Kill the Worker, start a new one and replay the Journal up to the acknowledged revision. */
  private async restart(): Promise<void> {
    this.worker.terminate();
    this.pending.clear();
    this.tail = Promise.resolve();
    this.worker = this.wire(this.spawn());
    await this.call('create', this.opts);
    await this.call('replay', { entries: this.shadow.slice(0, this.revision), ...this.opts });
  }

  /**
   * A Rust panic in wasm leaves the Engine's borrow flag set, so the Command that panicked and
   * every Command after it fail with `recursive use of an object`: the Worker is dead and only
   * a restart brings it back. The failing Command gets one structured error, the Commands after
   * it get a working engine at the last acknowledged revision (issue #54).
   */
  private async recover(e: unknown): Promise<never> {
    const message = e instanceof FemError ? e.cause : e instanceof Error ? e.message : String(e);
    if (this.restarting || !/recursive use of an object|unreachable/.test(message)) throw e;
    this.restarting = true;
    try {
      await this.restart();
    } finally {
      this.restarting = false;
    }
    throw new FemError('internal', `the engine restarted after a crash: ${message}`, 'engine.worker', 'the Model is back at the last completed Command; change that Command before running it again');
  }

  private wire(worker: Worker): Worker {
    worker.onmessage = (e: MessageEvent<AppRes & { raw?: ArrayBuffer[] }>) => {
      const res = e.data;
      const p = this.pending.get(res.id);
      if (!p) return;
      if ('progress' in res) {
        p.onProgress?.(res.progress);
        this.sink?.(res.progress);
        return;
      }
      this.pending.delete(res.id);
      if (!res.ok) return p.reject(new FemError(res.error.code, res.error.cause, res.error.where ?? null, res.error.suggestion ?? null));
      p.resolve(res.raw ? decodeBulk({ value: res.value, buffers: res.buffers }, res.raw) : res.value);
    };
    worker.onerror = (e: ErrorEvent) => {
      for (const [, p] of this.pending) p.reject(new FemError('internal', `the engine Worker failed: ${e.message}`, 'engine.worker'));
      this.pending.clear();
    };
    return worker;
  }

  private call(op: AppOp, payload?: unknown, onProgress?: (p: Progress) => void): Promise<unknown> {
    const run = () =>
      new Promise<unknown>((resolve, reject) => {
        if (this.cancelling) return reject(new FemError('cancelled', 'the engine is restarting', null, 'retry once the Model has replayed'));
        const id = this.nextId++;
        this.pending.set(id, { resolve, reject, ...(onProgress ? { onProgress } : {}) });
        this.worker.postMessage({ id, op, payload } satisfies AppReq);
      });
    // Queue, but never let one caller's rejection break the chain for the next.
    const next = this.tail.then(run, run).catch((e: unknown) => this.recover(e));
    this.tail = next.catch(() => undefined);
    return next;
  }

  private record(cmd: Command, ack: Ack): void {
    // undo/redo report the new revision and `seq: -1`; every other Command lands at its `seq`.
    if (ack.seq >= 0) {
      this.shadow.length = ack.seq;
      this.shadow.push({ seq: ack.seq, cmd, hashAfter: ack.hash });
    }
    this.revision = ack.revision;
  }
}
