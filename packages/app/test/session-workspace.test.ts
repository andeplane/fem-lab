import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import Ajv from 'ajv/dist/2020';
import { describe, expect, it, vi } from 'vitest';
import { HOST_COMMANDS, HOST_QUERIES, MAX_MODEL_FILE_BYTES, Registry, modelFileEncoder, type Ack, type Command, type DocumentSnapshot, type EngineSchema, type ModelFilePublicationPolicy } from '@femlab/registry';
import schema from '../../registry/src/generated/engine.schema.json';
import { fakeHost } from '../../registry/test/fakes';
import { SessionRuntime } from '../src/session-runtime';
import { SessionWorkspace } from '../src/session-workspace';
import { SessionChannel, type SessionTransport } from '../src/session-transport';
import type { SessionRequest, SessionResponse } from '../src/session-protocol';
const require = createRequire(import.meta.url);
const wasm = require('../../../tools/wasm-node/femlab_engine_wasm.js') as typeof import('../src/generated/wasm/femlab_engine_wasm');
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
    this.runtime = new SessionRuntime(async (options, epoch) => new wasm.SessionEngine(options.threads, epoch), (ticket, options) => wasm.PreparedEngine.create(ticket, options), () => 0, publication);
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

function saveHost(transport: SessionTransport) {
  const host = fakeHost(transport, true);
  const registry = new Registry({ schema: schema as unknown as EngineSchema, host, hostCommands: HOST_COMMANDS, hostQueries: HOST_QUERIES });
  return { host, registry };
}

it.each([false, true])('resets a closed owner to a fresh empty engine without replaying private resources (old Journal populated: %s)', async populated => {
  const workers: TestWorker[] = []; const sources: unknown[] = []; let builds = 0;
  const privateBytes = new Uint8Array([7, 8, 9]); const beforeReset = vi.fn(async () => undefined); const oldDispose = vi.fn();
  const workspace = new SessionWorkspace({
    spawn: () => { const worker = new TestWorker(); workers.push(worker); return worker as unknown as Worker; },
    epoch: () => `reset-${workers.length}`, engine: { gpu: false, threads: 1 },
    build: async (_transport, _snapshot, source) => { sources.push(source); return { privateFiles: builds++ === 0 || source !== undefined ? [privateBytes] : [], prepareIdentityReset: beforeReset, dispose: builds === 1 ? oldDispose : vi.fn() }; },
    publish: vi.fn(),
  });
  const old = await workspace.start(); if (populated) await old.transport.dispatch(body);
  old.transport.channel.close(); const oldRequests = workers[0]!.requests.length;
  const fresh = await workspace.reset();
  try {
    expect(beforeReset).toHaveBeenCalledOnce(); expect(oldDispose).toHaveBeenCalledOnce();
    expect(fresh.transport.stamp.session).not.toEqual(old.transport.stamp.session);
    expect(fresh.initial.file.journal.entries).toEqual([]); expect(fresh.initial.model.bodies).toEqual([]);
    expect(fresh.resources.privateFiles).toEqual([]); expect(old.resources.privateFiles).toEqual([privateBytes]);
    expect(sources).toEqual([undefined, undefined]);
    expect(workers[0]!.requests).toHaveLength(oldRequests);
    expect(workers[1]!.requests.map(request => request.op)).not.toContain('prepare');
    expect(workers[1]!.requests.map(request => request.op)).not.toContain('reserve');
    await expect(old.transport.query({ query: 'query.model' })).rejects.toMatchObject({ code: 'session.expired' });
  } finally { fresh.transport.channel.close(); }
});

it('rejects concurrent resets and keeps whenIdle pending through private reset preparation', async () => {
  const held = deferred(); const preparing = deferred(); const workers: TestWorker[] = [];
  const workspace = new SessionWorkspace({
    spawn: () => { const worker = new TestWorker(); workers.push(worker); return worker as unknown as Worker; },
    epoch: () => `busy-reset-${workers.length}`, engine: { gpu: false, threads: 1 },
    build: async () => ({ dispose: vi.fn(), prepareIdentityReset: async () => { preparing.resolve(); await held.promise; } }), publish: vi.fn(),
  });
  await workspace.start(); const resetting = workspace.reset(); await preparing.promise;
  let idle = false; const waiting = workspace.whenIdle().then(() => { idle = true; });
  await expect(workspace.reset()).rejects.toMatchObject({ code: 'session.transitioning' });
  await Promise.resolve(); expect(idle).toBe(false); expect(workers).toHaveLength(1);
  held.resolve(); const fresh = await resetting; await waiting;
  expect(idle).toBe(true); fresh.transport.channel.close();
});

