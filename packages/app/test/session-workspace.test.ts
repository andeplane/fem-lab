import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type { Command, DocumentSnapshot } from '@femlab/registry';
import { SessionRuntime } from '../src/session-runtime';
import { SessionWorkspace } from '../src/session-workspace';
import { SessionChannel } from '../src/session-transport';
import type { SessionRequest, SessionResponse } from '../src/session-protocol';
const wasm = createRequire(import.meta.url)('../../../tools/wasm-node/femlab_engine_wasm.js') as typeof import('../src/generated/wasm/femlab_engine_wasm');
const fresh: Command = { cmd: 'model.new', name: 'same' };
const body: Command = { cmd: 'geometry.addBox', name: 'shared', size: ['1 m', '1 m', '1 m'] };
const remove: Command = { cmd: 'geometry.remove', name: 'shared' };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
class TestWorker {
  onmessage: ((event: MessageEvent<SessionResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  requests: SessionRequest[] = [];
  pause: Promise<void> = Promise.resolve();
  readonly runtime = new SessionRuntime(async (options, epoch) => new wasm.SessionEngine(options.threads, epoch), (ticket, options) => wasm.PreparedEngine.create(ticket, options));
  postMessage(request: SessionRequest): void {
    this.requests.push(structuredClone(request));
    void this.pause.then(() => this.runtime.accept(request, (reply) => {
      // Deliberately deliver even after termination to test channel fencing.
      this.onmessage?.({ data: reply } as MessageEvent<SessionResponse>);
    }));
  }
  terminate(): void { this.terminated = true; }
}
function setup() {
  const workers: TestWorker[] = [];
  const publications: DocumentSnapshot[] = [];
  let counter = 0;
  const workspace = new SessionWorkspace({
    spawn: () => { const worker = new TestWorker(); workers.push(worker); return worker as unknown as Worker; },
    epoch: () => `worker-${++counter}`,
    engine: { gpu: false, threads: 1 },
    build: async (_transport, snapshot) => ({ snapshot: structuredClone(snapshot), lastError: null as string | null, dispose: vi.fn() }),
    publish: (session) => { publications.push(session.initial); },
  });
  return { workspace, workers, publications };
}

describe('session workspace using the checked WASM runtime', () => {
  it('atomically swaps resources and makes retained same-name handles unusable', async () => {
    const { workspace, workers, publications } = setup();
    const initial = await workspace.start();
    const a = await workspace.replace(initial.transport, { kind: 'commands', commands: [fresh, body] });
    const retained = await a.fork();
    const oldResources = workspace.active.resources;
    const b = await workspace.replace(a, { kind: 'commands', commands: [fresh, body] });
    const before = await b.snapshot();
    await expect(retained.dispatch(remove)).rejects.toMatchObject({ code: 'session.expired' });
    await expect(retained.query({ query: 'query.model' })).rejects.toMatchObject({ code: 'session.expired' });
    await expect(retained.surface()).rejects.toMatchObject({ code: 'session.expired' });
    await expect(workspace.replace(retained, { kind: 'commands', commands: [fresh] })).rejects.toMatchObject({ code: 'session.expired' });
    expect(await b.snapshot()).toEqual(before);
    expect(before.file.journal.entries.map(e => e.cmd.cmd)).toEqual(['model.new', 'geometry.addBox']);
    expect(workspace.active.resources).not.toBe(oldResources);
    oldResources.lastError = 'late failure';
    expect(workspace.active.resources.lastError).toBeNull();
    expect(oldResources.dispose).toHaveBeenCalledOnce();
    expect(workers.slice(0, 2).every(w => w.terminated)).toBe(true);
    expect(publications).toHaveLength(3);
    b.channel.close();
  });

  it('keeps old state on partial replay and file validation failure', async () => {
    const { workspace, workers } = setup();
    const a = (await workspace.start()).transport;
    await a.dispatch(body);
    const before = await a.snapshot();
    const old = workspace.active;
    await expect(workspace.replace(a, { kind: 'commands', commands: [fresh, body, { ...remove, name: 'missing' }] })).rejects.toMatchObject({ code: 'not-found' });
    expect(workspace.active).toBe(old);
    expect(await a.snapshot()).toEqual(before);
    const invalid = structuredClone(before.file); invalid.model.name = 'inconsistent';
    await expect(workspace.replace(a, { kind: 'file', file: invalid })).rejects.toMatchObject({ code: 'schema' });
    expect(await a.snapshot()).toEqual(before);
    expect(workers.slice(1).every(w => w.terminated)).toBe(true);
    await a.dispatch(remove); // failed preparation released the old reservation
    expect((await a.snapshot()).file.model.bodies).toEqual([]);
    a.channel.close();
  });

  it('revokes posted work on cancellation and requires explicit reads after a version conflict', async () => {
    const { workspace } = setup();
    const a = (await workspace.start()).transport;
    const b = await a.fork();
    await a.dispatch(body);
    await expect(b.dispatch(remove)).rejects.toMatchObject({ code: 'session.conflict' });
    expect((await a.snapshot()).file.model.bodies).toHaveLength(1);
    await b.snapshot();
    await b.dispatch(remove);
    const c = await b.fork();
    await c.release();
    await expect(c.fork()).rejects.toMatchObject({ code: 'cancelled' });
    await expect(c.dispatch(body)).rejects.toMatchObject({ code: 'cancelled' });
    expect((await b.snapshot()).file.model.bodies).toEqual([]);
    b.channel.close();
  });

  it('recovers acknowledged history with a fresh endpoint and preserves the redo tail', async () => {
    const { workspace } = setup();
    const a = (await workspace.start()).transport;
    await a.dispatch(body);
    await a.dispatch({ cmd: 'journal.undo', steps: 1 });
    const before = await a.snapshot();
    expect(before.canRedo).toBe(true);
    await workspace.recover(a);
    const b = workspace.active.transport;
    const recovered = await b.snapshot();
    expect(recovered.file).toEqual(before.file);
    expect(recovered.canRedo).toBe(true);
    expect(recovered.stamp.session.backendEpoch).not.toBe(before.stamp.session.backendEpoch);
    await expect(a.dispatch(body)).rejects.toMatchObject({ code: 'session.expired' });
    await b.dispatch({ cmd: 'journal.redo', steps: 1 });
    expect((await b.snapshot()).file.model.bodies).toHaveLength(1);
    b.channel.close();
  });

  it('cancels blocked posted work without allowing its eventual reply into the recovered session', async () => {
    const { workspace, workers } = setup();
    const a = (await workspace.start()).transport;
    await a.dispatch(body);
    const before = await a.snapshot();
    const gate = deferred(); workers[0]!.pause = gate.promise;
    const posted = a.dispatch(remove);
    const rejected = expect(posted).rejects.toMatchObject({ code: 'cancelled' });
    await Promise.resolve();
    await workspace.recover(a);
    await rejected;
    const b = workspace.active.transport;
    expect((await b.snapshot()).file).toEqual(before.file);
    gate.resolve();
    await workers[0]!.runtime.accept({ id: 999, op: 'snapshot', context: { session: before.stamp.session, runId: a.runId, operationId: '999' } }, () => undefined);
    expect((await b.snapshot()).file).toEqual(before.file);
    b.channel.close();
  });

  it('cannot publish a prepared candidate after the initiating run was cancelled', async () => {
    const entered = deferred(); const finish = deferred();
    let built = 0; let epoch = 0;
    const workspace = new SessionWorkspace({
      spawn: () => new TestWorker() as unknown as Worker,
      epoch: () => `cancel-${++epoch}`, engine: { gpu: false, threads: 1 },
      build: async () => {
        if (++built === 2) { entered.resolve(); await finish.promise; }
        return { dispose: vi.fn() };
      },
      publish: vi.fn(),
    });
    const active = await workspace.start();
    const observer = await active.transport.fork();
    const before = await observer.snapshot();
    const replacing = workspace.replace(active.transport, { kind: 'commands', commands: [fresh, body] });
    await entered.promise;
    expect(await observer.snapshot()).toEqual(before);
    await expect(observer.dispatch(body)).rejects.toMatchObject({ code: 'session.transitioning' });
    await active.transport.release();
    finish.resolve();
    await expect(replacing).rejects.toMatchObject({ code: 'session.conflict' });
    expect(workspace.active).toBe(active);
    expect(await observer.snapshot()).toEqual(before);
    await observer.dispatch(body);
    observer.channel.close();
  });

  it('provides copied, stamped geometry and preserves an old session while preparation is suspended', async () => {
    const gate = deferred();
    const { workspace, workers } = setup();
    const a = (await workspace.start()).transport;
    await a.dispatch(body);
    const surface = await a.surface();
    expect(surface.bodyNames).toEqual(['shared']);
    expect(surface.positions.length).toBeGreaterThan(0);
    surface.positions[0] = 12345;
    expect((await a.surface()).positions[0]).not.toBe(12345);
    const original = workers[0]!.postMessage.bind(workers[0]);
    workers[0]!.postMessage = (req) => { if (req.op === 'reserve') workers[0]!.pause = gate.promise; original(req); };
    const replacing = workspace.replace(a, { kind: 'commands', commands: [fresh] });
    await expect(workspace.replace(a, { kind: 'commands', commands: [fresh] })).rejects.toMatchObject({ code: 'session.transitioning' });
    gate.resolve();
    const b = await replacing;
    expect((await b.snapshot()).file.model.bodies).toHaveLength(0);
    b.channel.close();
  });
});

describe('reply ownership', () => {
  it('rejects mismatched contexts and discards late progress and buffers after close', async () => {
    const worker = new TestWorker();
    const gate = deferred(); worker.pause = gate.promise;
    const channel = new SessionChannel(worker as unknown as Worker);
    const context = { session: { backendEpoch: 'a', sessionId: '0' }, runId: '1', operationId: '1' };
    const progress = vi.fn();
    const pending = channel.request({ op: 'surface', context }, progress);
    worker.onmessage!({ data: { id: 1, context: { ...context, runId: 'wrong' }, progress: { phase: 'bad' } } } as MessageEvent<SessionResponse>);
    await expect(pending).rejects.toMatchObject({ code: 'internal' });
    const late = channel.request({ op: 'surface', context }, progress);
    channel.close();
    await expect(late).rejects.toMatchObject({ code: 'session.expired' });
    worker.onmessage!({ data: { id: 2, context, progress: { phase: 'late' } } } as MessageEvent<SessionResponse>);
    expect(progress).not.toHaveBeenCalled();
    await expect(channel.request({ op: 'surface', context })).rejects.toMatchObject({ code: 'session.expired' });
    gate.resolve();
  });
});
