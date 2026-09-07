// Projects (issue #41), against the real `openDb`, the real stores and the real migration —
// `fake-indexeddb` is a full implementation of the spec, so the version-1 → version-2 upgrade is
// exercised here rather than stood in for by a hand-rolled fake (AGENTS: ponytail applies to
// code, never to verification).
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DB_NAME, HANDLES, JOURNALS, PROJECTS, REVISIONS, openDb, tx, type ProjectMeta } from '../src/db';
import { indexedDbAtomicProjects } from '../src/project-repository';
import { RESTORING, forgetHandle, recallHandle, rememberHandle, rememberedFolder, reopenRemembered, type Breadcrumbs, type DirHandle } from '../src/ai/project';
import { indexedDbStore, type ShareCommand } from '../src/share';

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
  it('creates its four stores on a browser that has never seen FEM Lab', async () => {
    const db = await openDb(factory);
    expect(stores(db)).toEqual([HANDLES, JOURNALS, PROJECTS, REVISIONS]);
    expect(db.version).toBe(3);
    db.close();
  });

  // The regression guard for the bug in the header of `src/db.ts`: two modules used to open
  // `femlab` at version 1 with different stores, and the loser's transaction raised NotFoundError.
  it('round-trips a directory handle through the same database the projects live in', async () => {
    const handle = { kind: 'directory', name: 'corbel' } as unknown as DirHandle;
    await rememberHandle(handle, factory);
    expect(await recallHandle(factory)).toMatchObject({ name: 'corbel' });
    // …and the projects store is still there and still usable, which is the half that used to fail
    await indexedDbAtomicProjects(factory).update('a', () => ({ id: 'a', generation: 'fixture', version: '0', meta: { id: 'a', name: 'a', at: 1, createdAt: 1, commands: 2, hash: null, thumbnail: null }, cmds: CMDS }));
    expect((await indexedDbAtomicProjects(factory).read('a'))?.cmds).toEqual(CMDS);
    await forgetHandle(factory);
    expect(await recallHandle(factory)).toBeNull();
  });

  it('migrates the one autosave slot of a version-1 database into a project, once', async () => {
    await legacyDb({ name: 'restored-beam', at: 1_700_000_000_000, cmds: CMDS });
    const db = await openDb(factory);
    expect(stores(db)).toEqual([HANDLES, JOURNALS, PROJECTS, REVISIONS]);
    db.close();

    const store = indexedDbAtomicProjects(factory);
    const [meta, ...rest] = await store.list();
    expect(rest).toEqual([]);
    expect(meta).toMatchObject({ name: 'restored-beam', at: 1_700_000_000_000, commands: 2, hash: null, thumbnail: null });
    expect((await store.read(meta!.id))?.cmds).toEqual(CMDS);

    // A second open is a no-op: the record is there, and nothing is written over it.
    await store.update(meta!.id, row => ({ ...row!, meta: { ...meta!, name: 'renamed' } }));
    (await openDb(factory)).close();
    expect((await store.list()).map((p) => p.name)).toEqual(['renamed']);
  });

  it('keeps revision history, projects and folder handles in one upgraded database', async () => {
    const projects = indexedDbAtomicProjects(factory);
    const meta: ProjectMeta = { id: 'kept', name: 'kept', at: 2, createdAt: 1, commands: 2, hash: null, thumbnail: null };
    await projects.update(meta.id, () => ({ id: meta.id, generation: 'fixture', version: '0', meta, cmds: CMDS }));
    const handle = { kind: 'directory', name: 'folder' } as unknown as DirHandle;
    await rememberHandle(handle, factory);
    const history = indexedDbStore(factory);
    const revision = { id: 'r1', name: 'earlier', at: 1, cmds: CMDS.slice(0, 1) };
    await history.write([revision]);
    expect(await history.read()).toEqual([revision]);
    expect((await projects.read('kept'))?.cmds).toEqual(CMDS);
    expect(await recallHandle(factory)).toMatchObject({ name: 'folder' });
    await history.clear();
    expect(await history.read()).toEqual([]);
    expect(await projects.list()).toEqual([meta]);
    expect((await projects.read('kept'))?.cmds).toEqual(CMDS);
    expect(await recallHandle(factory)).toMatchObject({ name: 'folder' });
  });

  it('adds history to a version-2 database without changing its saved project', async () => {
    const meta: ProjectMeta = { id: 'v2', name: 'existing', at: 4, createdAt: 3, commands: 2, hash: 'saved', thumbnail: null };
    await new Promise<void>((resolve, reject) => {
      const request = factory.open(DB_NAME, 2);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(PROJECTS, { keyPath: 'id' }).put(meta);
        request.result.createObjectStore(JOURNALS, { keyPath: 'id' }).put({ id: meta.id, cmds: CMDS });
        request.result.createObjectStore(HANDLES);
      };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
    const db = await openDb(factory);
    expect(db.version).toBe(3);
    expect(stores(db)).toEqual([HANDLES, JOURNALS, PROJECTS, REVISIONS]);
    db.close();
    const projects = indexedDbAtomicProjects(factory);
    expect(await projects.list()).toEqual([meta]);
    expect((await projects.read(meta.id))?.cmds).toEqual(CMDS);
    expect(await indexedDbStore(factory).read()).toEqual([]);
  });

  it('upgrades a version-1 database whose slot is empty without inventing a project', async () => {
    await legacyDb();
    (await openDb(factory)).close();
    expect(await indexedDbAtomicProjects(factory).list()).toEqual([]);
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

describe('tx', () => {
  it('rejects rather than swallowing a request that fails', async () => {
    await expect(tx(factory, PROJECTS, 'readonly', (s) => s.get(undefined as never))).rejects.toBeTruthy();
  });
});

/**
 * Issue #247. Chromium 153 ends the browser process when IndexedDB deserialises a stored
 * `FileSystemHandle` in an off-the-record profile — no exception, no crash event, nothing a `try`
 * can catch. So what is tested here is that start-up never makes that read, and that a record
 * which cannot become a usable handle is recoverable data: forgotten, reported as
 * `file.not-found`, and costing the rest of the browser's storage nothing.
 */
describe('a remembered project folder', () => {
  const crumbs = (initial: Record<string, string> = {}): Breadcrumbs & { all: Record<string, string> } => {
    const all: Record<string, string> = { ...initial };
    return {
      all,
      getItem: (key: string) => all[key] ?? null,
      setItem: (key: string, value: string) => void (all[key] = value),
      removeItem: (key: string) => void delete all[key],
    };
  };
  const handleKeys = (): Promise<IDBValidKey[]> => tx<IDBValidKey[]>(factory, HANDLES, 'readonly', (s) => s.getAllKeys());
  /** Every key whose *value* is deserialised, and what the breadcrumb said at the time. */
  const watchGets = (crumb: Breadcrumbs): { reads: string[]; restore: () => void } => {
    const reads: string[] = [];
    const real = IDBObjectStore.prototype.get;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
      reads.push(`${String(key)} while ${crumb.getItem(RESTORING) ?? 'clear'}`);
      return real.call(this, key);
    });
    return { reads, restore: () => spy.mockRestore() };
  };
  const dirHandle = (name: string): DirHandle => ({ kind: 'directory', name }) as unknown as DirHandle;
  /** Both records as a browser would hold them, with whatever the handle slot deserialised to. */
  const poison = async (value: unknown, name = 'poison'): Promise<void> => {
    await tx(factory, HANDLES, 'readwrite', (s) => s.put(value, 'folder'));
    await tx(factory, HANDLES, 'readwrite', (s) => s.put({ name, at: 7 }, 'folder:info'));
  };
  const project: ProjectMeta = { id: 'kept', name: 'kept', at: 2, createdAt: 1, commands: 2, hash: null, thumbnail: null };

  it('offers the folder by name at start-up without ever deserialising the handle', async () => {
    await rememberHandle(dirHandle('corbel'), factory, () => 5);
    const store = crumbs();
    const watch = watchGets(store);
    try {
      expect(await rememberedFolder(factory)).toEqual({ name: 'corbel', at: 5 });
    } finally {
      watch.restore();
    }
    expect(watch.reads).toEqual(['folder:info while clear']);
  });

  it('keeps the projects and forgets a handle record that is no longer a directory handle', async () => {
    await indexedDbAtomicProjects(factory).update(project.id, () => ({ id: project.id, meta: project, cmds: CMDS, generation: '1', version: '0' }));
    await poison({ kind: 'file', name: 'not-a-folder' });

    // The start screen still gets its list, and is still offered the folder: neither read deserialises it.
    expect(await indexedDbAtomicProjects(factory).list()).toEqual([project]);
    expect(await rememberedFolder(factory)).toEqual({ name: 'poison', at: 7 });

    const store = crumbs();
    await expect(recallHandle(factory, store)).rejects.toMatchObject({
      code: 'file.not-found',
      cause: 'the remembered folder ‘poison’ is no longer available in this browser',
      where: 'the remembered project folder',
      suggestion: 'open a project folder again to pick it',
    });
    // Recoverable data: the bad record is gone, the offer with it, the projects untouched.
    expect(await handleKeys()).toEqual([]);
    expect(await rememberedFolder(factory)).toBeNull();
    expect(store.all).toEqual({});
    expect(await indexedDbAtomicProjects(factory).list()).toEqual([project]);
    expect((await indexedDbAtomicProjects(factory).read('kept'))?.cmds).toEqual(CMDS);
  });

  it('never reads the handle again when restoring it did not come back', async () => {
    await indexedDbAtomicProjects(factory).update(project.id, () => ({ id: project.id, meta: project, cmds: CMDS, generation: '1', version: '0' }));
    await poison(dirHandle('poison'));
    // The breadcrumb the previous attempt left behind: the browser went down before it was cleared.
    const store = crumbs({ [RESTORING]: 'poison' });
    const watch = watchGets(store);
    try {
      await expect(recallHandle(factory, store)).rejects.toMatchObject({
        code: 'file.not-found',
        cause: 'restoring ‘poison’ ended this browser last time, so it is not tried again',
      });
    } finally {
      watch.restore();
    }
    expect(watch.reads).toEqual(['folder:info while poison']);
    expect(await handleKeys()).toEqual([]);
    expect(store.all).toEqual({});
    expect(await indexedDbAtomicProjects(factory).list()).toEqual([project]);
  });

  it('carries the breadcrumb across the read that can kill the browser, and clears it after', async () => {
    await rememberHandle(dirHandle('corbel'), factory, () => 5);
    const store = crumbs();
    const watch = watchGets(store);
    try {
      expect(await recallHandle(factory, store)).toMatchObject({ kind: 'directory', name: 'corbel' });
    } finally {
      watch.restore();
    }
    expect(watch.reads).toEqual(['folder:info while clear', 'folder while corbel']);
    expect(store.all).toEqual({});
    // A handle that did come back stays remembered for the next reload.
    expect(await rememberedFolder(factory)).toEqual({ name: 'corbel', at: 5 });
  });

  it('drops a handle an older build left without a descriptor beside it', async () => {
    await tx(factory, HANDLES, 'readwrite', (s) => s.put(dirHandle('orphan'), 'folder'));
    expect(await rememberedFolder(factory)).toBeNull();
    expect(await handleKeys()).toEqual([]);
    expect(await recallHandle(factory, crumbs())).toBeNull();
  });

  it('reports a remembered folder that no longer reads as the same structured error', async () => {
    // Deserialises to a directory handle, but the folder behind it is gone: a revoked or moved one.
    await poison(dirHandle('gone'), 'gone');
    const store = crumbs();
    await expect(reopenRemembered(factory, store)).rejects.toMatchObject({
      code: 'file.not-found',
      where: 'the remembered project folder',
      suggestion: 'open a project folder again to pick it',
    });
    expect(await handleKeys()).toEqual([]);
    await expect(reopenRemembered(factory, store)).resolves.toBeNull();
  });

  it('forgets both records together, so nothing half-remembered is ever offered', async () => {
    await rememberHandle(dirHandle('corbel'), factory, () => 5);
    expect(await handleKeys()).toEqual(['folder', 'folder:info']);
    const store = crumbs({ [RESTORING]: 'corbel' });
    await forgetHandle(factory, store);
    expect(await handleKeys()).toEqual([]);
    expect(store.all).toEqual({});
  });
});
