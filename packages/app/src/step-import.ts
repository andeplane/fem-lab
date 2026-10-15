import { FemError, STEP_CONVERTER_VERSION, readStep, stepCommand, stepDeflection, stepGeometry, type Ack, type Quantity, type StepImportInput, type StepImportResult, type StepIo, type StepReport } from '@femlab/registry';

export interface StepWorkerRequest { bytes: Uint8Array; linearDeflection: number; angularDeflection: number; assets: string }
/** Browser Worker is injected; typed fakes exercise failure, termination and late messages. */
export interface StepWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(request: StepWorkerRequest, transfer: Transferable[]): void;
  terminate(): void;
}
export type StepPhase = 'picking' | 'reading' | 'loading/converting' | 'checking' | 'publishing';
export interface StepImportState { name: string; phase: StepPhase; cancellable: boolean }
export interface StepAdmission {
  signal: AbortSignal;
  convert(quantity: Quantity, to: 'm' | 'rad'): Promise<number>;
  commit(command: ReturnType<typeof stepCommand>): Promise<Ack>;
}
const cancelled = () => new FemError('cancelled', 'STEP import was cancelled before publication', 'geometry.importStep');

/** One bounded conversion per project. Source I/O and worker construction happen only on demand.
 * The bound producer supplies commit; this service cannot acquire or replace another session. */
export class StepImporter {
  private active: { name: string; abort: AbortController; publishing: boolean } | undefined;
  constructor(private readonly worker: () => StepWorker, private readonly assets: string,
    private readonly status: (state: StepImportState | null) => void,
    private readonly reported: (report: StepReport) => void) {}
  cancel(name: string): boolean {
    if (!this.active || this.active.name !== name || this.active.publishing) return false;
    this.active.abort.abort(cancelled());
    return true;
  }
  dispose(): void { this.active?.abort.abort(cancelled()); }
  async run(input: StepImportInput, io: StepIo, admission: StepAdmission): Promise<StepImportResult | { cancelled: true }> {
    if (this.active) throw new FemError('session.conflict', `STEP import '${this.active.name}' is still pending`, 'geometry.importStep', `geometry.cancelStep {name: '${this.active.name}'} before starting another import`);
    const abort = new AbortController();
    const active = { name: input.name, abort, publishing: false }; this.active = active;
    const expire = () => abort.abort(admission.signal.reason);
    admission.signal.addEventListener('abort', expire, { once: true });
    if (admission.signal.aborted) expire();
    let worker: StepWorker | undefined;
    const check = () => { if (abort.signal.aborted) throw cancelled(); };
    const wait = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      const stop = () => reject(cancelled());
      abort.signal.addEventListener('abort', stop, { once: true });
      if (abort.signal.aborted) stop();
      promise.then(resolve, reject).finally(() => abort.signal.removeEventListener('abort', stop));
    });
    const phase = (value: StepPhase) => { check(); this.status({ name: input.name, phase: value, cancellable: !active.publishing }); };
    try {
      phase('picking');
      // Open the chooser in the initiating gesture, before asynchronous engine queries.
      // readStep bounds metadata before reading and retains only one private byte snapshot.
      const source = await wait(readStep(input, io));
      if (source === null) return { cancelled: true };
      phase('reading');
      // Validation queries use the engine's Quantity parser, independently of display choices.
      const linearDeflection = await wait(admission.convert(input.linearDeflection, 'm'));
      const angularDeflection = await wait(admission.convert(input.angularDeflection, 'rad'));
      stepDeflection(linearDeflection, angularDeflection);
      const sourceBytes = source.bytes.byteLength;
      const sourceSha256 = await wait(io.sha256(source.bytes));
      phase('loading/converting');
      worker = this.worker();
      const converted = await wait(new Promise<unknown>((resolve, reject) => {
        worker!.onmessage = event => resolve(event.data);
        worker!.onerror = event => reject(new FemError('unsupported', `STEP converter failed: ${event.message}`, 'step.converter', 'retry the import or repair the STEP source'));
        worker!.postMessage({ bytes: source.bytes, linearDeflection, angularDeflection, assets: this.assets }, [source.bytes.buffer]);
      }));
      phase('checking');
      const geometry = stepGeometry(converted);
      const encoded = new TextEncoder().encode(geometry.data);
      const geometrySha256 = await wait(io.sha256(encoded));
      const report: StepReport = { name: input.name, sourceName: source.name, sourceBytes, sourceSha256,
        converter: STEP_CONVERTER_VERSION, outputUnit: 'm', linearDeflection: { value: linearDeflection, unit: 'm' }, angularDeflection: { value: angularDeflection, unit: 'rad' },
        ...geometry.counts, geometryBytes: encoded.byteLength, geometrySha256 };
      check();
      active.publishing = true;
      phase('publishing');
      const ack = await admission.commit(stepCommand(input, geometry.data, geometrySha256));
      this.reported(report);
      return { ...ack, report };
    } finally {
      if (worker) { worker.onmessage = null; worker.onerror = null; worker.terminate(); }
      admission.signal.removeEventListener('abort', expire);
      this.active = undefined; this.status(null);
    }
  }
}
