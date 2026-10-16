import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_CHUNK_BYTES, type CloudProject, type CloudStorageStatus, type ProjectMeta } from '@femlab/registry';
import { CloudProjectError, type CloudActor } from '../src/cloud-project-api';
import { memoryAtomicProjects, type AtomicProjects, type ProjectRecord } from '../src/project-repository';
import { partitionedAtomicProjects } from '../src/project-partitions';
import { ProjectSync, type CloudProjectTransport, type ProjectSyncEnvironment } from '../src/project-sync';

const REMOTE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const time = '2026-10-16T12:00:00Z';
const remote = (patch: Partial<CloudProject> = {}): CloudProject => ({ id: REMOTE, name: 'Cloud beam', bytes: 3, revision: '1', changeVersion: '1', updatedAt: time, deletedAt: null, ...patch });
const quota: CloudStorageStatus = { available: true, plan: 'plus', limitBytes: 2_000_000_000, usedBytes: 7, reservedBytes: 5, pendingBytes: 3, overQuota: false, maxChunkBytes: PROJECT_CHUNK_BYTES };
const meta = (id: string): ProjectMeta => ({ id, name: `Browser ${id}`, at: 1, createdAt: 0, commands: 1, hash: 'hash', thumbnail: null });
const local = (id = 'local', patch: Partial<ProjectRecord> = {}): ProjectRecord => ({ id, generation: 'generation', version: '1', meta: meta(id), cmds: [{ cmd: 'model.setName', name: 'beam' }], artifact: new Uint8Array([1, 2, 3]), artifactTag: 'snapshot-1', ...patch });
const controllers: ProjectSync[] = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.activate(null); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
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
  it('merges another browser’s remote projects and authoritative quota without importing anonymous rows', async () => {
    const f = setup(); await f.seed(local('anonymous'), null); f.remotes.set('A', [remote()]);
    f.activate(); await f.settled();
    const id = `cloud-${REMOTE}`;
    expect((await f.storage('A').read(id))?.cloud?.remote).toEqual(remote());
    expect(f.controller.current.projects).toEqual({ [id]: { phase: 'remote', message: null } });
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
});
