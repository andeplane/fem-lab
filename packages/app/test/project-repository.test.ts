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
    await expect(repo.claim(meta('a'), a.snapshot(), stale)).rejects.toMatchObject({ code: 'session.conflict' });
    await binding.save(binding.capture(a.snapshot(), 11, 'better thumbnail'));
    expect((await repo.read('a')).meta?.thumbnail).toBe('better thumbnail');
    const corrupt = { ...job, cmds: [] };
    await expect(binding.save(corrupt)).rejects.toMatchObject({ code: 'session.conflict' });
    a.close();
  });
});
