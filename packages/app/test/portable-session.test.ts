import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type { Command, DocumentSnapshot, PortableProject, RunLease, Stamp } from '@femlab/registry';
import { scientificJson, MAX_MODEL_FILE_BYTES, modelFileEncoder } from '@femlab/registry';
import { SessionRuntime } from '../src/session-runtime';
import { SessionChannel, SessionTransport } from '../src/session-transport';
import { SessionWorkspace } from '../src/session-workspace';
import type { ReplacementSource, SessionRequest, SessionResponse } from '../src/session-protocol';
const wasm = createRequire(import.meta.url)('../../../tools/wasm-node/femlab_engine_wasm.js') as typeof import('../src/generated/wasm/femlab_engine_wasm');

class ProjectWorker {
  onmessage: ((event: MessageEvent<SessionResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  requests: SessionRequest[] = [];
  engine: InstanceType<typeof wasm.SessionEngine> | undefined;
  readonly runtime = new SessionRuntime(async (options, epoch) => this.engine = new wasm.SessionEngine(options.threads, epoch),
    (ticket, options) => wasm.PreparedEngine.create(ticket, options), () => 0);
  postMessage(request: SessionRequest): void {
    this.requests.push(structuredClone(request));
    void this.runtime.accept(structuredClone(request), reply => this.onmessage?.({ data: structuredClone(reply) } as MessageEvent<SessionResponse>));
  }
  terminate(): void { this.engine?.free(); this.engine = undefined; }
}
function setup() {
  const workers: ProjectWorker[] = [];
  const published: DocumentSnapshot[] = [];
  const workspace = new SessionWorkspace({ spawn: () => { const worker = new ProjectWorker(); workers.push(worker); return worker as unknown as Worker; },
    epoch: () => `portable-worker-${workers.length}`, engine: { gpu: false, threads: 1 },
    build: async (_transport, snapshot) => ({ snapshot, dispose: vi.fn() }), publish: session => published.push(session.initial) });
  return { workspace, workers, published, dispose: () => { for (const worker of workers) worker.terminate(); } };
}
const thermal: Command[] = [
  { cmd: 'model.setName', name: 'portable thermal' },
  { cmd: 'geometry.addBox', name: 'bar', size: ['1 m', '0.1 m', '0.1 m'] },
  { cmd: 'material.add', name: 'steel', E: '210 GPa', nu: 0.3, k: '45 W/(m K)' },
  { cmd: 'material.assign', material: 'steel', bodies: ['bar'] },
  { cmd: 'mesh.set', mesher: { kind: 'lattice', size: { nx: 3, ny: 1, nz: 1 } } },
  { cmd: 'constraint.temperature', name: 'cold', on: 'bar.xmin', value: '0 degC' },
  { cmd: 'load.heatFlux', name: 'hot', on: 'bar.xmax', q: '1000 W/m^2' },
  { cmd: 'step.add', name: 'heat', procedure: 'heat-steady', constraints: ['cold'], loads: ['hot'] },
  { cmd: 'solve.run', step: 'heat', solver: 'cpu-direct' },
  { cmd: 'solve.run', step: 'heat', solver: 'cpu-direct' },
];

describe('portable project Worker transport', () => {
  it('exports one coherent checked SI project and stamp between queued writes', async () => {
    const h = setup();
    try {
      const { transport } = await h.workspace.start();
      const first = transport.dispatch({ cmd: 'model.setName', name: 'captured ☃' });
      const read = transport.exportProject();
      const later = transport.dispatch({ cmd: 'model.setName', name: 'later mutation' });
      await first; const captured = await read; await later;
      expect(captured.project.format).toBe('femlab-project/1');
      expect(captured.project.file.model.name).toBe('captured ☃');
      expect(captured.stamp.session).toEqual(transport.stamp.session);
      expect(BigInt(captured.stamp.stateVersion)).toBeLessThan(BigInt(transport.stamp.stateVersion));
      const reads = h.workers[0]!.requests.filter(request => request.op === 'query' && request.query.query === 'query.portableProject');
      expect(reads).toHaveLength(1);
      captured.project.file.model.name = 'caller-owned mutation';
      expect((await transport.exportProject()).project.file.model.name).toBe('later mutation');
      const fresh = await transport.fork(); await transport.release();
      await expect(transport.exportProject()).rejects.toMatchObject({ code: 'cancelled' });
      expect((await fresh.exportProject()).project.file.model.name).toBe('later mutation');
    } finally { h.dispose(); }
  });

  it('restores retained meshes and exact f64 fields through private preparation without rerunning solves', async () => {
    const h = setup();
    try {
      const { transport } = await h.workspace.start();
      for (const command of thermal) await transport.dispatch(command);
      const exported = await transport.exportProject();
      const catalog = await transport.query({ query: 'query.results' });
      expect('records' in catalog && catalog.records.length).toBe(2);
      if (!('records' in catalog)) throw new Error('missing retained results');
      const retained = await Promise.all(catalog.records.map(async record => ({ id: record.id,
        surface: await transport.query({ query: 'query.surface', resultId: record.id }),
        field: await transport.query({ query: 'query.field', resultId: record.id, field: 'temperature' }) })));
      const next = await transport.replaceWith({ kind: 'portable', portable: exported.project }, exported.stamp);
      expect(h.published).toHaveLength(2);
      expect(next.stamp.session).not.toEqual(exported.stamp.session);
      expect((await next.exportProject()).project).toEqual(exported.project);
      expect(await next.query({ query: 'query.results' })).toEqual(catalog);
      for (const record of retained) {
        expect(await next.query({ query: 'query.surface', resultId: record.id })).toEqual(record.surface);
        expect(await next.query({ query: 'query.field', resultId: record.id, field: 'temperature' })).toEqual(record.field);
      }
      const preparation = h.workers[1]!.requests.find(request => request.op === 'prepare');
      expect(preparation).toMatchObject({ source: { kind: 'portable', portable: exported.project } });
      expect(h.workers[1]!.requests.filter(request => request.op === 'dispatch')).toEqual([]);
      await expect(transport.exportProject()).rejects.toMatchObject({ code: 'session.expired' });
      await next.dispatch({ cmd: 'solve.run', step: 'heat', solver: 'cpu-direct' });
      expect(await next.query({ query: 'query.results' })).toMatchObject({ records: expect.arrayContaining([expect.objectContaining({ id: 'result-3' })]) });
    } finally { h.dispose(); }
  });

  it('preserves signed-zero scientific field values across portable replacement', async () => {
    const h = setup();
    try {
      const { transport } = await h.workspace.start();
      for (const command of thermal) await transport.dispatch(command);
      const exported = await transport.exportProject();
      const reaction = exported.project.results[0]!.result.fields.reaction!;
      expect(reaction.data[1]).toBe(0);
      reaction.data[1] = -0;
      const restored = await transport.replaceWith({ kind: 'portable', portable: exported.project }, exported.stamp);
      const actual = (await restored.exportProject()).project.results[0]!.result.fields.reaction!.data[1];
      expect(Object.is(actual, -0)).toBe(true);
    } finally { h.dispose(); }
  });

  it.each(['journal', 'file'] as const)('keeps checked native signed-zero Model provenance through %s recovery', async kind => {
    const h = setup();
    const owner = new wasm.SessionEngine(1, `native-signed-zero-${kind}`);
    try {
      const stamp = JSON.parse(owner.stamp()) as Stamp;
      const lease = JSON.parse(owner.begin_run(JSON.stringify(stamp.session))) as RunLease;
      const ticket = owner.begin_replacement(JSON.stringify({ session: lease.stamp.session, runId: lease.runId, operationId: '1' }), lease.stamp.stateVersion);
      const candidate = await wasm.PreparedEngine.create(ticket, { gpu: false, threads: 1 });
      await candidate.commands(scientificJson([
        { cmd: 'model.new', name: 'native signed zero' },
        { cmd: 'material.add', name: 'steel', E: '210 GPa', nu: -0 },
      ]));
      candidate.finish(modelFileEncoder(), MAX_MODEL_FILE_BYTES);
      const native = JSON.parse(owner.commit_candidate(candidate)) as DocumentSnapshot;
      expect(Object.is(native.file.model.materials![0]!.nu, -0)).toBe(true);
      const saved = JSON.parse(modelFileEncoder()(scientificJson(native.file))) as DocumentSnapshot['file'];
      expect(Object.is(saved.model.materials![0]!.nu, -0)).toBe(true);
      expect(saved.journal).toEqual(native.file.journal);
      const { transport } = await h.workspace.start();
      const source: ReplacementSource = kind === 'file' ? { kind, file: saved } : { kind, entries: native.file.journal.entries, skipSolves: true };
      const restored = await transport.replaceWith(source, transport.stamp);
      const actual = await restored.snapshot();
      expect(Object.is(actual.file.model.materials![0]!.nu, -0)).toBe(true);
      expect(actual.file.journal).toEqual(native.file.journal);
      expect(actual.model.hash).toBe(native.model.hash);
    } finally { owner.free(); h.dispose(); }
  });

  it('keeps the original session readable and writable if portable validation fails before publication', async () => {
    const h = setup();
    try {
      const { transport } = await h.workspace.start();
      await transport.dispatch({ cmd: 'model.setName', name: 'keep original' });
      const before = await transport.exportProject();
      const invalid = structuredClone(before.project); invalid.format = 'invalid' as PortableProject['format'];
      await expect(transport.replaceWith({ kind: 'portable', portable: invalid }, before.stamp)).rejects.toMatchObject({ code: 'schema' });
      expect(h.published).toHaveLength(1);
      expect(h.workspace.active.transport).toBe(transport);
      expect(await transport.exportProject()).toEqual(before);
      await transport.dispatch({ cmd: 'model.setName', name: 'still writable' });
      expect((await transport.exportProject()).project.file.model.name).toBe('still writable');
    } finally { h.dispose(); }
  });

  it('preserves the replacement-source ownership key used by host-file recovery', async () => {
    const source = { kind: 'portable' as const, portable: {} as PortableProject };
    const ownedFiles = new WeakMap([[source, 'original retained output']]);
    const stamp: Stamp = { session: { backendEpoch: 'owner', sessionId: '1' }, stateVersion: '1' };
    const transport = new SessionTransport({} as SessionChannel, { stamp, runId: '1' }, async (origin, received) => {
      expect(ownedFiles.get(received as typeof source)).toBe('original retained output');
      return origin;
    });
    expect(await transport.replaceWith(source)).toBe(transport);
  });

  it('uses the checked read stamp, and rejects a reply from another session', async () => {
    const stamp: Stamp = { session: { backendEpoch: 'original', sessionId: '1' }, stateVersion: '4' };
    const lease: RunLease = { stamp, runId: '1' };
    const request = vi.fn(async () => ({ stamp: { ...stamp, stateVersion: '5' }, value: { format: 'femlab-project/1' } }));
    const channel = { request } as unknown as SessionChannel;
    const transport = new SessionTransport(channel, lease, async () => { throw new Error('unused replacement'); });
    const read = await transport.exportProject(); expect(read.stamp.stateVersion).toBe('5');
    read.stamp.stateVersion = 'caller mutation'; expect(transport.stamp.stateVersion).toBe('5');
    request.mockResolvedValueOnce({ stamp: { session: { backendEpoch: 'other', sessionId: '2' }, stateVersion: '6' }, value: { format: 'femlab-project/1' } });
    await expect(transport.exportProject()).rejects.toMatchObject({ code: 'session.expired' });
  });
});

describe('portable WASM candidate boundary', () => {
  it.each(['parse', 'oversize'])('consumes a %s failure before exposing a replacement', async mode => {
    const owner = new wasm.SessionEngine(1, `portable-${mode}`);
    let candidate: Awaited<ReturnType<typeof wasm.PreparedEngine.create>> | undefined;
    try {
      const stamp = JSON.parse(owner.stamp()) as Stamp;
      const lease = JSON.parse(owner.begin_run(JSON.stringify(stamp.session))) as RunLease;
      const context = { session: stamp.session, runId: lease.runId, operationId: '1' };
      const before = owner.snapshot(JSON.stringify(context));
      const ticket = owner.begin_replacement(JSON.stringify(context), stamp.stateVersion);
      candidate = await wasm.PreparedEngine.create(ticket, { gpu: false, threads: 1 });
      const raw = mode === 'parse' ? '{invalid JSON' : 'æ'.repeat(32 * 1024 * 1024 + 1);
      await expect(candidate.project(raw)).rejects.toMatchObject({ code: 'schema', ...(mode === 'oversize' ? { cause: expect.stringContaining('64 MiB') } : {}) });
      expect(() => candidate!.finish(modelFileEncoder(), MAX_MODEL_FILE_BYTES)).toThrow();
      expect(owner.snapshot(JSON.stringify(context))).toBe(before);
      owner.abandon_replacement(ticket);
    } finally { candidate?.free(); owner.free(); }
  });
});
