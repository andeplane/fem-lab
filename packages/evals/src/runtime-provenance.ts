import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FrozenBuild } from './frozen-build';

/** Raw install receipts are durable evidence, never semantic resume identity. */
export async function retainRuntimeLocks(build: Pick<FrozenBuild, 'lockfile' | 'dependencyDirectory'>, destination: string): Promise<{ file: string; sha256: string }[]> {
  const sources = [{ file: 'package-lock.json', source: build.lockfile }, { file: 'node_modules.package-lock.json', source: path.join(build.dependencyDirectory, '.package-lock.json') }];
  const raw = await Promise.all(sources.map(async source => ({ ...source, bytes: await readFile(source.source) })));
  await mkdir(destination, { recursive: true });
  const receipts = [];
  for (const source of raw) {
    const file = path.join(destination, source.file);
    await writeFile(file, source.bytes, { flag: 'wx' });
    const sha256 = createHash('sha256').update(source.bytes).digest('hex');
    if (createHash('sha256').update(await readFile(file)).digest('hex') !== sha256) throw new Error('durable runtime lock readback differs');
    receipts.push({ file, sha256 });
  }
  await writeFile(path.join(destination, 'receipt.json'), `${JSON.stringify(receipts, null, 2)}\n`, { flag: 'wx' });
  return receipts;
}