it('closes a failed reset candidate and preserves the previous owner until a later reset succeeds', async () => {
  const workers: TestWorker[] = []; let builds = 0; const oldDispose = vi.fn(); const publish = vi.fn();
  const workspace = new SessionWorkspace({
    spawn: () => { const worker = new TestWorker(); workers.push(worker); return worker as unknown as Worker; },
    epoch: () => `failed-reset-${workers.length}`, engine: { gpu: false, threads: 1 },
    build: async () => { if (++builds === 2) throw new Error('private bundle validation failed'); return { dispose: builds === 1 ? oldDispose : vi.fn() }; }, publish,
  });
  const old = await workspace.start(); await old.transport.dispatch(body);
  const before = await old.transport.snapshot();
  await expect(workspace.reset()).rejects.toThrow('private bundle validation failed'); await workspace.whenIdle();
  expect(workspace.active).toBe(old); expect(workers[1]!.terminated).toBe(true); expect(workers[0]!.terminated).toBe(false);
  expect(oldDispose).not.toHaveBeenCalled(); expect(publish).toHaveBeenCalledOnce(); expect(await old.transport.snapshot()).toEqual(before);
  const fresh = await workspace.reset();
  expect(fresh.initial.file.journal.entries).toEqual([]); expect(oldDispose).toHaveBeenCalledOnce(); fresh.transport.channel.close();
});

it('whenIdle waits for private startup and cancellation cleanup, then resolves every waiter', async () => {
  const building = deferred(); const release = deferred(); const abandoned = deferred(); const releaseAbandon = deferred();
  const workers: TestWorker[] = [];
  const workspace = new SessionWorkspace({
    spawn: () => { const worker = new TestWorker(); workers.push(worker); return worker as unknown as Worker; },
    epoch: () => `idle-${workers.length}`, engine: { gpu: false, threads: 1 },
    build: async () => { building.resolve(); await release.promise; return { dispose: vi.fn(), abandon: async () => { abandoned.resolve(); await releaseAbandon.promise; } }; },
    publish: vi.fn(),
  });
  await workspace.whenIdle();
  const cancel = new AbortController(); const starting = workspace.start(cancel.signal);
  const stopped = expect(starting).rejects.toThrow('cancel private build');
  await building.promise;
  let ready = 0; const first = workspace.whenIdle().then(() => { ready++; }); const second = workspace.whenIdle().then(() => { ready++; });
  await Promise.resolve(); expect(ready).toBe(0);
  cancel.abort(new Error('cancel private build')); release.resolve(); await abandoned.promise;
  await Promise.resolve(); expect(ready).toBe(0);
  releaseAbandon.resolve(); await stopped; await Promise.all([first, second]); expect(ready).toBe(2);
  await workspace.whenIdle();
});

it('whenIdle waits until failed replacement resource cleanup and old reservation release finish', async () => {
  const workers: TestWorker[] = []; const abandoning = deferred(); const release = deferred(); let builds = 0;
  const workspace = new SessionWorkspace({
    spawn: () => { const worker = new TestWorker(); workers.push(worker); return worker as unknown as Worker; },
    epoch: () => `replace-idle-${workers.length}`, engine: { gpu: false, threads: 1 },
    build: async () => ({ dispose: vi.fn(), ...(builds++ === 0 ? {} : { abandon: async () => { abandoning.resolve(); await release.promise; } }) }),
    publish: () => undefined,
  });
  const active = await workspace.start();
  // Candidate resources exist, but retiring the old producer fails and enters async cleanup.
  const original = active.transport.channel.request.bind(active.transport.channel);
  vi.spyOn(active.transport.channel, 'request').mockImplementation((request, ...args) => request.op === 'retire' ? Promise.reject(new Error('retire failed')) : original(request, ...args));
  const replacing = workspace.replace(active.transport, { kind: 'commands', commands: [fresh] });
  const failed = expect(replacing).rejects.toThrow('retire failed');
  await abandoning.promise;
  let idle = false; const waiting = workspace.whenIdle().then(() => { idle = true; });
  await Promise.resolve(); const releasedEarly = idle;
  release.resolve(); await failed; await waiting;
  try { expect(releasedEarly).toBe(false); await active.transport.dispatch(body); }
  finally { active.transport.channel.close(); }
});

