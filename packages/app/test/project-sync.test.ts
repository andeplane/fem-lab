import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { PROJECT_CHUNK_BYTES, type CloudProject, type CloudStorageStatus, type ProjectMeta, type DocumentSnapshot, type RunLease } from '@femlab/registry';
import { CloudProjectError, type CloudActor } from '../src/cloud-project-api';
import { memoryAtomicProjects, ProjectRepository, type AtomicProjects, type ProjectRecord } from '../src/project-repository';
import { partitionedAtomicProjects } from '../src/project-partitions';
import { ProjectSync, type CloudProjectTransport, type ProjectSyncEnvironment } from '../src/project-sync';

const REMOTE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const time = '2026-10-16T12:00:00Z';
const remote = (patch: Partial<CloudProject> = {}): CloudProject => ({ id: REMOTE, name: 'Cloud beam', bytes: 3, revision: '1', changeVersion: '1', updatedAt: time, deletedAt: null, ...patch });
const quota: CloudStorageStatus = { available: true, plan: 'plus', limitBytes: 2_000_000_000, usedBytes: 7, reservedBytes: 5, pendingBytes: 3, overQuota: false, maxChunkBytes: PROJECT_CHUNK_BYTES };
const meta = (id: string): ProjectMeta => ({ id, name: `Browser ${id}`, at: 1, createdAt: 0, commands: 1, hash: 'hash', thumbnail: null });
const local = (id = 'local', patch: Partial<ProjectRecord> = {}): ProjectRecord => ({ id, generation: 'generation', version: '1', meta: meta(id), cmds: [{ cmd: 'model.setName', name: 'beam' }], artifact: new Uint8Array([1, 2, 3]), artifactTag: 'snapshot-1', ...patch });
function snapshot(): DocumentSnapshot {
  const { SessionEngine } = createRequire(import.meta.url)('../../../tools/wasm-node/femlab_engine_wasm.js') as typeof import('../src/generated/wasm/femlab_engine_wasm');
  const engine = new SessionEngine(1, 'sync-save-regression');
  try {
    const session = JSON.parse(engine.stamp()).session;
    const lease = JSON.parse(engine.begin_run(JSON.stringify(session))) as RunLease;
    return JSON.parse(engine.snapshot(JSON.stringify({ session, runId: lease.runId, operationId: 'capture' }))) as DocumentSnapshot;
  } finally { engine.free(); }
}
const controllers: ProjectSync[] = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.activate(null); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const pendingFirstUpload = (id = 'original'): ProjectRecord => local(id, { cloud: { remote: null, dirty: true, deleted: false, upload: { key: 'original-operation-key', tag: 'snapshot-1', name: `Browser ${id}`, baseRevision: null, bytes: new Uint8Array([1, 2, 3]) } } });
function setup() {
  const base = memoryAtomicProjects(); const partitions = new Map<string | null, AtomicProjects>();
  const storage = (owner: string | null) => {
    if (!partitions.has(owner)) partitions.set(owner, partitionedAtomicProjects(base, owner));
    return partitions.get(owner)!;
  };
  let actor: CloudActor = { uid: 'A', epoch: 1 }; let online = true; let serial = 0;
  const remotes = new Map<string, CloudProject[]>(); const open = new Set<string>();
  const assert = vi.fn<CloudProjectTransport['assert']>(captured => { if (captured.uid !== actor.uid || captured.epoch !== actor.epoch || captured.signal?.aborted) throw new CloudProjectError(409, 'account.changed', 'Account changed.'); });
  const list = vi.fn<CloudProjectTransport['list']>(async captured => { assert(captured); return { projects: structuredClone(remotes.get(captured.uid) ?? []), nextCursor: null, storage: { ...quota } }; });
  const upload = vi.fn<CloudProjectTransport['upload']>(async (captured, input, progress) => {
    assert(captured); progress?.(input.bytes.length, input.bytes.length);
    const saved = remote({ id: input.id ?? REMOTE, name: input.name, bytes: input.bytes.length, revision: String(BigInt(input.baseRevision ?? '0') + 1n) });
    remotes.set(captured.uid, [...(remotes.get(captured.uid) ?? []).filter(row => row.id !== saved.id), saved]); return saved;
  });
  const remove = vi.fn<CloudProjectTransport['delete']>(async (captured, id, revision) => { assert(captured); const saved = remote({ id, revision: String(BigInt(revision) + 1n), bytes: 0, deletedAt: time }); remotes.set(captured.uid, [saved]); return saved; });
  const download = vi.fn<CloudProjectTransport['download']>(async (captured, id) => { assert(captured); return { project: remotes.get(captured.uid)!.find(row => row.id === id)!, bytes: new Uint8Array([8, 8, 8]) }; });
  const api: CloudProjectTransport = { assert, list, upload, delete: remove, download };
  const env: ProjectSyncEnvironment = { api, storage, nextId: () => `generated-${++serial}`, online: () => online, isOpen: (owner, id) => open.has(`${owner}/${id}`) };
  const controller = new ProjectSync(env);
  controllers.push(controller);
  return { controller, env, api, base, storage, remotes, open, list, upload, remove, download,
    offline: () => { online = false; }, online: () => { online = true; },
    activate: (uid = 'A', epoch = 1, target = controller) => { actor = { uid, epoch }; target.activate(actor); },
    seed: async (row: ProjectRecord, owner: string | null = 'A') => { await storage(owner).update(row.id, () => row); },
    // Fake storage/network operations resolve in microtasks. Do not call flush here: that is
    // an explicit user retry and would accidentally retry offline/quota failures under test.
    settled: async (target = controller) => { await vi.waitFor(() => expect(target.current.refreshing).toBe(false)); await new Promise(resolve => setTimeout(resolve, 0)); },
  };
}

