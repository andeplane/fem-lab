import type { SessionOptions } from './session-protocol';
import type * as Portable from './generated/wasm/femlab_engine_wasm.js';

interface EngineModule<Session, Prepared> {
  SessionEngine: { create(options: SessionOptions, epoch: string): Promise<Session> };
  PreparedEngine: { create(ticket: string, options: SessionOptions): Promise<Prepared> };
  default(options: { module_or_path: string }): Promise<unknown>;
}
export interface EngineRuntime<Session, Prepared> {
  module: EngineModule<Session, Prepared>;
  wasmUrl: string;
  initThreadPool?: (threads: number) => Promise<unknown>;
}
export interface BrowserEngineHost<Session, Prepared> {
  canThread: boolean;
  portable(): Promise<EngineRuntime<Session, Prepared>>;
  threaded(): Promise<EngineRuntime<Session, Prepared>>;
}

/** One initialized module/pool per session Worker. Candidates share its exact backend. */
export class BrowserEngine<Session = Portable.SessionEngine, Prepared = Portable.PreparedEngine> {
  private ready: Promise<EngineModule<Session, Prepared>> | undefined;
  private threads: number | undefined;
  constructor(private readonly host: BrowserEngineHost<Session, Prepared>) {}
  private load(threads: number): Promise<EngineModule<Session, Prepared>> {
    threads = Math.max(1, Math.floor(threads));
    if (this.ready) {
      if (this.threads !== threads) return Promise.reject({ code: 'schema', cause: 'A session Worker cannot change its CPU pool size', where: 'threads' });
      return this.ready;
    }
    this.threads = threads;
    this.ready = (async () => {
      const runtime = await (this.host.canThread ? this.host.threaded() : this.host.portable());
      await runtime.module.default({ module_or_path: runtime.wasmUrl });
      if (this.host.canThread) {
        if (!runtime.initThreadPool) throw { code: 'internal', cause: 'The threaded engine runtime has no worker pool initializer' };
        await runtime.initThreadPool(threads);
      }
      return runtime.module;
    })();
    return this.ready;
  }
  async create(options: SessionOptions, epoch: string): Promise<Session> {
    const module = await this.load(options.threads);
    return module.SessionEngine.create(options, epoch);
  }
  async candidate(ticket: string, options: SessionOptions): Promise<Prepared> {
    const module = await this.load(options.threads);
    return module.PreparedEngine.create(ticket, options);
  }
}