it('saves and exports the checked SI document under unreadable display units and bounds later oversized files before I/O', async () => {
  const { workspace } = setup();
  const commands = JSON.parse(readFileSync(require.resolve('../../../crates/engine/tests/fixtures/document-display-overflow.json'), 'utf8')) as Command[];
  const initial = await workspace.start();
  const transport = await workspace.replace(initial.transport, { kind: 'commands', commands: [commands[0]!] });
  const { host, registry } = saveHost(transport);
  try {
    let ack: Ack | undefined;
    for (const command of commands.slice(1)) ack = await transport.dispatch(command);
    assert(ack);
    const before = await transport.query({ query: 'query.document' });
    assert('file' in before && 'hash' in before && 'revision' in before);
    const validate = new Ajv({ strict: false }).compile(schema.queryResult);
    expect(validate(JSON.parse(JSON.stringify(before))), JSON.stringify(validate.errors)).toBe(true);
    expect(schema.queries.oneOf.find(q => q.properties.query.const === 'query.document')).toMatchObject({ 'x-execution': 'modelRead', 'x-returns': 'ModelDocument' });
    expect(before.hash).toBe(ack.hash);
    expect(before.revision).toBe(ack.revision);
    expect(before.file.model.units).toMatchObject({ length: 'mm', force: 'mN' });
    expect(before.file.model.loads).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'plus', total: [1e307, 0, 0] }), expect.objectContaining({ name: 'minus', total: [-1e307, 0, 0] })]));
    const stamp = transport.stamp;
    const retained = await transport.query({ query: 'query.results' });
    for (const read of [() => transport.query({ query: 'query.model' }), () => transport.snapshot()]) {
      await expect(read()).rejects.toMatchObject({ code: 'unit.display', where: 'displayUnits' });
      expect(await transport.query({ query: 'query.document' })).toEqual(before);
      expect(await transport.query({ query: 'query.results' })).toEqual(retained);
      expect(transport.stamp).toEqual(stamp);
    }
    const detached = await transport.exportFile();
    detached.model.name = 'detached reply';
    detached.journal.entries.length = 0;
    expect(await transport.exportFile()).toEqual(before.file);
    await registry.dispatch({ cmd: 'file.save', name: 'recovery.femlab.json', to: 'folder' });
    expect(host.folder.writeText).toHaveBeenCalledOnce();
    const text = vi.mocked(host.folder.writeText).mock.calls[0]![1];
    expect(JSON.parse(text)).toEqual(before.file);
    expect(new TextEncoder().encode(text).byteLength).toBeLessThan(MAX_MODEL_FILE_BYTES);
    expect(await transport.query({ query: 'query.document' })).toEqual(before);
    const script = await transport.query({ query: 'query.script' });
    assert('text' in script);
    for (const format of ['journal', 'script'] as const) {
      vi.mocked(host.folder.writeText).mockClear();
      const delivery = await registry.dispatch({ cmd: 'file.export', spec: { format }, to: 'folder' });
      expect(host.folder.writeText).toHaveBeenCalledOnce();
      const exported = vi.mocked(host.folder.writeText).mock.calls[0]![1];
      expect(delivery).toEqual({ name: `${before.file.model.name}.${format === 'journal' ? 'femlab.json' : 'ts'}`, to: 'folder', bytes: new TextEncoder().encode(exported).byteLength, mime: format === 'journal' ? 'application/json' : 'text/typescript', unavailable: 'unsupported' });
      if (format === 'journal') expect(JSON.parse(exported)).toEqual(before.file);
      else expect(exported).toBe(script.text);
      expect(await transport.query({ query: 'query.document' })).toEqual(before);
      expect(await transport.query({ query: 'query.results' })).toEqual(retained);
      expect(transport.stamp).toEqual(stamp);
      await expect(transport.snapshot()).rejects.toMatchObject({ code: 'unit.display', where: 'displayUnits' });
    }
    // A legal post-admission edit can grow the Model+Journal over the save budget.
    await transport.dispatch({ cmd: 'model.setName', name: 'x'.repeat(MAX_MODEL_FILE_BYTES / 2) });
    vi.mocked(host.folder.writeText).mockClear();
    await expect(registry.dispatch({ cmd: 'file.save', name: 'too-large.femlab.json', to: 'folder' })).rejects.toMatchObject({ code: 'schema', where: 'file' });
    await expect(registry.dispatch({ cmd: 'file.export', spec: { format: 'journal' }, to: 'folder' })).rejects.toMatchObject({ code: 'schema', where: 'file' });
    expect(host.folder.writeText).not.toHaveBeenCalled();
    expect(host.files.download).not.toHaveBeenCalled();
    expect(await transport.query({ query: 'query.results' })).toMatchObject({ records: expect.arrayContaining([expect.objectContaining({ id: 'result-1' })]) });
  } finally { transport.channel.close(); }
});

