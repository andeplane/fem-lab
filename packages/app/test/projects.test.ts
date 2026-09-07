// Projects (issue #41), against the real `openDb`, the real stores and the real migration —
// `fake-indexeddb` is a full implementation of the spec, so the version-1 → version-2 upgrade is
// exercised here rather than stood in for by a hand-rolled fake (AGENTS: ponytail applies to
// code, never to verification).
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { DB_NAME, HANDLES, JOURNALS, PROJECTS, REVISIONS, openDb, tx, type ProjectMeta } from '../src/db';
import { indexedDbAtomicProjects } from '../src/project-repository';
import { forgetHandle, recallHandle, rememberHandle, type DirHandle } from '../src/ai/project';
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
