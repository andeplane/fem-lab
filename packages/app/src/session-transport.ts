// A channel never changes Workers. A producer never acquires a different session implicitly.
import { decodeBulk, FemError, type Ack, type Command, type DocumentSnapshot, type EngineTransport, type ExecutionContext, type ExportedFile, type ExportSpec, type Field, type FieldData, type ImportAck, type ModelFile, type Progress, type Query, type QueryResult, type ResultField, type RunLease, type SessionRef, type Stamp } from '@femlab/registry';
import type { AppSurface } from './worker-transport';
import type { ReplacementSource, SessionMessage, SessionOptions, SessionRequest, SessionResponse } from './session-protocol';

export const sameSession = (a: SessionRef, b: SessionRef): boolean => a.backendEpoch === b.backendEpoch && a.sessionId === b.sessionId;
export const sameStamp = (a: Stamp, b: Stamp): boolean => sameSession(a.session, b.session) && a.stateVersion === b.stateVersion;
const expired = (): FemError => new FemError('session.expired', 'this handle belongs to an inactive model session', 'context.session');
const sameContext = (a: ExecutionContext | null, b: ExecutionContext | null): boolean => a === b || !!a && !!b && sameSession(a.session, b.session) && a.runId === b.runId && a.operationId === b.operationId;
interface Answer { stamp: Stamp; value: unknown }
interface Pending {
  context: ExecutionContext | null;
  resolve(reply: Answer): void;
  reject(error: unknown): void;
  progress?: (p: Progress) => void;
}