it('refuses checked document save and exports from cancelled and replaced producers before file I/O', async () => {
  const { workspace } = setup();
  const active = await workspace.start();
  const writer = await active.transport.fork();
  const old = await writer.fork();
  const cancelledSave = saveHost(active.transport);
  const oldSave = saveHost(old);
  await active.transport.release();
  await expect(cancelledSave.registry.dispatch({ cmd: 'file.save', to: 'folder' })).rejects.toMatchObject({ code: 'cancelled' });
  for (const format of ['journal', 'script']) await expect(cancelledSave.registry.dispatch({ cmd: 'file.export', spec: { format }, to: 'folder' })).rejects.toMatchObject({ code: 'cancelled' });
  expect(cancelledSave.host.folder.writeText).not.toHaveBeenCalled();
  expect(cancelledSave.host.files.download).not.toHaveBeenCalled();
  const next = await workspace.replace(writer, { kind: 'commands', commands: [{ cmd: 'model.new', name: 'replacement' }] });
  try {
    const before = await next.exportFile();
    await expect(oldSave.registry.dispatch({ cmd: 'file.save', to: 'folder' })).rejects.toMatchObject({ code: 'session.expired' });
    for (const format of ['journal', 'script']) await expect(oldSave.registry.dispatch({ cmd: 'file.export', spec: { format }, to: 'folder' })).rejects.toMatchObject({ code: 'session.expired' });
    expect(oldSave.host.folder.writeText).not.toHaveBeenCalled();
    expect(oldSave.host.files.download).not.toHaveBeenCalled();
    expect(await next.exportFile()).toEqual(before);
  } finally { next.channel.close(); }
});

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

it('cancels only the initial private Worker, fences its late create reply, and retries with a fresh epoch', async () => {
  const workers: TestWorker[] = [];
  const held = deferred();
  const publications: string[] = [];
  const workspace = new SessionWorkspace({
    spawn: () => { const worker = new TestWorker(); if (workers.length === 0) worker.pause = held.promise; workers.push(worker); return worker as unknown as Worker; },
    epoch: () => `startup-${workers.length}`,
    engine: { gpu: false, threads: 1 },
    build: async () => ({ dispose: vi.fn() }),
    publish: session => { publications.push(session.transport.stamp.session.backendEpoch); },
  });
  const already = new AbortController(); already.abort(new Error('already cancelled'));
  await expect(workspace.start(already.signal)).rejects.toThrow('already cancelled'); expect(workers).toHaveLength(0);
  const controller = new AbortController();
  const starting = workspace.start(controller.signal);
  expect(workers[0]!.requests.map(request => request.op)).toEqual(['create']);
  controller.abort(new Error('cancel startup'));
  await expect(starting).rejects.toMatchObject({ code: 'cancelled' });
  expect(workers[0]!.terminated).toBe(true); expect(publications).toEqual([]);
  held.resolve();
  const activeController = new AbortController();
  const active = await workspace.start(activeController.signal);
  expect(publications).toEqual(['startup-2']);
  activeController.abort(new Error('late abort after publication'));
  expect(workers[1]!.terminated).toBe(false);
  expect(await active.transport.query({ query: 'query.model' })).toHaveProperty('name');
  active.transport.channel.close();
});

it('abandons a late-built private resource bundle before permitting a cancelled initial startup retry', async () => {
  const building = deferred(); const release = deferred(); const abandoned = deferred(); const releaseAbandon = deferred();
  const dispose = vi.fn(); const publications = vi.fn(); const workers: TestWorker[] = [];
  const workspace = new SessionWorkspace({
    spawn: () => { const worker = new TestWorker(); workers.push(worker); return worker as unknown as Worker; },
    epoch: () => `build-${workers.length}`, engine: { gpu: false, threads: 1 },
    build: async () => { building.resolve(); await release.promise; return { dispose, abandon: async () => { abandoned.resolve(); await releaseAbandon.promise; } }; },
    publish: publications,
  });
  const controller = new AbortController(); const starting = workspace.start(controller.signal);
  await building.promise; controller.abort(new Error('cancel while building')); expect(workers[0]!.terminated).toBe(true);
  release.resolve(); await abandoned.promise;
  await expect(workspace.start()).rejects.toMatchObject({ code: 'session.conflict' }); expect(dispose).not.toHaveBeenCalled();
  const stopped = expect(starting).rejects.toThrow('cancel while building'); releaseAbandon.resolve(); await stopped;
  expect(dispose).toHaveBeenCalledTimes(1); expect(publications).not.toHaveBeenCalled();
  const active = await workspace.start(); expect(publications).toHaveBeenCalledTimes(1); active.transport.channel.close();
});
