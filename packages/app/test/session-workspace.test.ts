import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { modelFileEncoder, type Command, type DocumentSnapshot, type ModelFilePublicationPolicy } from '@femlab/registry';
import { SessionRuntime } from '../src/session-runtime';
import { SessionWorkspace } from '../src/session-workspace';
import { SessionChannel, type SessionTransport } from '../src/session-transport';
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
  readonly runtime: SessionRuntime;
  constructor(publication?: ModelFilePublicationPolicy) {
    this.runtime = new SessionRuntime(async (options, epoch) => new wasm.SessionEngine(options.threads, epoch), (ticket, options) => wasm.PreparedEngine.create(ticket, options), publication);
  }
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

// #580/#592: preserve the error from the real checked Worker through Runtime and Transport.
it('preserves display code, cause, location and recovery without changing session or scientific state', async () => {
  const { workspace } = setup();
  const initial = await workspace.start();
  const transport = await workspace.replace(initial.transport, { kind: 'commands', commands: [{ cmd: 'model.new', name: 'checked display error' }] });
  try {
    const commands: Command[] = [
      { cmd: 'geometry.addLine', name: 'shaft', points: [['0 m', '0 m', '0 m'], ['1 m', '0 m', '0 m']], divisions: 1, kind: 'beam' },
      { cmd: 'material.add', name: 'steel', E: '200 GPa', nu: 0.3 },
      { cmd: 'material.assign', material: 'steel', bodies: ['shaft'] },
      { cmd: 'section.add', name: 'round', shape: { kind: 'circle', radius: '50 mm' } },
      { cmd: 'section.assign', section: 'round', bodies: ['shaft'] },
      { cmd: 'mesh.set', mesher: { kind: 'lattice', size: '1 m' } },
      { cmd: 'constraint.fix', name: 'root', on: 'shaft.p0' },
      { cmd: 'load.force', name: 'tip', on: 'shaft.p1', total: ['1000 N', '0 N', '0 N'] },
      { cmd: 'step.add', name: 'axial', procedure: 'static', constraints: ['root'], loads: ['tip'] },
      { cmd: 'solve.run', step: 'axial', solver: 'cpu-direct' },
      { cmd: 'load.moment', name: 'plus', on: 'shaft.p0', total: ['1e307 N m', '0 N m', '0 N m'] },
      { cmd: 'load.moment', name: 'minus', on: 'shaft.p1', total: ['-1e307 N m', '0 N m', '0 N m'] },
      { cmd: 'model.setUnits', units: { length: 'mm', force: 'mN', stress: 'Pa' } },
    ];
    for (const command of commands) await transport.dispatch(command);
    const state = async () => ({
      stamp: transport.stamp,
      journal: await transport.query({ query: 'query.journal' }),
      plus: await transport.query({ query: 'query.definition', kind: 'load', name: 'plus' }),
      minus: await transport.query({ query: 'query.definition', kind: 'load', name: 'minus' }),
      catalogue: await transport.query({ query: 'query.results' }),
      result: await transport.query({ query: 'query.result', step: 'axial' }),
    });
    const before = await state();
    await expect(transport.query({ query: 'query.model' })).rejects.toMatchObject({
      code: 'unit.display',
      cause: "cannot represent energy in display unit 'mN mm': quantity must be finite before and after unit conversion",
      where: 'displayUnits',
      suggestion: "model.setUnits with SI display units, for example length 'm', force 'N' and stress 'Pa'",
    });
    expect(await state()).toEqual(before);
    expect(workspace.active.transport.channel).toBe(transport.channel);
  } finally { transport.channel.close(); }
});