/** Owns one immutable Worker endpoint; closing it revokes pending and future traffic. */
export class SessionChannel {
  private nextId = 0;
  private closed = false;
  private readonly pending = new Map<number, Pending>();
  constructor(private readonly worker: Worker) {
    worker.onmessage = (event: MessageEvent<SessionResponse>) => {
      if (this.closed) return;
      const message = event.data;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (!sameContext(pending.context, message.context)) {
        this.pending.delete(message.id);
        pending.reject(new FemError('internal', 'Worker reply has the wrong execution context', 'context'));
        return;
      }
      if ('progress' in message) { pending.progress?.(message.progress); return; }
      this.pending.delete(message.id);
      if (!message.ok) { pending.reject(Object.assign(new FemError(message.error.code, message.error.cause, message.error.where, message.error.suggestion), { context: message.context })); return; }
      try { pending.resolve({ stamp: message.stamp, value: message.raw ? decodeBulk(message, message.raw) : message.value }); }
      catch (error) { pending.reject(error); }
    };
    worker.onerror = (event: ErrorEvent) => this.close(new FemError('internal', `session Worker failed: ${event.message}`, 'engine.worker'));
  }
  request(message: SessionMessage, progress?: (p: Progress) => void): Promise<Answer> {
    if (this.closed) return Promise.reject(expired());
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { context: 'context' in message ? message.context : null, resolve, reject, ...(progress ? { progress } : {}) });
      try { this.worker.postMessage({ ...message, id } satisfies SessionRequest); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  close(error: unknown = expired()): void {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    for (const item of this.pending.values()) item.reject(error);
    this.pending.clear();
  }
}

export type Replace = (origin: SessionTransport, source: ReplacementSource) => Promise<SessionTransport>;
/** One revocable producer. Only its own successful explicit replacement can advance it. */
export class SessionTransport implements EngineTransport {
  private sequence = 0n;
  private tail: Promise<unknown> = Promise.resolve();
  private replacementListener: ((next: SessionTransport) => void) | undefined;
  private sink: ((p: Progress) => void) | undefined;
  constructor(readonly channel: SessionChannel, private lease: RunLease, private readonly replace: Replace) {}
  onReplacement(listener: (next: SessionTransport) => void): void { this.replacementListener = listener; }
  async replaceWith(source: ReplacementSource): Promise<SessionTransport> {
    const next = await this.replace(this, source);
    this.replacementListener?.(next);
    return next;
  }
  get stamp(): Stamp { return structuredClone(this.lease.stamp); }
  get runId(): string { return this.lease.runId; }
  onProgress(sink: (p: Progress) => void): void { this.sink = sink; }
  private context(): ExecutionContext { return { session: this.stamp.session, runId: this.lease.runId, operationId: String(++this.sequence) }; }
  private ordered<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run);
    this.tail = result.catch(() => undefined);
    return result;
  }
  private accept(reply: Answer): unknown {
    if (!sameSession(reply.stamp.session, this.lease.stamp.session)) throw expired();
    // Reads within this session explicitly observe current state; they never follow activation.
    this.lease.stamp = structuredClone(reply.stamp);
    return reply.value;
  }
  async assertActive(): Promise<void> {
    const reply = await this.channel.request({ op: 'query', context: this.context(), query: { query: 'query.capabilities' } });
    if (!sameSession(reply.stamp.session, this.stamp.session)) throw expired();
  }
  async fork(): Promise<SessionTransport> {
    const reply = await this.channel.request({ op: 'forkRun', context: this.context() });
    const lease = reply.value as RunLease;
    if (!sameSession(lease.stamp.session, this.stamp.session)) throw expired();
    return new SessionTransport(this.channel, lease, this.replace);
  }
  async release(): Promise<void> {
    await this.channel.request({ op: 'cancelRun', context: this.context() });
  }
  async snapshot(): Promise<DocumentSnapshot> {
    return this.ordered(async () => this.accept(await this.channel.request({ op: 'snapshot', context: this.context() })) as DocumentSnapshot);
  }
  dispatch(command: Command, onProgress?: (p: Progress) => void): Promise<Ack> {
    if (command.cmd === 'model.new') return this.replaceWith({ kind: 'commands', commands: [structuredClone(command)] }).then(async (next) => {
      const snapshot = await next.snapshot();
      return { seq: 0, revision: snapshot.model.revision, hash: snapshot.model.hash!, warnings: [], output: { type: 'none' } } as Ack;
    });
    return this.ordered(async () => {
      const context = this.context();
      const reply = await this.channel.request({ op: 'dispatch', context, expectedVersion: this.stamp.stateVersion, command: structuredClone(command) }, (p) => { this.sink?.(p); onProgress?.(p); });
      return this.accept(reply) as Ack;
    });
  }
  query(query: Query): Promise<QueryResult> {
    return this.ordered(async () => {
      const value = this.accept(await this.channel.request({ op: 'query', context: this.context(), query })) as Record<string, unknown>;
      if (value['values'] instanceof Float64Array) value['values'] = Array.from(value['values']);
      return value as unknown as QueryResult;
    });
  }
  surface(): Promise<AppSurface> {
    return this.ordered(async () => this.accept(await this.channel.request({ op: 'surface', context: this.context() })) as AppSurface);
  }
  async field(step: string, field: Field, component?: number): Promise<FieldData> {
    const result = await this.query({ query: 'query.field', step, field }) as ResultField;
    const values = new Float32Array(component === undefined ? result.values : result.values.filter((_, index) => index % result.components === component));
    let min = values[0] ?? 0; let max = min;
    for (const value of values) { min = Math.min(min, value); max = Math.max(max, value); }
    return { values, min, max, unit: result.unit };
  }
  async export(spec: ExportSpec): Promise<ExportedFile> {
    const ack = await this.dispatch({ cmd: 'mesh.export', ...spec } as Command);
    if (ack.output.type !== 'export') throw new FemError('internal', 'mesh.export did not return a file');
    return { filename: ack.output.filename, mime: ack.output.mime, bytes: new TextEncoder().encode(ack.output.text) };
  }
  async exportFile(): Promise<ModelFile> { return (await this.snapshot()).file; }
  async importFile(file: ModelFile): Promise<ImportAck> {
    const next = await this.replaceWith({ kind: 'file', file: structuredClone(file) });
    const snapshot = await next.snapshot();
    return { seq: -1, revision: snapshot.model.revision, hash: snapshot.model.hash!, warnings: [], output: { type: 'none' }, journal: snapshot.file.journal };
  }
  async gpuSelfTest(n: number): Promise<number> {
    return this.ordered(async () => this.accept(await this.channel.request({ op: 'gpuSelfTest', context: this.context(), n })) as number);
  }
  async reserve(): Promise<string> {
    return this.ordered(async () => this.accept(await this.channel.request({ op: 'reserve', context: this.context(), expectedVersion: this.stamp.stateVersion })) as string);
  }
  async prepare(source: ReplacementSource, options: SessionOptions): Promise<DocumentSnapshot> {
    const reply = await this.channel.request({ op: 'prepare', context: this.context(), expectedVersion: this.stamp.stateVersion, source, options });
    this.lease.stamp = structuredClone(reply.stamp); // This private candidate initiated the transition.
    return reply.value as DocumentSnapshot;
  }
  cancel(): Promise<void> { return this.release(); }
}
