import { ABAQUS_ACCEPT, FemError, type AbaqusFile, type AbaqusIo } from '@femlab/registry';
import type { ProjectFolder } from './ai/project';

/** The caller captures the folder at admission, before a file picker or disk read awaits. */
export function browserAbaqusIo(doc: Pick<Document, 'createElement'>, crypto: Pick<Crypto, 'subtle'>, folder: ProjectFolder | null): AbaqusIo {
  return {
    pick: () => new Promise<AbaqusFile | null>(resolve => {
      const input = doc.createElement('input');
      input.type = 'file'; input.accept = ABAQUS_ACCEPT;
      input.oncancel = () => resolve(null);
      input.onchange = () => {
        const file = input.files?.[0];
        resolve(file ? { name: file.name, size: file.size, read: async () => new Uint8Array(await file.arrayBuffer()) } : null);
      };
      input.click();
    }),
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
