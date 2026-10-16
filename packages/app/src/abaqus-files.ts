import { ABAQUS_ACCEPT, FemError, type AbaqusFile, type AbaqusIo } from '@femlab/registry';
import type { ProjectFolder } from './ai/project';

/** The caller captures the folder at admission, before a file picker or disk read awaits. */
export function browserAbaqusIo(doc: Pick<Document, 'createElement'>, crypto: Pick<Crypto, 'subtle'>, folder: ProjectFolder | null, accept = ABAQUS_ACCEPT): AbaqusIo {
  // Retained only by this admitted import. Read requested dependencies, never every selected file.
  let includeFolder: Map<string, AbaqusFile> | null = null;
  return {
    pick: () => new Promise<AbaqusFile | null>(resolve => {
      const input = doc.createElement('input');
      input.type = 'file'; input.accept = accept;
      input.oncancel = () => resolve(null);
      input.onchange = () => {
        const file = input.files?.[0];
        resolve(file ? { name: file.name, size: file.size, read: async () => new Uint8Array(await file.arrayBuffer()) } : null);
      };
      input.click();
    }),
    pickIncludes: async paths => {
      if (includeFolder === null) {
        const selected = await new Promise<Map<string, AbaqusFile> | null>(resolve => {
          const input = doc.createElement('input');
          input.type = 'file'; input.multiple = true; input.webkitdirectory = true;
          input.oncancel = () => resolve(null);
          input.onchange = () => {
            const files = Array.from(input.files ?? []);
            if (!files.length) { resolve(null); return; }
            const map = new Map<string, AbaqusFile>();
            for (const file of files) {
              const parts = file.webkitRelativePath.split('/');
              const name = parts.length > 1 ? parts.slice(1).join('/') : file.name;
              map.set(name, { name, size: file.size, read: async () => new Uint8Array(await file.arrayBuffer()) });
            }
            resolve(map);
          };
          input.click();
        });
        if (selected === null) return null;
        includeFolder = selected;
      }
      const selected = includeFolder;
      return paths.flatMap(path => { const file = selected.get(path); return file ? [file] : []; });
    },
    read: async path => {
      if (!folder) throw new FemError('file.scope', 'no project folder is open', 'path', 'folder.open before importing a relative path, or use picker/inline text');
      const file = await folder.readFile(path);
      return { name: file.name, size: file.size, read: async () => new Uint8Array(await file.arrayBuffer()) };
    },
    sha256: async bytes => {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
      return [...digest].map(value => value.toString(16).padStart(2, '0')).join('');
    },
  };
}
