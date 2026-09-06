// Project I/O belongs to the browser host, shared by Commands, scripts and the Assistant.
// The injected boundary is also used by tests; native handles stay opaque through the registry.
import { FemError, type HostContext } from '@femlab/registry';
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
  if (name === 'AbortError') return new FemError('cancelled', cause, where, 'retry project.open when ready');
  if (name === 'NotFoundError') return new FemError('file.not-found', cause, where, 'use query.project to list files or project.open to choose a folder');
  if (name === 'NotAllowedError' || name === 'SecurityError') return new FemError('file.scope', `${name}: ${cause}`, where, 'use project.open from a click and grant read/write access');
  return new FemError('internal', `${name}: ${cause}`, where, 'check folder access, then retry project.refresh');
}

function directoryHandle(value: unknown): DirHandle {
  const handle = value as Partial<DirHandle> | null;
  if (!handle || handle.kind !== 'directory' || typeof handle.name !== 'string' ||
    typeof handle.entries !== 'function' || typeof handle.getDirectoryHandle !== 'function' || typeof handle.getFileHandle !== 'function') {
    throw new FemError('schema', 'project.open needs a directory handle from the browser', 'handle', 'use project.open with picker: true');
  }
  return handle as DirHandle;
}

export function makeProjectHost(store: Store, access: ProjectAccess = browserProjectAccess): HostContext['project'] {
  let generation = 0;
  // Store writes follow open/close order even if an earlier IndexedDB transaction is slow.
  let persistence: Promise<void> = Promise.resolve();
  const persist = (run: () => Promise<void>) => {
    const next = persistence.then(run);
    persistence = next.catch(() => undefined);
    return next;
  };
  const current = () => {
    const folder = store.state.project;
    if (!folder) throw new FemError('file.not-found', 'no project folder is open', 'project', 'use project.open from a click');
    return folder;
  };
  const publish = (folder: ProjectFolder) => {
    if (store.state.project === folder) store.setProject(folder);
  };
  const check = (started: number) => {
    if (generation !== started) throw new FemError('cancelled', 'a newer project open or close superseded this request', 'project.open', 'use query.project to see the active folder');
  };
  return {
    open: async (how) => {
      const started = ++generation;
      try {
        // Call the picker immediately, while the initiating click still has user activation.
        const value = await ('picker' in how ? access.pick() : 'reopen' in how ? access.recall() : how.handle);
        if (value === null) throw new FemError('file.not-found', 'no project folder was remembered', 'project.open', 'use project.open with picker: true');
        const handle = directoryHandle(value);
        check(started);
        if (handle.requestPermission && await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') {
          throw new FemError('file.scope', 'read/write permission for the project folder was denied', 'project.open', 'use project.open from a click and allow access');
        }
        check(started);
        const folder = await ProjectFolder.fromHandle(handle);
        check(started);
        await persist(() => access.remember(handle)).catch((error: unknown) => {
          // Remembering is optional: blocked browser storage must not disable granted file I/O.
          store.log('warn', `project folder is open for this session; could not remember it: ${String(error)}`);
        });
        check(started);
        store.setProject(folder);
      } catch (error) {
        throw projectError(error, 'project.open');
      }
    },
    close: async () => {
      generation++;
      store.setProject(null);
      try { await persist(() => access.forget()); }
      catch (error) { throw projectError(error, 'project.close'); }
    },
    refresh: async () => {
      const folder = current();
      try { await folder.refresh(); publish(folder); }
      catch (error) { throw projectError(error, 'project.refresh'); }
    },
    info: () => store.state.project?.info() ?? null,
    recent: async () => {
      try {
        await persistence;
        return await access.recent();
      } catch (error) { throw projectError(error, 'query.projectRecent'); }
    },
    readText: async (path) => {
      const folder = current();
      try { return await folder.readText(path); }
      catch (error) { throw projectError(error, path); }
    },
    writeText: async (path, text) => {
      const folder = current();
      try { await folder.writeText(path, text); publish(folder); }
      catch (error) { throw projectError(error, path); }
    },
    writeBytes: async (path, bytes) => {
      const folder = current();
      try { await folder.writeBytes(path, bytes); publish(folder); }
      catch (error) { throw projectError(error, path); }
    },
  };
}