describe('session workspace using the checked WASM runtime', () => {
  it.each(['initiating', 'independent'] as const)('checks original replacement admission after the %s producer edits and a read refreshes the lease', async writerKind => {
    const { workspace, workers, publications } = setup();
    const active = await workspace.start();
    const initiating = active.transport;
    const admission = initiating.stamp;
    const writer = writerKind === 'initiating' ? initiating : await initiating.fork();
    await writer.dispatch(body);
    const before = await writer.snapshot();
    await initiating.query({ query: 'query.model' });
    expect(initiating.stamp.stateVersion).not.toBe(admission.stateVersion);
    await expect(initiating.replaceWith({ kind: 'commands', commands: [fresh] }, admission)).rejects.toMatchObject({ code: 'session.conflict' });
    expect(workspace.active).toBe(active);
    expect(await initiating.snapshot()).toEqual(before);
    expect(workers).toHaveLength(1); // no candidate or resource/persistence claim
    expect(publications).toHaveLength(1);
    expect(active.resources.dispose).not.toHaveBeenCalled();
    initiating.channel.close();
  });

  it('keeps unchanged-state reads valid and lets sequential replacements capture their own advanced admission', async () => {
    const { workspace } = setup();
    const initiating = (await workspace.start()).transport;
    const first = initiating.stamp;
    await initiating.query({ query: 'query.model' });
    const next = await initiating.replaceWith({ kind: 'commands', commands: [fresh, body] }, first);
    const second = next.stamp;
    await next.snapshot();
    const final = await next.replaceWith({ kind: 'commands', commands: [{ ...fresh, name: 'second' }] }, second);
    expect((await final.snapshot()).model.name).toBe('second');
    final.channel.close();
  });

  it('rejects an oversized prepared file before project persistence and keeps the old producer usable', async () => {
    const build = vi.fn(async (_transport: SessionTransport, snapshot: DocumentSnapshot) => ({
      file: structuredClone(snapshot.file), dispose: vi.fn(),
    }));
    const publish = vi.fn();
    const workers: TestWorker[] = [];
    let epoch = 0;
    const workspace = new SessionWorkspace({
      spawn: () => {
        const worker = new TestWorker({ encode: modelFileEncoder(), maxBytes: 1024 });
        workers.push(worker);
        return worker as unknown as Worker;
      },
      epoch: () => `size-${++epoch}`, engine: { gpu: false, threads: 1 }, build, publish,
    });
    const active = await workspace.start();
    const producer = await active.transport.fork();
    await producer.dispatch(body);
    const before = await producer.snapshot();
    const savedProject = structuredClone(active.resources.file);
    await expect(workspace.replace(producer, {
      kind: 'commands', commands: [{ ...fresh, name: '☃🚀"\\'.repeat(200) }],
    })).rejects.toMatchObject({ code: 'schema', where: 'file' });
    expect(workspace.active).toBe(active);
    expect(await producer.snapshot()).toEqual(before);
    expect(active.resources.file).toEqual(savedProject);
    expect(build).toHaveBeenCalledOnce(); // no candidate resource/persistence claim
    expect(publish).toHaveBeenCalledOnce();
    expect(active.resources.dispose).not.toHaveBeenCalled();
    expect(workers[1]!.terminated).toBe(true);
    await producer.dispatch(remove);
    expect((await producer.snapshot()).file.model.bodies).toEqual([]);
    producer.channel.close();
  });

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

it('ships only the checked WASM owner and captures command inputs before queueing', async () => {
  expect(wasm).not.toHaveProperty('Engine');
  const { workspace } = setup();
  const a = (await workspace.start()).transport;
  const command = { ...body, name: 'captured' };
  const pending = a.dispatch(command);
  command.name = 'changed-after-admission';
  await pending;
  expect((await a.snapshot()).model.bodies.map(b => b.name)).toEqual(['captured']);
  a.channel.close();
});

it('recovers export entries and a branched undo history after a Worker failure', async () => {
  const { workspace, workers } = setup();
  const a = (await workspace.start()).transport;
  await a.dispatch(body);
  await a.dispatch({ cmd: 'mesh.set', mesher: { kind: 'lattice', size: '1 m' }, order: 1 });
  await a.export({ format: 'vtu' });
  await a.dispatch({ cmd: 'model.setName', name: 'undone' });
  await a.dispatch({ cmd: 'journal.undo', steps: 1 });
  await a.dispatch({ cmd: 'model.setName', name: 'branch' });
  const before = await a.snapshot();
  workers[0]!.onerror!({ message: 'worker stopped' } as ErrorEvent);
  await vi.waitFor(() => expect(workspace.active.transport.channel).not.toBe(a.channel));
  const b = workspace.active.transport;
  const after = await b.snapshot();
  expect(after.file).toEqual(before.file);
  expect(after.journal).toEqual(before.journal);
  expect(after.canRedo).toBe(false);
  await expect(a.dispatch(remove)).rejects.toMatchObject({ code: 'session.expired' });
  b.channel.close();
});
