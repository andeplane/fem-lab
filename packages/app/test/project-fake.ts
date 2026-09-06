import type { ProjectAccess } from '../src/project-host';
import type { DirHandle, FileHandle } from '../src/ai/project';

/** The whole fake: a path → text map behind the handle shape `ProjectFolder` walks. */
export function fakeDir(files: Record<string, string>, name = 'bridge', at = 1): DirHandle {
  const make = (prefix: string, dirName: string): DirHandle => ({
    kind: 'directory',
    name: dirName,
    async *entries() {
      const seen = new Set<string>();
      for (const path of Object.keys(files)) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const head = rest.split('/')[0]!;
        if (seen.has(head)) continue;
        seen.add(head);
        yield [head, rest.includes('/') ? make(`${prefix}${head}/`, head) : file(path)] as [string, DirHandle | FileHandle];
      }
    },
    getDirectoryHandle: async (child, options) => {
      if (!options?.create && !Object.keys(files).some((p) => p.startsWith(`${prefix}${child}/`))) throw new DOMException(`no directory ${child}`, 'NotFoundError');
      return make(`${prefix}${child}/`, child);
    },
    getFileHandle: async (child, options) => {
      const path = prefix + child;
      if (!(path in files)) {
        if (!options?.create) throw new DOMException(`no file ${path}`, 'NotFoundError');
        files[path] = '';
      }
      return file(path);
    },
  });
  const file = (path: string): FileHandle => ({
    kind: 'file',
    name: path.split('/').at(-1)!,
    getFile: async () => ({ size: files[path]!.length, lastModified: at, text: async () => files[path]! }),
    createWritable: async () => {
      let pending = files[path]!;
      return {
        write: async (data) => { pending = typeof data === 'string' ? data : new TextDecoder().decode(data); },
        close: async () => { files[path] = pending; },
        abort: async () => undefined,
      };
    },
  });
  return make('', name);
}


/** Remembering uses the same opaque handles, without browser storage in unit tests. */
export function memoryProjectAccess(pick: () => Promise<DirHandle>): ProjectAccess {
  let remembered: DirHandle | null = null;
  return { pick, recall: async () => remembered, recent: async () => remembered ? { name: remembered.name } : null, remember: async (handle) => { remembered = handle; }, forget: async () => { remembered = null; } };
}
