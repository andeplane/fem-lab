import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import type { ProjectMeta } from '@femlab/registry';
import { indexedDbAtomicProjects, memoryAtomicProjects, ProjectRepository, type AtomicProjects, type ProjectRecord } from '../src/project-repository';
import { partitionedAtomicProjects } from '../src/project-partitions';

const meta = (id: string, name = id): ProjectMeta => ({ id, name, at: 1, createdAt: 0, commands: 1, hash: 'hash', thumbnail: null });
const row = (id: string, name = id): ProjectRecord => ({ id, meta: meta(id, name), generation: 'generation', version: '12345678901234567890', cmds: [{ cmd: 'model.setName', name }] });

for (const backend of ['memory', 'indexeddb'] as const) describe(`immutable account project partitions (${backend})`, () => {
  const setup = () => {
    const base = backend === 'memory' ? memoryAtomicProjects() : indexedDbAtomicProjects(new IDBFactory());
    return { base, anonymous: partitionedAtomicProjects(base, null), a: partitionedAtomicProjects(base, 'owner-a'), b: partitionedAtomicProjects(base, 'owner-b') };
  };

  it('preserves anonymous legacy bytes and independent identical logical IDs for each owner', async () => {
    const { base, anonymous, a, b } = setup();
    const legacy = row('same', 'anonymous');
    await base.update('same', () => legacy);
    expect(await anonymous.read('same')).toEqual(legacy);
    expect(await a.read('same')).toBeNull();
    expect(await b.list()).toEqual([]);
    await a.update('same', () => row('same', 'A'));
    await b.update('same', () => row('same', 'B'));
    expect(await anonymous.list()).toEqual([legacy.meta]);
    expect(await a.list()).toEqual([meta('same', 'A')]);
    expect(await b.list()).toEqual([meta('same', 'B')]);
    expect(await base.read('same')).toEqual(legacy);
    expect(await a.read('same')).toEqual(row('same', 'A'));
    expect(await b.read('same')).toEqual(row('same', 'B'));
    expect(await partitionedAtomicProjects(base, 'owner-a').read('same')).toEqual(row('same', 'A'));
    const exposed = (await a.read('same'))!;
    exposed.meta!.name = 'mutated'; exposed.cmds.length = 0;
    expect(await a.read('same')).toEqual(row('same', 'A'));
  });

  it('blocks physical-key guessing for reads, updates, renames and deletes in every partition', async () => {
    const { base, anonymous, a, b } = setup();
    await a.update('secret', () => row('secret'));
    const physical = (await base.list())[0]!.id;
    for (const partition of [anonymous, a, b]) {
      expect(await partition.read('secret')).toEqual(partition === a ? row('secret') : null);
      await expect(partition.read(physical)).rejects.toMatchObject({ code: 'schema' });
      let invoked = false;
      await expect(partition.update(physical, () => { invoked = true; return row(physical); })).rejects.toMatchObject({ code: 'schema' });
      expect(invoked).toBe(false);
      const repo = new ProjectRepository(partition, () => 'new-generation');
      await expect(repo.rename(physical, 'stolen')).rejects.toMatchObject({ code: 'schema' });
      await expect(repo.delete(physical)).rejects.toMatchObject({ code: 'schema' });
    }
    expect(await a.read('secret')).toEqual(row('secret'));
  });

  it('encodes delimiter, quote, Unicode and owner-shaped IDs without collisions', async () => {
    const { base } = setup();
    const cases = [['a', 'b","c'], ['a","b', 'c'], ['å/😀', 'a\u0000/b%2F["owner"]'], ['', '']] as const;
    for (const [owner, id] of cases) await partitionedAtomicProjects(base, owner).update(id, () => row(id, owner));
    expect(await base.list()).toHaveLength(cases.length);
    for (const [owner, id] of cases) {
      const partition = partitionedAtomicProjects(base, owner);
      expect(await partition.list()).toEqual([meta(id, owner)]);
      expect(await partition.read(id)).toEqual(row(id, owner));
    }
  });

  it('keeps comparisons and tombstone revocation inside the original transaction', async () => {
    const { a, b, anonymous } = setup();
    await a.update('same', () => row('same', 'A'));
    await b.update('same', () => row('same', 'B'));
    const captured = (await a.read('same'))!;
    const repo = new ProjectRepository(a, () => 'deleted-generation');
    await repo.delete('same');
    const tombstone = await a.read('same');
    expect(tombstone).toEqual({ ...captured, generation: 'deleted-generation', meta: null, cmds: [] });
    expect(await a.list()).toEqual([]);
    await expect(repo.save({ id: 'same', generation: captured.generation!, version: captured.version, meta: captured.meta!, cmds: captured.cmds, journal: { entries: [] } } as Parameters<ProjectRepository['save']>[0])).rejects.toMatchObject({ code: 'session.conflict' });
    expect(await a.read('same')).toEqual(tombstone);
    expect(await b.read('same')).toEqual(row('same', 'B'));
    expect(await anonymous.read('same')).toBeNull();
  });

  it('rejects callback identity injection and leaves the current row intact on failure', async () => {
    const { a } = setup();
    await a.update('safe', () => row('safe'));
    for (const changed of [row('other'), { ...row('safe'), meta: meta('other') }]) {
      await expect(a.update('safe', () => changed)).rejects.toMatchObject({ code: 'schema' });
      expect(await a.read('safe')).toEqual(row('safe'));
      expect(await a.read('other')).toBeNull();
    }
    await expect(a.update('safe', previous => { previous!.meta!.name = 'not committed'; throw new Error('comparison failed'); })).rejects.toThrow('comparison failed');
    expect(await a.read('safe')).toEqual(row('safe'));
  });

  it('retains exact versions and generation checks for delayed repository saves', async () => {
    const { a, b } = setup();
    const original = row('same', 'A');
    await a.update('same', () => original);
    await b.update('same', () => row('same', 'B'));
    const repo = new ProjectRepository(a, () => 'unused');
    const job = { id: original.id, generation: original.generation!, version: original.version, meta: original.meta!, cmds: original.cmds, journal: { entries: [] } } as Parameters<ProjectRepository['save']>[0];
    const newer = { ...original, version: '12345678901234567891' };
    await a.update('same', previous => {
      expect(previous).toEqual(original);
      return newer;
    });
    await expect(repo.save(job)).rejects.toMatchObject({ code: 'session.conflict' });
    expect(await a.read('same')).toEqual(newer);
    const reclaimed = { ...original, generation: 'different-generation' };
    await a.update('same', () => reclaimed);
    await expect(repo.save(job)).rejects.toMatchObject({ code: 'session.conflict' });
    expect(await a.read('same')).toEqual(reclaimed);
    expect(await b.read('same')).toEqual(row('same', 'B'));
  });

  it('captures owner before a delayed write and does not reroute after switching accounts', async () => {
    const { base } = setup();
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const delayed: AtomicProjects = { list: () => base.list(), read: id => base.read(id), update: async (id, change) => { await gate; return base.update(id, change); } };
    let current = partitionedAtomicProjects(delayed, 'A');
    const pending = current.update('late', () => row('late', 'A'));
    current = partitionedAtomicProjects(base, 'B');
    await current.update('late', () => row('late', 'B'));
    resume(); await pending;
    expect(await current.read('late')).toEqual(row('late', 'B'));
    expect(await partitionedAtomicProjects(base, 'A').read('late')).toEqual(row('late', 'A'));
    expect(await partitionedAtomicProjects(base, null).list()).toEqual([]);
  });

  it('hides malformed, foreign and noncanonical physical namespace rows', async () => {
    const { base, anonymous, a } = setup();
    await a.update('known', () => row('known'));
    const physical = (await base.list())[0]!.id;
    const prefix = physical.slice(0, physical.indexOf('['));
    for (const key of [prefix + 'invalid', prefix + '["owner-a", "space"]', prefix + '["owner-a",5]', prefix + '["owner-a","id","extra"]', prefix + '["other","foreign"]', prefix + JSON.stringify(['owner-a', physical])]) await base.update(key, () => row(key));
    expect(await a.list()).toEqual([meta('known')]);
    expect(await anonymous.list()).toEqual([]);
  });
});
