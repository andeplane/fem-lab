// Projects (issue #41), against the real `openDb`, the real stores and the real migration —
// `fake-indexeddb` is a full implementation of the spec, so the version-1 → version-2 upgrade is
// exercised here rather than stood in for by a hand-rolled fake (AGENTS: ponytail applies to
// code, never to verification).
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DB_NAME, HANDLES, JOURNALS, PROJECTS, openDb, tx, type ProjectMeta } from '../src/db';
import { indexedDbProjects, makeProjects, memoryProjects, type ProjectStore, type ProjectsOptions } from '../src/projects';
import { forgetHandle, recallHandle, rememberHandle, type DirHandle } from '../src/ai/project';
import type { ShareCommand } from '../src/share';

const CMDS: ShareCommand[] = [
  { cmd: 'model.new', name: 'beam' },
  { cmd: 'geometry.addBox', name: 'beam', size: ['1 m', '100 mm', '100 mm'] },
];

let factory: IDBFactory;
beforeEach(() => {
  factory = new IDBFactory();
});

/** A version-1 database exactly as `share.ts` used to write it: one `autosave` store, one slot. */
function legacyDb(slot?: { name: string; at: number; cmds: ShareCommand[] }): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('autosave');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      if (!slot) {
        db.close();
        return resolve();
      }
      const t = db.transaction('autosave', 'readwrite');
      t.objectStore('autosave').put(slot, 'last');
      t.oncomplete = () => {
        db.close();
        resolve();
      };
      t.onerror = () => reject(t.error);
    };
  });
}

const stores = (db: IDBDatabase): string[] => [...db.objectStoreNames].sort();

describe('the femlab database', () => {
  it('creates its three stores on a browser that has never seen FEM Lab', async () => {
    const db = await openDb(factory);
    expect(stores(db)).toEqual([HANDLES, JOURNALS, PROJECTS]);
    expect(db.version).toBe(2);
    db.close();
  });

  // The regression guard for the bug in the header of `src/db.ts`: two modules used to open
  // `femlab` at version 1 with different stores, and the loser's transaction raised NotFoundError.
  it('round-trips a directory handle through the same database the projects live in', async () => {
    const handle = { kind: 'directory', name: 'corbel' } as unknown as DirHandle;
    await rememberHandle(handle, factory);
    expect(await recallHandle(factory)).toMatchObject({ name: 'corbel' });
    // …and the projects store is still there and still usable, which is the half that used to fail
    await indexedDbProjects(factory).writeJournal({ id: 'a', name: 'a', at: 1, createdAt: 1, commands: 2, hash: null, thumbnail: null }, CMDS);
    expect(await indexedDbProjects(factory).journal('a')).toEqual(CMDS);
    await forgetHandle(factory);
    expect(await recallHandle(factory)).toBeNull();
  });

  it('migrates the one autosave slot of a version-1 database into a project, once', async () => {
    await legacyDb({ name: 'restored-beam', at: 1_700_000_000_000, cmds: CMDS });
    const db = await openDb(factory);
    expect(stores(db)).toEqual([HANDLES, JOURNALS, PROJECTS]);
    db.close();

    const store = indexedDbProjects(factory);
    const [meta, ...rest] = await store.list();
    expect(rest).toEqual([]);
    expect(meta).toMatchObject({ name: 'restored-beam', at: 1_700_000_000_000, commands: 2, hash: null, thumbnail: null });
    expect(await store.journal(meta!.id)).toEqual(CMDS);

    // A second open is a no-op: the record is there, and nothing is written over it.
    await store.writeMeta({ ...meta!, name: 'renamed' });
    (await openDb(factory)).close();
    expect((await store.list()).map((p) => p.name)).toEqual(['renamed']);
  });

  it('upgrades a version-1 database whose slot is empty without inventing a project', async () => {
    await legacyDb();
    (await openDb(factory)).close();
    expect(await indexedDbProjects(factory).list()).toEqual([]);
  });

  it('reports a blocked upgrade as a structured error rather than hanging', async () => {
    // A version-1 connection left open is exactly the other tab the message talks about.
    await legacyDb();
    const holding = await new Promise<IDBDatabase>((resolve) => {
      const req = factory.open(DB_NAME, 1);
      req.onsuccess = () => resolve(req.result);
    });
    await expect(openDb(factory)).rejects.toMatchObject({ code: 'unsupported', where: 'IndexedDB femlab' });
    holding.close();
  });
});

