// The one module that opens IndexedDB. Everything the app keeps in this browser lives in the
// `femlab` database at version 2, and nothing else may call `indexedDB.open`.
//
// That rule is the fix for a real bug: `share.ts` used to open `femlab` at version 1 and create
// an `autosave` store, and `ai/project.ts` opened the same name at the same version and created a
// `handles` store. Whichever ran first defined the store set; the other's `onupgradeneeded` never
// fired and its transaction raised `NotFoundError`. One module, one version, three stores.
//
//   projects   keyPath 'id'   the Recent list's metadata: a few kB, read on every start screen
//   journals   keyPath 'id'   the Commands, read only when a project is opened
//   handles    out-of-line    the project *folder* handle (`FileSystemDirectoryHandle`)
//
// Two stores for a project, not one, so listing Recent never reads a Command.
import { FemError } from '@femlab/registry';
import type { ShareCommand } from './share';

export const DB_NAME = 'femlab';
export const DB_VERSION = 2;
export const PROJECTS = 'projects';
export const JOURNALS = 'journals';
export const HANDLES = 'handles';

/** What the Recent list and the top bar read; the Commands live in `journals` under the same id. */
export interface ProjectMeta {
  id: string;
  name: string;
  /** When the project was last written, ms. */
  at: number;
  createdAt: number;
  /** The Journal length, so a card needs no journal read. */
  commands: number;
  /** `query.model().hash` at the last write; the e2e's identity check reads it. */
  hash: string | null;
  /** A `data:` URL, at most 320x180 (see `projects.ts`); `null` until a save takes one. */
  thumbnail: string | null;
}

export interface JournalRecord {
  id: string;
  cmds: ShareCommand[];
}

/** The single autosave slot of the version-1 database, which version 2 migrates into a project. */
interface LegacySlot {
  name: string;
  at: number;
  cmds: ShareCommand[];
}

const LEGACY = 'autosave';
const LEGACY_KEY = 'last';

export const done = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });

/**
 * The one autosaved Model a version-1 database holds, read before the upgrade drops its store.
 * Two opens rather than one, because `get` and `deleteObjectStore` on the same store inside one
 * `onupgradeneeded` is exactly the ordering that is easy to get wrong: an open with no version
 * cannot upgrade anything, so this read has the store entirely to itself.
 */
async function readLegacy(factory: IDBFactory): Promise<LegacySlot | null> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open(DB_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('cannot open IndexedDB'));
    req.onblocked = () => reject(blocked());
  });
  try {
    if (!db.objectStoreNames.contains(LEGACY)) return null;
    return (await done(db.transaction(LEGACY, 'readonly').objectStore(LEGACY).get(LEGACY_KEY) as IDBRequest<LegacySlot | undefined>)) ?? null;
  } finally {
    db.close();
  }
}

const blocked = (): FemError =>
  new FemError('unsupported', 'another FEM Lab tab is holding an older version of this browser’s storage', 'IndexedDB femlab', 'close the other tab and reload this one');

/**
 * Open `femlab` at version 2, creating the three stores and migrating a version-1 autosave into a
 * project on the way. The migrated records are written here, in an ordinary transaction, rather
 * than inside `onupgradeneeded`: the upgrade only creates and destroys stores.
 */
export async function openDb(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  const legacy = await readLegacy(factory);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const upgraded = req.result;
      if (!upgraded.objectStoreNames.contains(PROJECTS)) upgraded.createObjectStore(PROJECTS, { keyPath: 'id' });
      if (!upgraded.objectStoreNames.contains(JOURNALS)) upgraded.createObjectStore(JOURNALS, { keyPath: 'id' });
      if (!upgraded.objectStoreNames.contains(HANDLES)) upgraded.createObjectStore(HANDLES);
      if (upgraded.objectStoreNames.contains(LEGACY)) upgraded.deleteObjectStore(LEGACY);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('cannot open IndexedDB'));
    req.onblocked = () => reject(blocked());
  });
  if (legacy) {
    // Under the name it had, and only once: a second open finds the record already there.
    const id = `migrated-${legacy.at}`;
    const tx = db.transaction([PROJECTS, JOURNALS], 'readwrite');
    const projects = tx.objectStore(PROJECTS);
    if ((await done(projects.get(id) as IDBRequest<ProjectMeta | undefined>)) === undefined) {
      const meta: ProjectMeta = { id, name: legacy.name, at: legacy.at, createdAt: legacy.at, commands: legacy.cmds.length, hash: null, thumbnail: null };
      await done(projects.put(meta));
      await done(tx.objectStore(JOURNALS).put({ id, cmds: legacy.cmds } satisfies JournalRecord));
    }
  }
  return db;
}

/** One transaction over one store, opened and closed; the app's writes are small and rare. */
export async function tx<T>(factory: IDBFactory, store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb(factory);
  try {
    return await done(run(db.transaction(store, mode).objectStore(store)));
  } finally {
    db.close();
  }
}