describe('durable account-owned project sync', () => {
  it('reconciles a lost first-commit receipt by original key without associating projects by filename', async () => {
    const f = setup(); const original = pendingFirstUpload(); const receipt = remote({ name: 'Matching file name' });
    const unrelated = local('same-name-unrelated', { meta: { ...meta('same-name-unrelated'), name: receipt.name }, cloud: { remote: null, dirty: false, deleted: false } });
    await f.seed(original); await f.seed(unrelated); f.remotes.set('A', [receipt]);
    const gate = deferred<CloudProject>(); f.upload.mockImplementationOnce(() => gate.promise);
    f.activate(); await vi.waitFor(() => expect(f.upload).toHaveBeenCalledOnce());
    expect((await f.storage('A').read('original'))?.cloud?.remote).toBeNull();
    expect((await f.storage('A').read(`cloud-${REMOTE}`))?.meta).not.toBeNull();
    gate.resolve(receipt); await f.settled();
    expect(f.upload.mock.calls[0]![1]).toEqual({ id: undefined, name: 'Browser original', baseRevision: null, key: 'original-operation-key', bytes: new Uint8Array([1, 2, 3]) });
    const rows = await f.storage('A').scan();
    expect(rows.filter(row => row.meta && row.cloud?.remote?.id === REMOTE).map(row => row.id)).toEqual(['original']);
    expect((await f.storage('A').read(`cloud-${REMOTE}`))?.meta).toBeNull();
    expect((await f.storage('A').read('original'))?.artifact).toEqual(original.artifact);
    expect((await f.storage('A').read('original'))?.cloud).toMatchObject({ remote: receipt, dirty: false });
    expect(await f.storage('A').read('same-name-unrelated')).toEqual(unrelated);
    expect(f.controller.current.projects[`cloud-${REMOTE}`]).toBeUndefined();
  });

  it.each(['generation', 'artifact', 'journal', 'commands', 'dirty', 'open'] as const)('preserves an %s placeholder and both conflicts when the authoritative first receipt arrives', async changed => {
    const f = setup(); const original = pendingFirstUpload(); const receipt = remote(); const id = `cloud-${REMOTE}`;
    const placeholder: ProjectRecord = { id, generation: null, version: '0', meta: meta(id), cmds: [], cloud: { remote: receipt, dirty: false, deleted: false } };
    if (changed === 'generation') placeholder.generation = 'opened-generation';
    if (changed === 'artifact') { placeholder.artifact = new Uint8Array([77, 88, 99]); placeholder.artifactTag = 'duplicate private files'; }
    if (changed === 'journal') placeholder.journal = snapshot().file.journal;
    if (changed === 'commands') placeholder.cmds = [{ cmd: 'model.setName', name: 'edited duplicate' }];
    if (changed === 'dirty') placeholder.cloud!.dirty = true;
    if (changed === 'open') f.open.add(`A/${id}`);
    await f.seed(original); await f.seed(placeholder); f.remotes.set('A', [receipt]); f.activate(); await f.settled();
    expect(f.upload).toHaveBeenCalledOnce();
    expect(await f.storage('A').read(id)).toEqual({ ...placeholder, cloud: { ...placeholder.cloud!, conflict: remote({ name: 'Browser original' }) } });
    const keptOriginal = (await f.storage('A').read('original'))!;
    expect(keptOriginal.artifact).toEqual(original.artifact); expect(keptOriginal.cloud?.conflict).toEqual(remote({ name: 'Browser original' }));
    expect(f.controller.current.projects.original?.phase).toBe('conflict'); expect(f.controller.current.projects[id]?.phase).toBe('conflict');
    await f.controller.flush(); expect(f.upload).toHaveBeenCalledOnce();
  });

  it('cancels only an explicitly deleted terminal expired first upload without rotating its key', async () => {
    const f = setup(); const original = pendingFirstUpload(); original.meta = null; original.cmds = []; original.cloud!.deleted = true;
    await f.seed(original); const nextId = vi.spyOn(f.env, 'nextId');
    f.upload.mockRejectedValueOnce(new CloudProjectError(410, 'upload-expired', 'The never-committed upload expired.'));
    f.activate(); await f.settled();
    const cancelled = (await f.storage('A').read(original.id))!;
    expect(cancelled.meta).toBeNull(); expect(cancelled.artifact).toBeUndefined(); expect(cancelled.artifactTag).toBeUndefined();
    expect(cancelled.cloud).toMatchObject({ remote: null, deleted: true, dirty: false }); expect(cancelled.cloud?.upload).toBeUndefined();
    expect(f.upload).toHaveBeenCalledOnce(); expect(f.upload.mock.calls[0]![1].key).toBe('original-operation-key');
    expect(nextId).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
    await f.controller.flush(); expect(f.upload).toHaveBeenCalledOnce(); expect(f.controller.current.projects).toEqual({});
  });

  it.each(['live', 'other-code', 'other-status'] as const)('preserves the original pending request for a %s expiration response', async kind => {
    const f = setup(); const original = pendingFirstUpload();
    if (kind !== 'live') { original.meta = null; original.cmds = []; original.cloud!.deleted = true; }
    await f.seed(original); const nextId = vi.spyOn(f.env, 'nextId');
    f.upload.mockRejectedValueOnce(new CloudProjectError(kind === 'other-status' ? 400 : 410, kind === 'other-code' ? 'project.not-found' : 'upload-expired', 'The request was rejected.'));
    f.activate(); await f.settled();
    expect(await f.storage('A').read(original.id)).toEqual(original);
    expect(f.upload).toHaveBeenCalledOnce(); expect(f.upload.mock.calls[0]![1].key).toBe('original-operation-key'); expect(nextId).not.toHaveBeenCalled();
    expect(f.controller.current.projects.original?.phase).toBe('error');
  });

  it('marks a remote tombstone conflict explicitly while preserving the live browser artifact', async () => {
    const f = setup(); const original = local('local', { cloud: { remote: remote(), dirty: true, deleted: false } });
    const deleted = remote({ revision: '2', bytes: 0, deletedAt: time }); await f.seed(original); f.remotes.set('A', [deleted]); f.activate(); await f.settled();
    expect(f.controller.current.projects.local).toMatchObject({ phase: 'conflict', remoteDeleted: true, deleted: false });
    expect((await f.storage('A').read('local'))?.artifact).toEqual(original.artifact); expect(f.upload).not.toHaveBeenCalled();
  });

  it('merges another browser’s remote projects and authoritative quota without importing anonymous rows', async () => {
    const f = setup(); await f.seed(local('anonymous'), null); f.remotes.set('A', [remote()]);
    f.activate(); await f.settled();
    const id = `cloud-${REMOTE}`;
    expect((await f.storage('A').read(id))?.cloud?.remote).toEqual(remote());
    expect(f.controller.current.projects).toEqual({ [id]: { phase: 'remote', message: null, name: 'Cloud beam', deleted: false } });
    expect(f.controller.current.storage).toEqual(quota);
    expect(await f.storage('A').read('anonymous')).toBeNull();
    const exposed = f.controller.current; exposed.storage!.usedBytes = 999;
    expect(f.controller.current.storage!.usedBytes).toBe(7);
  });

  it('automatically queues a completed owned save and leaves anonymous saves local', async () => {
    const f = setup(); await f.seed(local()); await f.seed(local('anonymous'), null);
    f.activate(); await f.settled(); expect(f.upload).not.toHaveBeenCalled();
    await f.controller.changed(null, 'anonymous'); await f.controller.changed('A', 'local'); await f.settled();
    expect(f.upload).toHaveBeenCalledOnce();
    expect(f.upload.mock.calls[0]![1]).toMatchObject({ name: 'Browser local', baseRevision: null, key: 'generated-1', bytes: new Uint8Array([1, 2, 3]) });
    expect((await f.storage('A').read('local'))?.cloud).toMatchObject({ dirty: false, deleted: false, remote: remote({ name: 'Browser local' }) });
    expect(f.controller.current.projects.local!.phase).toBe('synced');
    expect((await f.storage(null).read('anonymous'))?.cloud).toBeUndefined();
  });

  it('keeps offline saves dirty and resumes them after reconnect', async () => {
    const f = setup(); f.offline(); await f.seed(local()); f.activate(); await f.settled();
    await f.controller.changed('A', 'local'); await f.settled();
    expect(f.upload).not.toHaveBeenCalled();
    expect((await f.storage('A').read('local'))?.cloud?.dirty).toBe(true);
    expect(f.controller.current.projects.local!.phase).toBe('offline');
    f.online(); await f.controller.refresh(); await f.settled();
    expect(f.upload).toHaveBeenCalledOnce();
    expect((await f.storage('A').read('local'))?.cloud?.dirty).toBe(false);
  });

  it('shows the durable conflict after an offline edit meets a newer cloud revision on reconnect', async () => {
    const f = setup(); const base = remote();
    await f.seed(local('local', { cloud: { remote: base, dirty: false, deleted: false } })); f.remotes.set('A', [base]);
    f.activate(); await f.settled(); f.offline();
    await f.storage('A').update('local', previous => ({ ...previous!, version: '2', cmds: [{ cmd: 'model.setName', name: 'offline model edit' }], artifact: new Uint8Array([7, 8, 9]), artifactTag: 'offline snapshot' }));
    await f.controller.changed('A', 'local'); await f.settled();
    expect(f.controller.current.projects.local?.phase).toBe('offline'); expect(f.upload).not.toHaveBeenCalled();
    const offline = (await f.storage('A').read('local'))!;
    const changed = remote({ revision: '2', changeVersion: '2', name: 'Edited in another browser' }); f.remotes.set('A', [changed]);
    f.online(); await f.controller.refresh(); await f.settled();
    expect(f.controller.current.projects.local).toMatchObject({ phase: 'conflict', message: 'The cloud project changed. Both versions are preserved.' });
    const conflicted = (await f.storage('A').read('local'))!;
    expect(conflicted.artifact).toEqual(offline.artifact); expect(conflicted.artifactTag).toBe(offline.artifactTag); expect(conflicted.cmds).toEqual(offline.cmds);
    expect(conflicted.cloud).toMatchObject({ remote: base, conflict: changed, dirty: true });
    await f.controller.flush(); expect(f.upload).not.toHaveBeenCalled(); expect(await f.storage('A').read('local')).toEqual(conflicted);
  });

  it('refreshes authoritative storage usage after upload without silently merging that page’s newer metadata', async () => {
    const f = setup(); await f.seed(local()); f.activate(); await f.settled();
    f.list.mockResolvedValueOnce({ projects: [remote({ revision: '999', name: 'Unopened newer model' })], nextCursor: null, storage: { ...quota, usedBytes: 123 } });
    await f.controller.changed('A', 'local'); await f.settled();
    expect(f.controller.current.storage?.usedBytes).toBe(123);
    expect((await f.storage('A').read('local'))?.cloud?.remote?.revision).toBe('1');
    expect((await f.storage('A').read('local'))?.artifactTag).toBe('snapshot-1');
  });

  it('retains a successful upload when the following storage usage refresh fails', async () => {
    const f = setup(); await f.seed(local()); f.activate(); await f.settled();
    f.list.mockRejectedValueOnce(new CloudProjectError(0, 'project.offline', 'Usage service unavailable.'));
    await f.controller.changed('A', 'local'); await f.settled();
    expect((await f.storage('A').read('local'))?.cloud?.dirty).toBe(false);
    expect(f.controller.current.projects.local?.phase).toBe('synced');
    expect(f.controller.current.error).toContain('storage usage could not refresh');
    expect(f.upload).toHaveBeenCalledOnce();
  });

  it('does not let a delayed progress scan replace the final synced publication', async () => {
    const f = setup(); await f.seed(local()); f.activate(); await f.settled();
    const storage = f.storage('A'); const scan = storage.scan.bind(storage);
    const held = deferred<ProjectRecord[]>(); let delayNextScan = false;
    vi.spyOn(storage, 'scan').mockImplementation(() => { if (delayNextScan) { delayNextScan = false; return held.promise; } return scan(); });
    let stale: ProjectRecord[] = [];
    f.upload.mockImplementationOnce(async (_actor, input, progress) => {
      stale = await scan(); delayNextScan = true; progress?.(1, input.bytes.length);
      return remote({ name: input.name });
    });
    await f.controller.changed('A', 'local'); await f.settled();
    expect(f.controller.current.projects.local?.phase).toBe('synced');
    held.resolve(stale); await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.controller.current.projects.local?.phase).toBe('synced');
  });

  it('keeps the complete pending upload on quota failure and retries the same snapshot', async () => {
    const f = setup(); await f.seed(local()); f.activate(); await f.settled();
    f.upload.mockRejectedValueOnce(new CloudProjectError(507, 'project.storage-full', 'Upgrade or free cloud storage.'));
    await f.controller.changed('A', 'local'); await f.settled();
    expect(f.controller.current.projects.local?.phase).toBe('quota');
    const pending = (await f.storage('A').read('local'))?.cloud?.upload;
    expect(pending?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    const first = structuredClone(f.upload.mock.calls[0]![1]);
    await f.controller.flush();
    expect(f.upload.mock.calls[1]![1]).toEqual(first);
    expect((await f.storage('A').read('local'))?.cloud?.dirty).toBe(false);
  });

  it('replays a persisted pending upload with the identical idempotency key and byte snapshot after reload', async () => {
    const f = setup(); await f.seed(local()); f.activate(); await f.settled();
    f.upload.mockRejectedValueOnce(new CloudProjectError(0, 'project.offline', 'Network lost.'));
    await f.controller.changed('A', 'local'); await f.settled();
    const first = structuredClone(f.upload.mock.calls[0]![1]);
    const persisted = (await f.storage('A').read('local'))!;
    expect(persisted.cloud?.upload?.key).toBe(first.key);
    expect(persisted.artifact).toEqual(new Uint8Array([1, 2, 3]));
    f.controller.activate(null);
    const reloaded = new ProjectSync(f.env); controllers.push(reloaded); f.activate('A', 2, reloaded); await f.settled(reloaded);
    expect(f.upload.mock.calls[1]![1]).toEqual(first);
    expect((await f.storage('A').read('local'))?.cloud?.dirty).toBe(false);
    expect((await f.storage('A').read('local'))?.cloud?.upload).toBeUndefined();
  });

  it('retains an edit made during an older upload and uploads it against the newly committed base', async () => {
    const f = setup(); await f.seed(local()); f.activate(); await f.settled();
    const gate = deferred<CloudProject>(); f.upload.mockImplementationOnce(() => gate.promise);
    await f.controller.changed('A', 'local'); await vi.waitFor(() => expect(f.upload).toHaveBeenCalledOnce());
    await f.storage('A').update('local', previous => ({ ...previous!, version: '2', artifact: new Uint8Array([4, 5, 6]), artifactTag: 'snapshot-2' }));
    await f.controller.changed('A', 'local');
    gate.resolve(remote({ name: 'Browser local' }));
    await vi.waitFor(() => expect(f.upload).toHaveBeenCalledTimes(2)); await f.settled();
    expect(f.upload.mock.calls[0]![1].bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(f.upload.mock.calls[1]![1]).toMatchObject({ id: REMOTE, baseRevision: '1', bytes: new Uint8Array([4, 5, 6]) });
    const final = (await f.storage('A').read('local'))!;
    expect(final.artifactTag).toBe('snapshot-2'); expect(final.cloud?.remote?.revision).toBe('2'); expect(final.cloud?.dirty).toBe(false);
  });

  it.each(['own receipt', 'newer remote'] as const)('reconciles a reconnect listing with an in-flight upload: %s', async kind => {
    const f = setup(); const base = remote();
    await f.seed(local('local', { cloud: { remote: base, dirty: false, deleted: false } }));
    f.remotes.set('A', [base]); f.activate(); await f.settled();
    const gate = deferred<CloudProject>(); f.upload.mockImplementationOnce(() => gate.promise);
    await f.controller.changed('A', 'local'); await vi.waitFor(() => expect(f.upload).toHaveBeenCalledOnce());
    await f.storage('A').update('local', previous => ({ ...previous!, version: '2', artifact: new Uint8Array([4, 5, 6]), artifactTag: 'snapshot-2' }));
    await f.controller.changed('A', 'local');
    // The server committed our older bytes, but the receipt is still in flight.
    // Reconnect can list that revision before the original upload resolves.
    const receipt = remote({ revision: '2', name: 'Browser local' });
    const listed = kind === 'own receipt' ? receipt : remote({ revision: '3', name: 'Another browser edit' });
    f.remotes.set('A', [listed]); const refresh = f.controller.refresh();
    await vi.waitFor(() => expect(f.controller.current.projects.local?.phase).toBe('conflict'));
    gate.resolve(receipt); await refresh;
    if (kind === 'own receipt') {
      await vi.waitFor(() => expect(f.upload).toHaveBeenCalledTimes(2)); await f.settled();
      expect(f.upload.mock.calls[1]![1]).toMatchObject({ id: REMOTE, baseRevision: '2', bytes: new Uint8Array([4, 5, 6]) });
      expect(f.controller.current.projects.local?.phase).toBe('synced');
    } else {
      await f.settled(); expect(f.upload).toHaveBeenCalledOnce();
      expect(f.controller.current.projects.local?.phase).toBe('conflict');
    }
    const saved = (await f.storage('A').read('local'))!;
    expect(saved.artifact).toEqual(new Uint8Array([4, 5, 6])); expect(saved.artifactTag).toBe('snapshot-2');
    expect(saved.cloud?.conflict).toEqual(kind === 'own receipt' ? undefined : listed);
    expect(saved.cloud?.dirty).toBe(kind !== 'own receipt');
  });

  it('preserves local artifact/base on upload conflict and blocks automatic overwrite', async () => {
    const f = setup(); const base = remote(); const changed = remote({ revision: '2', name: 'Other browser' });
    await f.seed(local('local', { cloud: { remote: base, dirty: true, deleted: false } }));
    f.upload.mockRejectedValueOnce(new CloudProjectError(409, 'project.conflict', 'Changed remotely.', changed));
    f.activate(); await f.settled();
    const saved = (await f.storage('A').read('local'))!;
    expect(saved.artifact).toEqual(new Uint8Array([1, 2, 3])); expect(saved.cloud?.remote).toEqual(base); expect(saved.cloud?.conflict).toEqual(changed);
    expect(f.controller.current.projects.local!.phase).toBe('conflict');
    await f.controller.flush(); await f.controller.refresh();
    expect(f.upload).toHaveBeenCalledOnce();
  });

  it('does not upload an older artifact as the newer Journal when archiving a required output failed', async () => {
    const f = setup();
    const saved = local('local', { version: '2', artifactError: 'An output exceeds the project archive capacity.', cloud: { remote: remote(), dirty: true, deleted: false } });
    await f.seed(saved); f.activate(); await f.settled();
    expect(f.upload).not.toHaveBeenCalled();
    expect(f.controller.current.projects.local).toMatchObject({ phase: 'error', message: expect.stringContaining('Browser Journal saved; cloud upload is paused.') });
    expect(await f.storage('A').read('local')).toEqual(saved);
    await f.controller.flush(); expect(f.upload).not.toHaveBeenCalled();
  });

  it('retains the newer archive failure when an older complete upload finishes meanwhile', async () => {
    const f = setup(); await f.seed(local()); f.activate(); await f.settled();
    const gate = deferred<CloudProject>(); f.upload.mockImplementationOnce(() => gate.promise);
    await f.controller.changed('A', 'local'); await vi.waitFor(() => expect(f.upload).toHaveBeenCalledOnce());
    await f.storage('A').update('local', previous => ({ ...previous!, version: '2', cmds: [{ cmd: 'model.setName', name: 'new Journal' }], artifactError: 'New output archive is full.' }));
    await f.controller.changed('A', 'local'); gate.resolve(remote({ name: 'Browser local' })); await f.settled();
    expect(f.upload).toHaveBeenCalledOnce();
    const saved = (await f.storage('A').read('local'))!;
    expect(saved.artifactError).toBe('New output archive is full.'); expect(saved.cloud?.dirty).toBe(true);
    expect(f.controller.current.projects.local?.phase).toBe('error');
    expect(saved.cmds).toEqual([{ cmd: 'model.setName', name: 'new Journal' }]);
  });

  it('applies a remote tombstone without resurrecting a clean browser project', async () => {
    const f = setup(); const deleted = remote({ revision: '2', bytes: 0, deletedAt: time });
    await f.seed(local('local', { cloud: { remote: remote(), dirty: false, deleted: false } })); f.remotes.set('A', [deleted]);
    f.activate(); await f.settled();
    const saved = (await f.storage('A').read('local'))!;
    expect(saved.meta).toBeNull(); expect(saved.artifact).toBeUndefined(); expect(saved.cloud).toEqual({ remote: deleted, dirty: false, deleted: true });
    expect(f.upload).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
    expect(f.controller.current.projects).toEqual({});
    await f.controller.refresh(); expect(await f.storage('A').read('local')).toEqual(saved);
  });

  it('finishes a first upload then deletes its remote when the browser project was deleted meanwhile', async () => {
    const f = setup(); await f.seed(local()); f.activate(); await f.settled();
    const gate = deferred<CloudProject>(); f.upload.mockImplementationOnce(() => gate.promise);
    await f.controller.changed('A', 'local'); await vi.waitFor(() => expect(f.upload).toHaveBeenCalledOnce());
    await f.storage('A').update('local', previous => ({ ...previous!, meta: null, generation: 'deleted', cloud: { ...previous!.cloud!, dirty: true, deleted: true } }));
    await f.controller.changed('A', 'local'); gate.resolve(remote());
    await vi.waitFor(() => expect(f.remove).toHaveBeenCalledOnce()); await f.settled();
    expect(f.remove.mock.calls[0]!.slice(1)).toEqual([REMOTE, '1', 'generated-2']);
    const saved = (await f.storage('A').read('local'))!;
    expect(saved.meta).toBeNull(); expect(saved.artifact).toBeUndefined(); expect(saved.cloud?.dirty).toBe(false); expect(saved.cloud?.remote?.deletedAt).toBe(time);
    expect(f.upload).toHaveBeenCalledOnce();
  });

  it('fences stale A → B → A replies, storage writes and state publication', async () => {
    const f = setup(); const gate = deferred<Awaited<ReturnType<CloudProjectTransport['list']>>>();
    f.list.mockImplementationOnce(() => gate.promise);
    const states: string[] = []; f.controller.subscribe(state => { states.push(JSON.stringify(state)); });
    f.activate(); await vi.waitFor(() => expect(f.list).toHaveBeenCalledOnce());
    f.activate('B', 2); await f.settled(); f.activate('A', 3); await f.settled();
    const before = f.controller.current; const count = states.length;
    gate.resolve({ projects: [remote({ id: OTHER, name: 'Stale owner A' })], nextCursor: null, storage: { ...quota, usedBytes: 999 } });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.controller.current).toEqual(before); expect(states).toHaveLength(count);
    expect(await f.storage('A').read(`cloud-${OTHER}`)).toBeNull(); expect(await f.storage('B').scan()).toEqual([]);
  });

  it('preserves the open engine document base when a newer remote revision arrives', async () => {
    const f = setup(); const base = remote(); const changed = remote({ revision: '2', name: 'New cloud model' });
    await f.seed(local('local', { cloud: { remote: base, dirty: false, deleted: false } })); f.open.add('A/local'); f.remotes.set('A', [changed]);
    f.activate(); await f.settled();
    const saved = (await f.storage('A').read('local'))!;
    expect(saved.artifactTag).toBe('snapshot-1'); expect(saved.cloud?.remote).toEqual(base); expect(saved.cloud?.conflict).toEqual(changed);
    expect(f.upload).not.toHaveBeenCalled(); expect(f.controller.current.projects.local!.phase).toBe('conflict');
  });

  it('revokes an already captured save when a clean closed project advances remotely', async () => {
    const f = setup(); const original = local('local', { cloud: { remote: remote(), dirty: false, deleted: false } }); await f.seed(original);
    const repo = new ProjectRepository(f.storage('A'), () => 'bound-generation'); const document = snapshot();
    const binding = await repo.claim(original.meta!, document, original);
    const delayed = { ...binding.capture(document, 10), artifact: new Uint8Array([9]), artifactTag: 'delayed old model' };
    const advanced = remote({ revision: '2', name: 'Advanced elsewhere' }); f.remotes.set('A', [advanced]);
    f.activate(); await f.settled(); const before = (await f.storage('A').read('local'))!;
    expect(before.generation).not.toBe(binding.generation); expect(before.cloud?.remote).toEqual(advanced);
    await expect(binding.save(delayed)).rejects.toMatchObject({ code: 'session.conflict' });
    expect(await f.storage('A').read('local')).toEqual(before); expect(before.artifact).toBeUndefined();
  });

  it('revokes a captured save after keeping a conflict copy, preserving both resolved records', async () => {
    const f = setup(); f.offline(); const original = local('local', { cloud: { remote: remote(), dirty: true, deleted: false, conflict: remote({ revision: '2' }) } }); await f.seed(original);
    const repo = new ProjectRepository(f.storage('A'), () => 'bound-generation'); const document = snapshot();
    const binding = await repo.claim(original.meta!, document, original);
    const delayed = { ...binding.capture(document, 10), artifact: new Uint8Array([9]), artifactTag: 'late original' };
    f.activate(); await f.settled(); const copy = await f.controller.keepCopy('local');
    const resolved = (await f.storage('A').read('local'))!;
    expect(resolved.generation).not.toBe(binding.generation);
    await expect(binding.save(delayed)).rejects.toMatchObject({ code: 'session.conflict' });
    expect(await f.storage('A').read('local')).toEqual(resolved); expect(await f.storage('A').read(copy.id)).toEqual(copy);
  });

  it('keeps a rejected pending delete visible with both cloud metadata and its conflict', async () => {
    const f = setup(); const changed = remote({ revision: '2', name: 'Changed before deletion' });
    await f.seed(local('local', { meta: null, cloud: { remote: remote(), dirty: true, deleted: true } }));
    f.remove.mockRejectedValueOnce(new CloudProjectError(409, 'project.conflict', 'Cloud model changed.', changed));
    f.activate(); await f.settled();
    expect(f.controller.current.projects.local).toMatchObject({ phase: 'conflict', deleted: true, name: 'Cloud beam', message: 'Cloud model changed.' });
    const row = (await f.storage('A').read('local'))!;
    expect(row.meta).toBeNull(); expect(row.cloud?.remote?.revision).toBe('1'); expect(row.cloud?.conflict).toEqual(changed);
    await f.controller.flush(); expect(f.remove).toHaveBeenCalledOnce();
  });

  it('durably saves a separate conflict copy before clearing the original cache', async () => {
    const f = setup(); f.offline(); const changed = remote({ revision: '2', name: 'Remote newest' });
    const original = local('local', { cloud: { remote: remote(), dirty: true, deleted: false, conflict: changed } }); await f.seed(original);
    f.activate(); await f.settled();
    const storage = f.storage('A'); const update = storage.update.bind(storage); let copyWritten = false;
    vi.spyOn(storage, 'update').mockImplementation(async (id, change) => {
      if (id === 'local') expect(copyWritten).toBe(true);
      const result = await update(id, change); if (id !== 'local') copyWritten = true; return result;
    });
    const copy = await f.controller.keepCopy('local');
    expect(copy.id).toBe('generated-1'); expect(copy.artifact).toEqual(original.artifact); expect(copy.generation).toBeNull();
    expect(copy.cloud).toEqual({ remote: null, dirty: true, deleted: false }); expect(copy.meta?.name).toBe('Browser local (copy)');
    expect(await storage.read(copy.id)).toEqual(copy);
    const resolved = (await storage.read('local'))!;
    expect(resolved.artifact).toBeUndefined(); expect(resolved.cloud).toEqual({ remote: changed, dirty: false, deleted: false }); expect(resolved.meta?.name).toBe('Remote newest');
  });

  it('keeps the complete original intact if saving a conflict copy fails', async () => {
    const f = setup(); f.offline(); const original = local('local', { cloud: { remote: remote(), dirty: true, deleted: false, conflict: remote({ revision: '2' }) } }); await f.seed(original);
    f.activate(); await f.settled(); const storage = f.storage('A'); const update = storage.update.bind(storage);
    vi.spyOn(storage, 'update').mockImplementation((id, change) => id === 'local' ? update(id, change) : Promise.reject(new Error('Disk full')));
    await expect(f.controller.keepCopy('local')).rejects.toThrow('Disk full');
    expect(await storage.read('local')).toEqual(original);
  });

  it('prepares downloaded bytes privately without replacing cache before engine validation', async () => {
    const f = setup(); const changed = remote({ revision: '2' });
    const original = local('local', { cloud: { remote: remote(), dirty: true, deleted: false, conflict: changed } }); await f.seed(original); f.remotes.set('A', [changed]);
    f.activate(); await f.settled(); const before = await f.storage('A').read('local');
    const candidate = await f.controller.prepareOpen('local', true);
    expect(candidate.record).toEqual(before); expect(candidate.bytes).toEqual(new Uint8Array([8, 8, 8])); expect(candidate.remote).toEqual(changed);
    expect(await f.storage('A').read('local')).toEqual(before);
    const localCandidate = await f.controller.prepareOpen('local'); localCandidate.bytes.fill(99);
    expect((await f.storage('A').read('local'))?.artifact).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('refuses an incomplete newer artifact on normal open, requiring explicit cloud restoration', async () => {
    const f = setup(); const remoteVersion = remote();
    const original = local('local', { artifactError: 'A required output could not be archived.', cloud: { remote: remoteVersion, dirty: true, deleted: false } });
    await f.seed(original); f.remotes.set('A', [remoteVersion]); f.activate(); await f.settled();
    await expect(f.controller.prepareOpen('local')).rejects.toThrow('explicitly choose the cloud version');
    expect(f.download).not.toHaveBeenCalled(); expect(await f.storage('A').read('local')).toEqual(original);
    const candidate = await f.controller.prepareOpen('local', true);
    expect(f.download).toHaveBeenCalledOnce(); expect(candidate.bytes).toEqual(new Uint8Array([8, 8, 8])); expect(candidate.remote).toEqual(remoteVersion);
    expect(await f.storage('A').read('local')).toEqual(original);
  });
});

describe('listed pending commits before receipt replay', () => {
  const pendingRecord = (newer = false): ProjectRecord => local('local', {
    artifact: new Uint8Array(newer ? [9, 8, 7] : [1, 2, 3]),
    artifactTag: newer ? 'snapshot-2' : 'snapshot-1',
    cloud: {
      remote: remote({ name: 'Browser local' }), dirty: true, deleted: false,
      upload: { key: 'recorded-operation', tag: 'snapshot-1', name: 'Browser local', projectId: REMOTE, baseRevision: '1', bytes: new Uint8Array([1, 2, 3]) },
    },
  });

  it('replays a listed own commit before uploading a newer durable local snapshot after reload', async () => {
    const f = setup(); const receipt = remote({ name: 'Browser local', revision: '2' });
    await f.seed(pendingRecord(true)); f.remotes.set('A', [receipt]);
    f.upload.mockImplementationOnce(async () => receipt);
    f.activate();
    await vi.waitFor(async () => expect((await f.storage('A').read('local'))?.cloud).toMatchObject({ remote: { revision: '3' }, dirty: false, upload: undefined, conflict: undefined }));
    expect(f.upload).toHaveBeenCalledTimes(2);
    expect(f.upload.mock.calls[0]![1]).toEqual({ id: REMOTE, name: 'Browser local', baseRevision: '1', key: 'recorded-operation', bytes: new Uint8Array([1, 2, 3]) });
    expect(f.upload.mock.calls[1]![1]).toMatchObject({ id: REMOTE, baseRevision: '2', bytes: new Uint8Array([9, 8, 7]) });
    expect(f.upload.mock.calls[1]![1].key).not.toBe('recorded-operation');
    expect((await f.storage('A').scan()).filter(row => row.meta)).toHaveLength(1);
    expect((await f.storage('A').read('local'))?.artifact).toEqual(new Uint8Array([9, 8, 7]));
  });

  it('resumes the original operation and newer edit when an A→B→A return lists the commit before its old receipt', async () => {
    const f = setup(); const gate = deferred<CloudProject>(); const receipt = remote({ name: 'Browser local', revision: '2' });
    await f.seed(pendingRecord()); f.remotes.set('A', [remote({ name: 'Browser local' })]);
    f.upload.mockImplementationOnce(() => gate.promise); f.activate();
    try {
      await vi.waitFor(() => expect(f.upload).toHaveBeenCalledOnce());
      f.remotes.set('A', [receipt]); f.activate('B', 2); f.activate('A', 3);
      await vi.waitFor(async () => expect((await f.storage('A').read('local'))?.cloud?.conflict?.revision).toBe('2'));
      f.offline();
      await f.storage('A').update('local', previous => ({ ...previous!, artifact: new Uint8Array([9, 8, 7]), artifactTag: 'snapshot-2' }));
      await f.controller.changed('A', 'local');
      f.online(); const refreshing = f.controller.refresh(); gate.resolve(receipt); await refreshing;
      await vi.waitFor(async () => expect((await f.storage('A').read('local'))?.cloud).toMatchObject({ remote: { revision: '3' }, dirty: false, upload: undefined, conflict: undefined }));
      expect(f.upload).toHaveBeenCalledTimes(3);
      expect(f.upload.mock.calls[0]![1]).toEqual(f.upload.mock.calls[1]![1]);
      expect(f.upload.mock.calls[1]![1].key).toBe('recorded-operation');
      expect(f.upload.mock.calls[2]![1]).toMatchObject({ id: REMOTE, baseRevision: '2', bytes: new Uint8Array([9, 8, 7]) });
      expect(f.upload.mock.calls[2]![1].key).not.toBe('recorded-operation');
      expect(await f.storage('B').scan()).toEqual([]);
      expect((await f.storage('A').scan()).filter(row => row.meta)).toHaveLength(1);
      expect(f.controller.current.uid).toBe('A');
    } finally { gate.resolve(receipt); }
  });

  it('keeps a genuinely newer listed remote revision in conflict after replaying the exact older receipt', async () => {
    const f = setup(); const receipt = remote({ name: 'Browser local', revision: '2' }); const later = remote({ name: 'Browser local', revision: '3' });
    const saved = pendingRecord(true); await f.seed(saved); f.remotes.set('A', [later]);
    f.upload.mockImplementationOnce(async () => receipt); f.activate();
    await vi.waitFor(() => expect(f.upload).toHaveBeenCalledOnce()); await f.settled();
    expect((await f.storage('A').read('local'))?.cloud).toMatchObject({ remote: receipt, conflict: later, dirty: true, upload: undefined });
    expect((await f.storage('A').read('local'))?.artifact).toEqual(saved.artifact);
    expect(f.remotes.get('A')).toEqual([later]); expect(f.controller.current.projects.local?.phase).toBe('conflict');
    await f.controller.flush(); expect(f.upload).toHaveBeenCalledOnce();
    expect(f.upload.mock.calls[0]![1].key).toBe('recorded-operation');
  });

  it('joins one atomically reserved operation when two controllers find the same unsynced project', async () => {
    const f = setup(); const second = new ProjectSync(f.env); controllers.push(second);
    const gate = deferred<CloudProject>(); const receipt = remote({ name: 'Browser local' });
    await f.seed(local('local', { cloud: { remote: null, dirty: true, deleted: false } }));
    f.upload.mockImplementation(() => gate.promise); f.activate(); f.activate('A', 1, second);
    try {
      await vi.waitFor(() => expect(f.upload).toHaveBeenCalledTimes(2));
      expect(f.upload.mock.calls[0]![1]).toEqual(f.upload.mock.calls[1]![1]);
      expect((await f.storage('A').read('local'))?.cloud?.upload?.key).toBe(f.upload.mock.calls[0]![1].key);
      f.remotes.set('A', [receipt]); gate.resolve(receipt);
      await vi.waitFor(async () => expect((await f.storage('A').read('local'))?.cloud).toMatchObject({ remote: receipt, dirty: false, upload: undefined }));
      expect((await f.storage('A').scan()).filter(row => row.meta)).toHaveLength(1);
    } finally { gate.resolve(receipt); }
  });

  it('does not reserve a new operation if a conflict arrives between reading and reserving the snapshot', async () => {
    const f = setup(); const base = remote(); const changed = remote({ revision: '2', name: 'Another browser' });
    const storage = f.storage('A'); let inject = true;
    f.env.storage = owner => owner === 'A' ? {
      ...storage,
      read: async id => {
        const stale = await storage.read(id);
        if (inject) {
          inject = false;
          await storage.update(id, previous => ({ ...previous!, cloud: { ...previous!.cloud!, conflict: changed } }));
          f.remotes.set('A', [changed]);
        }
        return stale;
      },
    } : f.storage(owner);
    await f.seed(local('local', { cloud: { remote: base, dirty: true, deleted: false } })); f.remotes.set('A', [base]);
    f.upload.mockRejectedValue(new CloudProjectError(409, 'project.conflict', 'Changed remotely.', changed));
    f.activate(); await f.settled();
    expect(f.upload).not.toHaveBeenCalled();
    expect((await storage.read('local'))?.cloud).toEqual({ remote: base, dirty: true, deleted: false, conflict: changed });
    expect((await storage.read('local'))?.artifact).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('preserves a concurrent pending operation when local activation supplies no cloud replacement', async () => {
    const f = setup(); const original = local('local', { cloud: { remote: remote(), dirty: true, deleted: false } });
    await f.seed(original); const expected = (await f.storage('A').read('local'))!;
    const pending = { ...original.cloud!, upload: pendingRecord().cloud!.upload };
    await f.storage('A').update('local', previous => ({ ...previous!, cloud: pending }));
    const repo = new ProjectRepository(f.storage('A'), () => 'opened-generation');
    await repo.claim(original.meta!, snapshot(), expected, { artifact: original.artifact, artifactTag: original.artifactTag, cloud: undefined });
    expect((await f.storage('A').read('local'))?.cloud).toEqual(pending);
    expect((await f.storage('A').read('local'))?.cloud?.upload?.key).toBe('recorded-operation');
  });
});

describe('late failures after an explicit cloud choice', () => {
  it('does not reopen a resolved conflict when the replaced upload is rejected later', async () => {
    const f = setup(); const gate = deferred<void>();
    const base = remote(); const chosen = remote({ revision: '2', name: 'Chosen cloud version' });
    await f.seed(local('local', { cloud: { remote: base, dirty: true, deleted: false } }));
    f.remotes.set('A', [base]); f.open.add('A/local');
    f.upload.mockImplementationOnce(async () => {
      await gate.promise;
      throw new CloudProjectError(409, 'project.conflict', 'The older upload lost its revision.', chosen);
    });
    f.activate();
    try {
      await vi.waitFor(() => expect(f.upload).toHaveBeenCalledOnce());
      f.remotes.set('A', [chosen]); const refreshing = f.controller.refresh();
      await vi.waitFor(() => expect(f.controller.current.projects.local?.phase).toBe('conflict'));
      const prepared = await f.controller.prepareOpen('local', true);
      expect(prepared.remote).toEqual(chosen);
      const repository = new ProjectRepository(f.storage('A'), () => 'explicit-cloud-choice');
      await repository.claim(prepared.record.meta!, snapshot(), prepared.record, {
        artifact: prepared.bytes, artifactTag: 'chosen-cloud-artifact',
        cloud: { remote: chosen, dirty: false, deleted: false }, restoreDeleted: true,
      });
      const resolved = (await f.storage('A').read('local'))!;
      expect(resolved.cloud).toEqual({ remote: chosen, dirty: false, deleted: false });
      gate.resolve(undefined); await refreshing; await f.settled();
      expect(await f.storage('A').read('local')).toEqual(resolved);
      expect(f.controller.current.projects.local?.phase).toBe('synced');
      expect(f.upload).toHaveBeenCalledOnce();
      expect(await f.storage('B').scan()).toEqual([]);
    } finally { gate.resolve(undefined); }
  });
});

describe('late shared sync outcomes after restoration', () => {
  async function choose(f:ReturnType<typeof setup>, chosen:CloudProject):Promise<ProjectRecord> {
    const prepared=await f.controller.prepareOpen('local',true);
    expect(prepared.remote).toEqual(chosen);
    const project=prepared.record.meta??{...meta('local'),name:chosen.name};
    await new ProjectRepository(f.storage('A'),()=> 'chosen-generation').claim(project,snapshot(),prepared.record,{
      artifact:prepared.bytes,artifactTag:'chosen-artifact',cloud:{remote:chosen,dirty:false,deleted:false},restoreDeleted:true,
    });
    return (await f.storage('A').read('local'))!;
  }
  it('does not publish an obsolete offline failure over a clean chosen cloud version',async()=>{
    const f=setup(),gate=deferred<void>(),base=remote(),chosen=remote({revision:'2'});
    await f.seed(local('local',{cloud:{remote:base,dirty:true,deleted:false}}));f.remotes.set('A',[base]);
    f.upload.mockImplementationOnce(async()=>{await gate.promise;throw new CloudProjectError(0,'project.offline','Old request lost its connection.');});
    f.activate();
    try{
      await vi.waitFor(()=>expect(f.upload).toHaveBeenCalledOnce());f.remotes.set('A',[chosen]);const refresh=f.controller.refresh();
      await vi.waitFor(()=>expect(f.controller.current.projects.local?.phase).toBe('conflict'));
      const saved=await choose(f,chosen);gate.resolve(undefined);await refresh;await f.settled();
      expect(await f.storage('A').read('local')).toEqual(saved);expect(f.controller.current.projects.local?.phase).toBe('synced');
    }finally{gate.resolve(undefined);}
  });
  it('does not reopen a cloud choice when the replaced deletion is rejected later',async()=>{
    const f=setup(),gate=deferred<void>(),base=remote(),chosen=remote({revision:'2'});
    await f.seed(local('local',{meta:null,cloud:{remote:base,dirty:true,deleted:true}}));f.remotes.set('A',[base]);
    f.remove.mockImplementationOnce(async()=>{await gate.promise;throw new CloudProjectError(409,'project.conflict','Old delete lost its revision.',chosen);});
    f.activate();
    try{
      await vi.waitFor(()=>expect(f.remove).toHaveBeenCalledOnce());f.remotes.set('A',[chosen]);const refresh=f.controller.refresh();
      await vi.waitFor(()=>expect(f.controller.current.projects.local?.phase).toBe('conflict'));
      const saved=await choose(f,chosen);gate.resolve(undefined);await refresh;await f.settled();
      expect(await f.storage('A').read('local')).toEqual(saved);expect(f.controller.current.projects.local?.phase).toBe('synced');
      expect(f.upload).not.toHaveBeenCalled();
    }finally{gate.resolve(undefined);}
  });
  it('preserves a restored artifact as a conflict when its older deletion actually completes',async()=>{
    const f=setup(),gate=deferred<CloudProject>(),base=remote(),deleted=remote({revision:'2',deletedAt:time,bytes:0});
    await f.seed(local('local',{meta:null,cloud:{remote:base,dirty:true,deleted:true}}));f.remotes.set('A',[base]);
    f.remove.mockImplementationOnce(()=>gate.promise);f.activate();
    try{
      await vi.waitFor(()=>expect(f.remove).toHaveBeenCalledOnce());
      const saved=await choose(f,base);f.remotes.set('A',[deleted]);gate.resolve(deleted);await f.settled();
      expect(await f.storage('A').read('local')).toEqual({...saved,cloud:{...saved.cloud!,conflict:deleted}});
      expect(f.controller.current.projects.local).toMatchObject({phase:'conflict',remoteDeleted:true,deleted:false});
      expect(f.upload).not.toHaveBeenCalled();expect(f.remove).toHaveBeenCalledOnce();
    }finally{gate.resolve(deleted);}
  });
  it('keeps a newer listed conflict when an earlier rejection describes an older revision',async()=>{
    const f=setup(),gate=deferred<void>(),base=remote(),rejected=remote({revision:'2'}),latest=remote({revision:'3'});
    await f.seed(local('local',{cloud:{remote:base,dirty:true,deleted:false}}));f.remotes.set('A',[base]);
    f.upload.mockImplementationOnce(async()=>{await gate.promise;throw new CloudProjectError(409,'project.conflict','Earlier rejected revision.',rejected);});
    f.activate();
    try{
      await vi.waitFor(()=>expect(f.upload).toHaveBeenCalledOnce());f.remotes.set('A',[latest]);const refresh=f.controller.refresh();
      await vi.waitFor(()=>expect(f.controller.current.projects.local?.phase).toBe('conflict'));
      gate.resolve(undefined);await refresh;await f.settled();
      expect((await f.storage('A').read('local'))?.cloud).toMatchObject({remote:base,conflict:latest,dirty:true});
      expect((await f.storage('A').read('local'))?.artifact).toEqual(new Uint8Array([1,2,3]));
      await f.controller.flush();expect(f.upload).toHaveBeenCalledOnce();
    }finally{gate.resolve(undefined);}
  });
  it('does not start an obsolete deletion when restoration finishes before reservation',async()=>{
    const f=setup(),base=remote(),storage=f.storage('A');let inject=true;let saved:ProjectRecord|undefined;
    await f.seed(local('local',{meta:null,cloud:{remote:base,dirty:true,deleted:true}}));f.remotes.set('A',[base]);
    f.env.storage=owner=>owner==='A'?{...storage,read:async id=>{
      const stale=await storage.read(id);
      if(inject){
        inject=false;
        await new ProjectRepository(storage,()=> 'restored-before-reservation').claim(meta('local'),snapshot(),stale,{
          artifact:new Uint8Array([8,8,8]),artifactTag:'chosen-before-delete',cloud:{remote:base,dirty:false,deleted:false},restoreDeleted:true,
        });
        saved=(await storage.read(id))!;
      }
      return stale;
    }}:f.storage(owner);
    f.activate();await f.settled();
    expect(f.remove).not.toHaveBeenCalled();expect(await storage.read('local')).toEqual(saved);
    expect(f.controller.current.projects.local?.phase).toBe('synced');
  });
});
