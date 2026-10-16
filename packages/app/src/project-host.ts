// Project I/O belongs to the browser host, shared by Commands, scripts and the Assistant.
// The injected boundary is also used by tests; native handles stay opaque through the registry.
import { FemError, MAX_GEOMETRY_FILE_BYTES, type HostContext } from '@femlab/registry';
import { forgetHandle, pickFolder, ProjectFolder, recallHandle, recentFolder, rememberHandle, type DirHandle } from './ai/project';
import type { Store } from './store';

export interface ProjectAccess {
  pick(): Promise<DirHandle>;
  recall(): Promise<DirHandle | null>;
  recent(): Promise<{ name: string } | null>;
  remember(handle: DirHandle): Promise<void>;
  forget(): Promise<void>;
}

export const browserProjectAccess: ProjectAccess = {
  pick: () => pickFolder(),
  recall: () => recallHandle(),
  recent: () => recentFolder(),
  remember: (handle) => rememberHandle(handle),
  forget: () => forgetHandle(),
};

/** Preserve cancellation and permission failures as structured errors, never a second picker. */
export function projectError(error: unknown, where: string): FemError {
  if (error instanceof FemError) return error;
  const name = error instanceof Error ? error.name : 'Error';
  const cause = error instanceof Error ? error.message : String(error);
  if (name === 'AbortError') return new FemError('cancelled', cause, where, 'retry folder.open when ready');
  if (name === 'NotFoundError') return new FemError('file.not-found', cause, where, 'use query.folder to list files or folder.open to choose a folder');
  if (name === 'NotAllowedError' || name === 'SecurityError') return new FemError('file.scope', `${name}: ${cause}`, where, 'use folder.open from a click and grant read/write access');
  return new FemError('internal', `${name}: ${cause}`, where, 'check folder access, then retry folder.refresh');
}

function directoryHandle(value: unknown): DirHandle {
  const handle = value as Partial<DirHandle> | null;
  if (!handle || handle.kind !== 'directory' || typeof handle.name !== 'string' ||
    typeof handle.entries !== 'function' || typeof handle.getDirectoryHandle !== 'function' || typeof handle.getFileHandle !== 'function') {
    throw new FemError('schema', 'folder.open needs a directory handle from the browser', 'handle', 'use folder.open with picker: true');
  }
  return handle as DirHandle;
}

interface FolderLifetime { generation: number; retired: boolean }
const lifetimes = new WeakMap<Store, FolderLifetime>();
const persistenceQueues = new WeakMap<ProjectAccess, { tail: Promise<void> }>();

/** A replaced model cannot publish an unfinished folder selection into its retired UI. */
export function retireProjectHost(store: Store): void {
  const lifetime = lifetimes.get(store);
  if (lifetime) { lifetime.generation++; lifetime.retired = true; }
}

export function makeProjectHost(store: Store, access: ProjectAccess = browserProjectAccess, admit: () => Promise<void> = async () => undefined): HostContext['folder'] {
  // Producers are short-lived; the selected folder and open/close ordering belong to their Store.
  let lifetime = lifetimes.get(store);
  if (!lifetime) { lifetime = { generation: 0, retired: false }; lifetimes.set(store, lifetime); }
  const state = lifetime;
  // The browser's remembered folder is shared across model activations.
  let persistence = persistenceQueues.get(access);
  if (!persistence) { persistence = { tail: Promise.resolve() }; persistenceQueues.set(access, persistence); }
  const queue = persistence;
  const persist = (run: () => Promise<void>) => {
    const next = queue.tail.then(run);
    queue.tail = next.catch(() => undefined);
    return next;
  };
  const current = () => {
    const folder = store.state.folder;
    if (!folder) throw new FemError('file.not-found', 'no project folder is open', 'folder', 'use folder.open from a click');
    return folder;
  };
  const publish = (folder: ProjectFolder) => {
    if (store.state.folder === folder) store.setFolder(folder);
  };
  const written = async (folder: ProjectFolder) => {
    // close() already committed the file. A catalog failure must not turn that successful
    // delivery into a failed save receipt or leave the Model's saved baseline dirty.
    try { await folder.refresh(); publish(folder); }
    catch (error) { store.log('warn', `file saved; project catalog could not refresh: ${String(error)}; retry folder.refresh`); }
  };
  const check = (started: number) => {
    if (state.retired || state.generation !== started) throw new FemError('cancelled', 'a newer project open or close superseded this request', 'folder.open', 'use query.folder to see the active folder');
  };
  return {
    open: async (how) => {
      const started = ++state.generation;
      try {
        // Call the picker immediately, while the initiating click still has user activation.
        const value = await ('picker' in how ? access.pick() : 'reopen' in how ? access.recall() : how.handle);
        if (value === null) throw new FemError('file.not-found', 'no project folder was remembered', 'folder.open', 'use folder.open with picker: true');
        const handle = directoryHandle(value);
        check(started);
        if (handle.requestPermission && await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') {
          throw new FemError('file.scope', 'read/write permission for the project folder was denied', 'folder.open', 'use folder.open from a click and allow access');
        }
        check(started);
        const folder = await ProjectFolder.fromHandle(handle);
        check(started);
        await admit();
        check(started);
        store.setFolder(folder);
        await persist(() => access.remember(handle)).catch((error: unknown) => {
          // Remembering is optional: blocked browser storage must not disable granted file I/O.
          store.log('warn', `project folder is open for this session; could not remember it: ${String(error)}`);
        });
        check(started);
      } catch (error) {
        const structured = projectError(error, 'folder.open');
        if ('reopen' in how && state.generation === started && !state.retired &&
          (structured.code === 'file.not-found' || structured.code === 'schema' || structured.cause.startsWith('NotReadableError:'))) {
          await persist(() => access.forget()).catch((cleanup: unknown) => {
            store.log('warn', `could not forget the unavailable project folder: ${String(cleanup)}`);
          });
        }
        throw structured;
      }
    },
    close: async () => {
      state.generation++;
      store.setFolder(null);
      try { await persist(() => access.forget()); }
      catch (error) { throw projectError(error, 'folder.close'); }
    },
    refresh: async () => {
      const folder = current();
      try { await folder.refresh(); publish(folder); }
      catch (error) { throw projectError(error, 'folder.refresh'); }
    },
    info: () => store.state.folder?.info() ?? null,
    recent: async () => {
      try {
        await queue.tail;
        return await access.recent();
      } catch (error) { throw projectError(error, 'query.folderRecent'); }
    },
    readText: async (path, maxBytes) => {
      const folder = current();
      try { return await folder.readText(path, maxBytes); }
      catch (error) { throw projectError(error, path); }
    },
    readBytes: async (path) => {
      const folder = current();
      try {
        const file = await folder.readFile(path);
        if (file.size > MAX_GEOMETRY_FILE_BYTES) throw new FemError('unsupported', `'${path}' exceeds the 32 MiB read limit`, path, 'read a smaller file');
        return new Uint8Array(await file.arrayBuffer());
      } catch (error) { throw projectError(error, path); }
    },
    writeText: async (path, text) => {
      const folder = current();
      try { await folder.writeText(path, text); await written(folder); }
      catch (error) { throw projectError(error, path); }
    },
    writeBytes: async (path, bytes) => {
      const folder = current();
      try { await folder.writeBytes(path, bytes); await written(folder); }
      catch (error) { throw projectError(error, path); }
    },
  };
}
