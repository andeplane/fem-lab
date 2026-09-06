// `EngineTransport` over a Worker. Calls are serialised (the engine is single-instance and
// `&mut self`), progress is routed back to the caller, and cancel is terminate + recreate +
// replay of the Journal so far (plan B §4.2, §5.3).
import type { Ack, ImportAck, Command, EngineTransport, ExportSpec, ExportedFile, Field, FieldData, ModelFile, Progress, Query, QueryResult, Surface } from '@femlab/registry';
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
  committed?: (value: unknown) => void;
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
  /** Queued calls belong to the Worker generation in which they were submitted. */
  private generation = 0;
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
    const saved = structuredClone(cmd);
    return await this.call('dispatch', saved, onProgress, (value) => this.record(saved, value as Ack)) as Ack;
  }

  async query(q: Query): Promise<QueryResult> {
    return (await this.call('query', q)) as QueryResult;
  }

  async surface(): Promise<AppSurface> {
    return (await this.call('surface')) as AppSurface;
  }

  field(step: string, field: Field, component?: number): Promise<FieldData> {
    return this.call('field', { step, field, component }) as Promise<FieldData>;
  }

  async export(spec: ExportSpec): Promise<ExportedFile> {
    const { format, step } = spec;
    const ack = await this.dispatch({ cmd: 'mesh.export', format, ...(step === undefined ? {} : { step }) } as Command);
    if (ack.output.type !== 'export') throw new FemError('internal', 'mesh.export did not return a file', 'mesh.export');
    return { filename: ack.output.filename, mime: ack.output.mime, bytes: new TextEncoder().encode(ack.output.text) };
  }

  async exportFile(): Promise<ModelFile> {
    return (await this.call('exportFile')) as ModelFile;
  }

  async importFile(file: ModelFile): Promise<ImportAck> {
    const saved = structuredClone(file);
    return await this.call('importFile', saved, undefined, (value) => {
      const ack = value as ImportAck;
      this.shadow = ack.journal.entries as ShadowEntry[];
      this.revision = ack.revision;
    }) as ImportAck;
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
    this.generation++;
    this.worker.terminate();
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
    this.cancelling = false;
    // Queue the entire recovery before yielding, so a new caller cannot run between create
    // and replay. Retain the redo tail and have the Worker undo it after rebuilding history.
    const created = this.call('create', this.opts);
    const replayed = this.call('replay', { entries: this.shadow.slice(), revision: this.revision, ...this.opts });
    await Promise.all([created, replayed]);
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
      const value = res.raw ? decodeBulk({ value: res.value, buffers: res.buffers }, res.raw) : res.value;
      // Commit the shadow before exposing the acknowledgement or admitting a following call.
      p.committed?.(value);
      p.resolve(value);
    };
    worker.onerror = (e: ErrorEvent) => {
      if (worker !== this.worker) return;
      for (const [, p] of this.pending) p.reject(new FemError('internal', `the engine Worker failed: ${e.message}`, 'engine.worker'));
      this.pending.clear();
    };
    return worker;
  }

  private call(op: AppOp, payload?: unknown, onProgress?: (p: Progress) => void, committed?: (value: unknown) => void): Promise<unknown> {
    const generation = this.generation;
    const run = () =>
      new Promise<unknown>((resolve, reject) => {
        if (this.cancelling || generation !== this.generation) return reject(new FemError('cancelled', 'the engine is restarting', null, 'retry once the Model has replayed'));
        const id = this.nextId++;
        this.pending.set(id, { resolve, reject, ...(onProgress ? { onProgress } : {}), ...(committed ? { committed } : {}) });
        this.worker.postMessage({ id, op, payload } satisfies AppReq);
      });
    // Queue, but never let one caller's rejection break the chain for the next.
    const next = this.tail.then(run, run).catch((e: unknown) => this.recover(e));
    this.tail = next.catch(() => undefined);
    return next;
  }

  private record(cmd: Command, ack: Ack): void {
    // Undo/redo report seq == revision, but are not Journal entries themselves.
    if (cmd.cmd !== 'journal.undo' && cmd.cmd !== 'journal.redo') {
      this.shadow.length = ack.seq;
      this.shadow.push({ seq: ack.seq, cmd, hashAfter: ack.hash });
    }
    this.revision = ack.revision;
  }
}
