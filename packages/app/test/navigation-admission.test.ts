import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';
import type { Command, DocumentSnapshot } from '@femlab/registry';
import { WorkspaceNavigation } from '../src/navigation';
import { SessionRuntime } from '../src/session-runtime';
import { SessionWorkspace } from '../src/session-workspace';
import type { SessionRequest, SessionResponse } from '../src/session-protocol';

const wasm = createRequire(import.meta.url)('../../../tools/wasm-node/femlab_engine_wasm.js') as typeof import('../src/generated/wasm/femlab_engine_wasm');
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

/** Real checked engine and message runtime; only delivery of candidate preparation is held. */
class LocalWorker {
  onmessage: ((event: MessageEvent<SessionResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  readonly requests: SessionRequest[] = [];
  readonly runtime = new SessionRuntime(async (options, epoch) => new wasm.SessionEngine(options.threads, epoch), (ticket, options) => wasm.PreparedEngine.create(ticket, options), () => 0);
  constructor(private beforePrepare: () => Promise<void> = async () => undefined) {}
  postMessage(request: SessionRequest): void {
    this.requests.push(structuredClone(request));
    void (async () => {
      if (request.op === 'prepare') await this.beforePrepare();
      await this.runtime.accept(request, reply => this.onmessage?.({ data: reply } as MessageEvent<SessionResponse>));
    })();
  }
  terminate(): void { this.terminated = true; }
}

for (const heldPhase of ['before-open', 'candidate-prepare'] as const) it(`explicit admission joins cancelled automatic navigation through ${heldPhase}`, async () => {
  const entered = deferred(), release = deferred(), abandoning = deferred(), releaseAbandon = deferred();
  const workers: LocalWorker[] = [], publications: string[] = [];
  const workspace = new SessionWorkspace({
    spawn: () => {
      const candidate = workers.length === 1;
      const worker = new LocalWorker(async () => {
        if (candidate && heldPhase === 'candidate-prepare') { entered.resolve(); await release.promise; }
      });
      workers.push(worker); return worker as unknown as Worker;
    },
    epoch: () => `navigation-${workers.length}`, engine: { gpu: false, threads: 1 },
    build: async (_transport, snapshot) => ({
      dispose: vi.fn(),
      abandon: async () => {
        if (snapshot.model.name === 'automatic') { abandoning.resolve(); await releaseAbandon.promise; }
      },
    }),
    publish: session => { publications.push(session.initial.model.name); },
  });
  const initial = await workspace.start();
  const retained = await initial.transport.fork();
  const fail = vi.fn();
  let hash = '#/projects/automatic';
  const navigation = new WorkspaceNavigation({ hash: () => hash, write: value => { hash = value; }, listen: () => () => undefined }, {
    current: () => ({ id: workspace.active === initial ? null : workspace.active.initial.model.name, home: false, examples: false }),
    show: vi.fn(), fail,
    open: async (id, signal) => {
      const producer = await initial.transport.fork();
      const cancel = () => { void producer.release().catch(() => undefined); };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        if (heldPhase === 'before-open') { entered.resolve(); await release.promise; }
        signal.throwIfAborted();
        await producer.replaceWith({ kind: 'commands', commands: [{ cmd: 'model.new', name: id }] });
      } finally {
        signal.removeEventListener('abort', cancel);
        await producer.release().catch(() => undefined);
      }
    },
  });
  const opening = navigation.start();
  let admitted = false;
  const chosen: Command[] = [{ cmd: 'model.new', name: 'chosen' }, { cmd: 'geometry.addBox', name: 'chosen-body', size: ['1 m', '1 m', '1 m'] }];
  let explicit: Promise<DocumentSnapshot> | undefined;
  try {
    await entered.promise;
    if (heldPhase === 'before-open') {
      // The old whenIdle-only barrier resolves here, although automatic project I/O is pending.
      await workspace.whenIdle();
      expect(workers).toHaveLength(1);
    } else {
      expect(workers[0]!.requests.some(request => request.op === 'reserve')).toBe(true);
      expect(workers[1]!.requests.some(request => request.op === 'prepare')).toBe(true);
    }
    explicit = (async () => {
      // This is the same pre-fork admission boundary used by a fresh UI/console action.
      await navigation.interruptAndWait();
      await workspace.whenIdle();
      admitted = true;
      const producer = await initial.transport.fork();
      const next = await producer.replaceWith({ kind: 'commands', commands: chosen });
      try { return await next.snapshot(); } finally { await next.release(); }
    })();
    // Attach rejection handling immediately, including when exercising a broken admission barrier.
    const outcome = explicit.then(snapshot => ({ snapshot, error: undefined }), error => ({ snapshot: undefined, error }));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(admitted).toBe(false);
    release.resolve();
    if (heldPhase === 'candidate-prepare') {
      await abandoning.promise;
      expect(workers[1]!.terminated).toBe(true);
      expect(workspace.active).toBe(initial);
      expect(admitted).toBe(false);
    }
    releaseAbandon.resolve();
    const result = await outcome;
    expect(result.error).toBeUndefined();
    expect(result.snapshot!.journal.entries.map(entry => entry.cmd)).toEqual(chosen);
    expect(publications).toEqual([initial.initial.model.name, 'chosen']);
    expect(fail).not.toHaveBeenCalled();
    await opening;
    await expect(retained.query({ query: 'query.model' })).rejects.toMatchObject({ code: 'session.expired' });
  } finally {
    release.resolve(); releaseAbandon.resolve(); navigation.dispose();
    await Promise.allSettled([opening, ...(explicit ? [explicit] : [])]);
    workspace.active.transport.channel.close();
    for (const worker of workers) worker.terminate();
  }
});
