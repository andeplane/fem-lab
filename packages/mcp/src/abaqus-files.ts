// Node owns scoped disk access. The registry receives only metadata, a bounded byte reader,
// and a digest function; converted Models never retain the source path.
import { FemError, type AbaqusIo } from '@femlab/registry';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { nodeProjectFiles, type ProjectFiles } from './project-files';

export function nodeAbaqusIo(root: string | undefined, files: ProjectFiles = nodeProjectFiles(root)): AbaqusIo {
  return {
    pick: async () => { throw new FemError('unsupported', 'the headless MCP host has no file picker', 'picker', 'supply inline text or a path inside --project'); },
    read: async input => {
      const size = await files.size(input);
      return { name: path.basename(input), size, read: () => files.read(input) };
    },
    sha256: async data => createHash('sha256').update(data).digest('hex'),
  };
}
