import { createRequire } from 'node:module';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import type { Command, DocumentSnapshot, ProjectMeta, RunLease, WriteReply } from '@femlab/registry';
import { indexedDbAtomicProjects, memoryAtomicProjects, ProjectRepository } from '../src/project-repository';
const { SessionEngine } = createRequire(import.meta.url)('../../../tools/wasm-node/femlab_engine_wasm.js') as typeof import('../src/generated/wasm/femlab_engine_wasm');
const meta = (id: string): ProjectMeta => ({ id, name: id, at: 0, createdAt: 0, commands: 0, hash: null, thumbnail: null });
function document(epoch = 'test') {
  const owner = new SessionEngine(1, epoch);
  let lease = JSON.parse(owner.begin_run(JSON.stringify(JSON.parse(owner.stamp()).session))) as RunLease;
  let operation = 0;
  const context = () => ({ session: lease.stamp.session, runId: lease.runId, operationId: String(++operation) });
  return {
    async write(command: Command) { const reply = JSON.parse(await owner.dispatch(JSON.stringify({ context: context(), expectedVersion: lease.stamp.stateVersion, command }), undefined)) as WriteReply; lease = { ...lease, stamp: reply.stamp }; },
    snapshot: () => JSON.parse(owner.snapshot(JSON.stringify(context()))) as DocumentSnapshot,
    close: () => owner.free(),
  };
}
for (const backend of ['memory', 'indexeddb'] as const) describe(`project ownership (${backend})`, () => {
  function setup() {
    let generation = 0;
    const storage = backend === 'memory' ? memoryAtomicProjects() : indexedDbAtomicProjects(new IDBFactory());
    return { storage, repo: new ProjectRepository(storage, () => String(++generation)) };
  }
  it('rejects an out-of-order save without changing durable bytes', async () => {
    const { repo } = setup(); const doc = document();
    const first = doc.snapshot();
    const binding = await repo.claim(meta('a'), first, null);
    const older = binding.capture(first, 1);
    await doc.write({ cmd: 'geometry.addBox', name: 'shared', size: ['1 m', '1 m', '1 m'] });
    const newer = binding.capture(doc.snapshot(), 2);
    await binding.save(newer);
    const before = await repo.read('a');
    await expect(binding.save(older)).rejects.toMatchObject({ code: 'session.conflict' });
    expect(await repo.read('a')).toEqual(before);
    expect(before.cmds).toHaveLength(1);
    doc.close();
  });
  it('rejects a delayed equal-engine-version save after a newer complete project snapshot', async () => {
    const { repo, storage } = setup(); const doc = document();
    const binding = await repo.claim(meta('same-version'), doc.snapshot(), null);
    const older = { ...binding.capture(doc.snapshot(), 1), artifact: new Uint8Array([1]), artifactTag: 'old files' };
    const newer = { ...binding.capture(doc.snapshot(), 2), artifact: new Uint8Array([2, 3]), artifactTag: 'new files' };
    expect(older.version).toBe(newer.version); expect(newer.sequence).toBeGreaterThan(older.sequence);
    await binding.save(newer); const before = await storage.read('same-version');
    await expect(binding.save(older)).rejects.toMatchObject({ code: 'session.conflict' });
    expect(await storage.read('same-version')).toEqual(before);
    expect(before?.artifact).toEqual(new Uint8Array([2, 3])); expect(before?.saveSequence).toBe(newer.sequence);
    doc.close();
  });
  it('acknowledges an identical older capture without reverting newer metadata, sequence or clean sync status', async () => {
    const { repo, storage } = setup(); const doc = document();
    try {
      const binding = await repo.claim(meta('identical'), doc.snapshot(), null);
      const older = { ...binding.capture(doc.snapshot(), 1, 'same thumbnail'), artifact: new Uint8Array([1, 2, 3]), artifactTag: 'stable content digest' };
      const newer = { ...binding.capture(doc.snapshot(), 2, 'same thumbnail'), artifact: new Uint8Array([1, 2, 3]), artifactTag: 'stable content digest' };
      await binding.save(newer);
      await storage.update('identical', previous => ({ ...previous!, meta: { ...previous!.meta!, name: 'newer metadata', at: 99 }, cloud: { remote: null, dirty: false, deleted: false } }));
      const before = (await storage.read('identical'))!;
      expect(newer.sequence).toBeGreaterThan(older.sequence);
      expect(await binding.save(older)).toEqual(before.meta);
      expect(await storage.read('identical')).toEqual(before);
      expect(before.saveSequence).toBe(newer.sequence); expect(before.cloud?.dirty).toBe(false);
      await expect(binding.save({ ...older, meta: { ...older.meta, thumbnail: 'different old image' } })).rejects.toMatchObject({ code: 'session.conflict' });
      await expect(binding.save({ ...older, artifactError: 'older incomplete archive' })).rejects.toMatchObject({ code: 'session.conflict' });
      expect(await storage.read('identical')).toEqual(before);
    } finally { doc.close(); }
  });
  it('requires an explicit, current tombstone restoration and fences its previous save binding', async () => {
    const { repo, storage } = setup(); const doc = document();
    const old = await repo.claim(meta('deleted'), doc.snapshot(), null); const delayed = old.capture(doc.snapshot(), 1);
    await repo.delete('deleted'); const tombstone = (await storage.read('deleted'))!;
    await expect(repo.claim(meta('deleted'), doc.snapshot(), tombstone)).rejects.toMatchObject({ code: 'session.conflict' });
    await expect(repo.claim(meta('deleted'), doc.snapshot(), null, { restoreDeleted: true })).rejects.toMatchObject({ code: 'session.conflict' });
    await expect(repo.claim(meta('deleted'), doc.snapshot(), { ...tombstone, generation: 'stale' }, { restoreDeleted: true })).rejects.toMatchObject({ code: 'session.conflict' });
    expect(await storage.read('deleted')).toEqual(tombstone);
    const restored = await repo.claim(meta('deleted'), doc.snapshot(), tombstone, { restoreDeleted: true, artifact: new Uint8Array([7]), artifactTag: 'restored' });
    expect(restored.generation).not.toBe(old.generation);
    const before = await repo.read('deleted');
    await expect(old.save(delayed)).rejects.toMatchObject({ code: 'session.conflict' });
    expect(await repo.read('deleted')).toEqual(before); expect(before.artifact).toEqual(new Uint8Array([7]));
    doc.close();
  });
  it('saves the newer Journal with a durable archive error while retaining the previous complete artifact', async () => {
    const { repo, storage } = setup(); const doc = document();
    try {
      const original = new Uint8Array([1, 2, 3]);
      const binding = await repo.claim(meta('archive-error'), doc.snapshot(), null, { artifact: original, artifactTag: 'complete-1' });
      await doc.write({ cmd: 'model.setName', name: 'new Journal despite output capacity' });
      const failed = { ...binding.capture(doc.snapshot(), 1), artifactError: 'The output archive exceeds 128 MiB.' };
      await binding.save(failed);
      const saved = (await storage.read('archive-error'))!;
      expect(saved.version).toBe(failed.version); expect(saved.cmds).toEqual(failed.cmds); expect(saved.cmds).toHaveLength(1);
      expect(saved.artifact).toEqual(original); expect(saved.artifactTag).toBe('complete-1'); expect(saved.artifactError).toBe(failed.artifactError);
      expect((await storage.scan())[0]!.artifactError).toBe(failed.artifactError);
      const complete = { ...binding.capture(doc.snapshot(), 2), artifact: new Uint8Array([4, 5, 6, 7]), artifactTag: 'complete-2' };
      await binding.save(complete);
      const recovered = (await storage.read('archive-error'))!;
      expect(recovered.artifact).toEqual(complete.artifact); expect(recovered.artifactTag).toBe('complete-2'); expect(recovered.artifactError).toBeUndefined();
      expect(recovered.cmds).toEqual(failed.cmds);
      await expect(binding.save(failed)).rejects.toMatchObject({ code: 'session.conflict' });
      expect(await storage.read('archive-error')).toEqual(recovered);
    } finally { doc.close(); }
  });
  it('revokes delayed saves across same-content reopen and deletion, retaining tombstones', async () => {
    const { repo, storage } = setup(); const a = document('a'); const b = document('b');
    const old = await repo.claim(meta('same'), a.snapshot(), null);
    const job = old.capture(a.snapshot(), 1);
    const expected = await repo.read('same');
    const next = await repo.claim(meta('same'), b.snapshot(), expected);
    expect(next.generation).not.toBe(old.generation);
    await expect(old.save(job)).rejects.toMatchObject({ code: 'session.conflict' });
    expect(() => old.capture(b.snapshot(), 2)).toThrow();
    const late = next.capture(b.snapshot(), 3);
    await repo.delete('same');
    const tombstone = await storage.read('same');
    await expect(next.save(late)).rejects.toMatchObject({ code: 'session.conflict' });
    await expect(repo.claim(meta('same'), b.snapshot(), null)).rejects.toMatchObject({ code: 'session.conflict' });
    expect(await repo.list()).toEqual([]);
    expect(await storage.read('same')).toEqual(tombstone);
    expect(tombstone?.meta).toBeNull();
    a.close(); b.close();
  });
  it('restores the previous save owner when an unpublished activation is abandoned', async () => {
    const { repo } = setup(); const a = document('a'); const b = document('b');
    const original = await repo.claim(meta('a'), a.snapshot(), null);
    const before = await repo.read('a');
    const candidate = await repo.claim(meta('a'), b.snapshot(), before);
    await candidate.abandon();
    expect(await repo.read('a')).toEqual(before);
    await original.save(original.capture(a.snapshot(), 5));
    await expect(candidate.save(candidate.capture(b.snapshot(), 6))).rejects.toMatchObject({ code: 'session.conflict' });
    const newProject = await repo.claim(meta('new'), b.snapshot(), null);
    await newProject.abandon();
    expect((await repo.list()).map(row => row.id)).toEqual(['a']);
    const replacing = await repo.claim(meta('a'), b.snapshot(), await repo.read('a'));
    await repo.delete('a');
    await expect(replacing.abandon()).rejects.toMatchObject({ code: 'session.conflict' });
    expect(await repo.list()).toEqual([]);
    a.close(); b.close();
  });
  it('captures immutable input and destination before any asynchronous save work', async () => {
    const { repo } = setup(); const a = document('a'); const b = document('b');
    const snapshot = a.snapshot();
    const binding = await repo.claim(meta('a'), snapshot, null);
    const job = binding.capture(snapshot, 1);
    snapshot.file.model.name = 'mutated after capture';
    await repo.claim(meta('b'), b.snapshot(), null);
    await binding.save(job);
    expect((await repo.read('a')).meta?.name).toBe('a');
    expect((await repo.read('b')).meta?.name).toBe('b');
    expect((await repo.read('a')).generation).toBe(binding.generation);
    a.close(); b.close();
  });
  it('compares the saved content when claiming an activation and accepts equal-version metadata updates', async () => {
    const { repo } = setup(); const a = document();
    const binding = await repo.claim(meta('a'), a.snapshot(), null);
    const stale = await repo.read('a');
    await a.write({ cmd: 'model.setName', name: 'new name' });
    const job = binding.capture(a.snapshot(), 10, 'thumbnail');
    await binding.save(job);
    const unchanged = await repo.read('a');
    await binding.save(binding.capture(a.snapshot(), 11, 'thumbnail'));
    expect(await repo.read('a')).toEqual(unchanged);
    await expect(repo.claim(meta('a'), a.snapshot(), stale)).rejects.toMatchObject({ code: 'session.conflict' });
    await binding.save(binding.capture(a.snapshot(), 11, 'better thumbnail'));
    expect((await repo.read('a')).meta?.thumbnail).toBe('better thumbnail');
    const corrupt = { ...job, cmds: [] };
    await expect(binding.save(corrupt)).rejects.toMatchObject({ code: 'session.conflict' });
    a.close();
  });
});
