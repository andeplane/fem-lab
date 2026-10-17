import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { retainRuntimeLocks } from '../src/runtime-provenance';

it('retains exact outer and hidden lock bytes and hashes after the owned temporary installation is removed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'eval-provenance-test-'));
  const install = path.join(root, 'temporary'), durable = path.join(root, 'durable');
  try {
    await mkdir(path.join(install, 'node_modules'), { recursive: true });
    const outer = '{"resolved":"file:/random/owned/installation.tgz"}\n', hidden = '{"packages":{"external":{"version":"0.32.0"}}}\n';
    await writeFile(path.join(install, 'package-lock.json'), outer);
    await writeFile(path.join(install, 'node_modules/.package-lock.json'), hidden);
    const receipts = await retainRuntimeLocks({ lockfile: path.join(install, 'package-lock.json'), dependencyDirectory: path.join(install, 'node_modules') }, durable);
    await rm(install, { recursive: true });
    for (const [index, bytes] of [outer, hidden].entries()) {
      expect(await readFile(receipts[index]!.file, 'utf8')).toBe(bytes);
      expect(receipts[index]!.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
    expect(JSON.parse(await readFile(path.join(durable, 'receipt.json'), 'utf8'))).toEqual(receipts);
  } finally { await rm(root, { recursive: true, force: true }); }
});
