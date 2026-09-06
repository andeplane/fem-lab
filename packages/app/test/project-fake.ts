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
      if (!options?.create && !Object.keys(files).some((p) => p.startsWith(`${prefix}${child}/`))) throw new Error(`no directory ${child}`);
      return make(`${prefix}${child}/`, child);
    },
    getFileHandle: async (child, options) => {
      const path = prefix + child;
      if (!(path in files)) {
        if (!options?.create) throw new Error(`no file ${path}`);
        files[path] = '';
      }
      return file(path);
    },
  });
  const file = (path: string): FileHandle => ({
    kind: 'file',
    name: path.split('/').at(-1)!,
    getFile: async () => ({ size: files[path]!.length, lastModified: at, text: async () => files[path]! }),
    createWritable: async () => ({
      write: async (data) => void (files[path] = typeof data === 'string' ? data : new TextDecoder().decode(data)),
      close: async () => undefined,
    }),
  });
  return make('', name);
}

