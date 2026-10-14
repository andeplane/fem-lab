// Node owns scoped disk access. The registry receives only metadata, a bounded byte reader,
// and a digest function; converted Models never retain the source path.
import { FemError, MAX_ABAQUS_BYTES, assertInside, type AbaqusIo } from '@femlab/registry';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

async function scopedFile(root: string | undefined, input: string): Promise<string> {
  if (root === undefined) throw new FemError('file.scope', 'this server has no project folder', 'path', 'start it with --project <dir>, or import inline text');
  const segments = assertInside(input);
  const realRoot = await realpath(root);
  const parent = await realpath(path.join(realRoot, ...segments.slice(0, -1)));
  if (parent !== realRoot && !parent.startsWith(realRoot + path.sep)) {
    throw new FemError('file.scope', 'the input path leaves the project folder through a link', 'path', 'read a regular .inp file inside the project folder');
  }
  const full = path.join(parent, segments.at(-1)!);
  const info = await lstat(full);
  if (!info.isFile() || info.isSymbolicLink()) throw new FemError('file.scope', 'the input is not a regular file', 'path', 'read a regular .inp file inside the project folder');
  return full;
}

/** A changed file cannot force an unbounded read allocation after metadata was checked. */
async function bytes(full: string): Promise<Uint8Array> {
  const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const output = new Uint8Array(MAX_ABAQUS_BYTES + 1);
    let used = 0;
    while (used < output.byteLength) {
      const { bytesRead } = await handle.read(output, used, output.byteLength - used, null);
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    return output.slice(0, used);
  } finally { await handle.close(); }
}

export function nodeAbaqusIo(root: string | undefined): AbaqusIo {
  return {
    pick: async () => { throw new FemError('unsupported', 'the headless MCP host has no file picker', 'picker', 'supply inline text or a path inside --project'); },
    read: async input => {
      const full = await scopedFile(root, input);
      const info = await lstat(full);
      return { name: path.basename(input), size: info.size, read: async () => bytes(await scopedFile(root, input)) };
    },
    sha256: async data => createHash('sha256').update(data).digest('hex'),
  };
}