/** A clock and a timer the test drives, so a debounce fires when the test says so. */
function harness(store: ProjectStore, extra: Partial<ProjectsOptions> = {}) {
  let pending: (() => void) | null = null;
  let at = 1_000;
  let n = 0;
  const replayed: ShareCommand[][] = [];
  const reset = vi.fn(async () => undefined);
  const projects = makeProjects({
    store,
    replay: async (cmds) => void replayed.push(cmds),
    reset,
    now: () => (at += 1000),
    newId: () => `id-${++n}`,
    setTimer: (fn) => {
      pending = fn;
      return 1;
    },
    clearTimer: () => {
      pending = null;
    },
    ...extra,
  });
  return { projects, reset, replayed, tick: () => pending?.() };
}

// The fake is type-checked against the real interface, and both satisfy the same table.
describe.each([
  ['in memory', () => memoryProjects()],
  ['in IndexedDB', () => indexedDbProjects(factory)],
])('projects %s', (_name, make) => {
  it('creates a project the first time a Model becomes non-empty, and writes it once per burst', async () => {
    const store = make();
    const { projects, tick } = harness(store);
    expect(projects.current()).toBeNull();

    // Boot refreshes before any Command; an empty Journal is not a project yet.
    projects.note('untitled', [], null);
    expect(projects.list()).toEqual([]);

    projects.note('beam', CMDS.slice(0, 1), 'h1');
    projects.note('beam', CMDS, 'h2');
    expect(projects.current()).toMatchObject({ id: 'id-1', name: 'beam', commands: 2, hash: 'h2', saving: true });
    tick();
    await projects.flush();
    expect(projects.current()).toMatchObject({ saving: false });

    expect((await store.list()).map((p) => p.name)).toEqual(['beam']);
    expect(await store.journal('id-1')).toEqual(CMDS);
  });

  it('forks: a Model-replacing Command starts a second project and leaves the first alone', async () => {
    const store = make();
    const { projects, tick } = harness(store);
    projects.note('beam', CMDS, 'h');
    tick();
    await projects.flush();

    projects.fork();
    expect(projects.current()).toBeNull();
    projects.note('plate', [CMDS[0]!], 'h2');
    tick();
    await projects.flush();

    expect(projects.list().map((p) => p.name)).toEqual(['plate', 'beam']);
    expect(await store.journal('id-1')).toEqual(CMDS);
    expect(await store.journal('id-2')).toEqual([CMDS[0]]);
  });

  it('new, open, rename, delete — and open replays the Journal it was given', async () => {
    const store = make();
    const { projects, reset, replayed, tick } = harness(store);
    const first = await projects.new('corbel');
    expect(reset).toHaveBeenCalledWith('corbel');
    expect(projects.current()).toMatchObject({ id: first.id, name: 'corbel', commands: 0 });
    projects.note('corbel', CMDS, 'h');
    tick();
    await projects.flush();

    await projects.new('plate');
    expect(projects.list().map((p) => p.name)).toEqual(['plate', 'corbel']);

    await projects.open(first.id);
    expect(replayed).toEqual([CMDS]);
    expect(projects.current()).toMatchObject({ name: 'corbel' });

    // `id` defaults to the open project, which is what the top bar's inline field sends.
    await projects.rename(undefined, 'corbel-ULS');
    expect(projects.current()).toMatchObject({ name: 'corbel-ULS' });
    expect((await store.list()).find((p) => p.id === first.id)!.name).toBe('corbel-ULS');

    await projects.delete(first.id);
    expect(projects.list().map((p) => p.name)).toEqual(['plate']);
    expect(projects.current()).toBeNull();
    // the Journal goes with it
    expect(await store.journal(first.id)).toBeNull();
  });

  it('refuses an id it does not have, and a project whose Journal is gone', async () => {
    const store = make();
    const { projects } = harness(store);
    await expect(projects.open('nope')).rejects.toMatchObject({ code: 'not-found' });
    await expect(projects.rename('nope', 'x')).rejects.toMatchObject({ code: 'not-found' });
    await expect(projects.delete('nope')).rejects.toMatchObject({ code: 'not-found' });

    await store.writeMeta({ id: 'orphan', name: 'orphan', at: 1, createdAt: 1, commands: 3, hash: null, thumbnail: null });
    await projects.prime();
    await expect(projects.open('orphan')).rejects.toMatchObject({ code: 'not-found', where: "journal 'orphan'" });
  });

  it('primes from the store, newest first', async () => {
    const store = make();
    const meta = (id: string, at: number): ProjectMeta => ({ id, name: id, at, createdAt: at, commands: 1, hash: null, thumbnail: null });
    await store.writeJournal(meta('old', 1000), CMDS);
    await store.writeJournal(meta('new', 3000), CMDS);
    const { projects } = harness(store);
    expect(await projects.prime()).toHaveLength(2);
    expect(projects.list().map((p) => p.id)).toEqual(['new', 'old']);
  });

  it('project.save flushes, takes a thumbnail and answers null when there is no project', async () => {
    const store = make();
    const thumbnail = vi.fn(async () => 'data:image/webp;base64,AA');
    const { projects } = harness(store, { thumbnail });
    expect(await projects.save()).toBeNull();
    expect(thumbnail).not.toHaveBeenCalled();

    projects.note('beam', CMDS, 'h');
    // No tick: `save` is the explicit flush, which is why the e2e can reload without a race.
    const saved = await projects.save();
    expect(saved).toMatchObject({ name: 'beam', commands: 2, thumbnail: 'data:image/webp;base64,AA', saving: false });
    expect(await store.journal('id-1')).toEqual(CMDS);

    // A viewer that cannot be shot keeps the thumbnail it had rather than losing it.
    thumbnail.mockRejectedValueOnce(new Error('no canvas'));
    expect(await projects.save()).toMatchObject({ thumbnail: 'data:image/webp;base64,AA' });
  });

  it('file.autosave off stops writing and never deletes what is already saved', async () => {
    const store = make();
    const { projects, tick } = harness(store);
    projects.note('beam', CMDS, 'h');
    tick();
    await projects.flush();

    projects.setEnabled(false);
    expect(projects.enabled()).toBe(false);
    projects.note('beam', [...CMDS, { cmd: 'material.add', name: 'steel' }], 'h2');
    tick();
    await projects.flush();
    expect(await store.journal('id-1')).toEqual(CMDS);
    expect(projects.list().map((p) => p.name)).toEqual(['beam']);
    expect(projects.current()).toMatchObject({ autosave: false });

    projects.setEnabled(true);
    projects.note('beam', [...CMDS, { cmd: 'material.add', name: 'steel' }], 'h2');
    tick();
    await projects.flush();
    expect(await store.journal('id-1')).toHaveLength(3);
  });

  it('reports a failed write through onError and keeps the model alive', async () => {
    const store = make();
    const onError = vi.fn();
    store.writeJournal = () => Promise.reject(new Error('quota'));
    const { projects, tick } = harness(store, { onError });
    projects.note('beam', CMDS, 'h');
    tick();
    await projects.flush();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'quota' }));
    expect(projects.current()).toMatchObject({ name: 'beam' });
  });

  it('tells the app about every change, so the top bar and the Recent list follow', async () => {
    const onChange = vi.fn();
    const { projects, tick } = harness(make(), { onChange });
    projects.note('beam', CMDS, 'h');
    expect(onChange).toHaveBeenCalled();
    tick();
    await projects.flush();
    expect(onChange.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('the default timer', () => {
  it('writes on its own, without an injected clock', async () => {
    const store = memoryProjects();
    const projects = makeProjects({ store, replay: async () => undefined, reset: async () => undefined, delayMs: 1 });
    projects.note('beam', CMDS, 'h');
    await new Promise((r) => setTimeout(r, 10));
    await projects.flush();
    expect(await store.journal((await store.list())[0]!.id)).toEqual(CMDS);
    // A real `crypto.randomUUID` id, not an injected one.
    expect((await store.list())[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('tx', () => {
  it('rejects rather than swallowing a request that fails', async () => {
    await expect(tx(factory, PROJECTS, 'readonly', (s) => s.get(undefined as never))).rejects.toBeTruthy();
  });
});
