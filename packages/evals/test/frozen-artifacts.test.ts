import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { hashFrozenArtifacts, type FrozenBuild } from '../src/frozen-build';

async function fixture(root: string): Promise<FrozenBuild> {
  const app = path.join(root, 'app'), dependencies = path.join(root, 'node_modules'), mcp = path.join(dependencies, 'femlab-mcp');
  await mkdir(app); await mkdir(mcp, { recursive: true }); await mkdir(path.join(dependencies, 'external'));
  const wasm = path.join(mcp, 'engine.wasm'), entry = path.join(mcp, 'index.js'), tarball = path.join(root, 'package.tgz'), lockfile = path.join(root, 'package-lock.json');
  const integrity = `sha512-${createHash('sha512').update('packed').digest('base64')}`;
  const lock = JSON.stringify({ lockfileVersion: 3, packages: {
    '': { dependencies: { 'femlab-mcp': `file:${tarball}` } },
    'node_modules/femlab-mcp': { version: '1.0.0', resolved: `file:${tarball}`, integrity },
    'node_modules/external': { version: '1.0.0', resolved: 'https://example.test/external.tgz', integrity: 'external-integrity' },
  } });
  await Promise.all([writeFile(path.join(app, 'index.html'), 'app'), writeFile(wasm, 'wasm'), writeFile(entry, 'entry'), writeFile(tarball, 'packed'), writeFile(lockfile, lock), writeFile(path.join(dependencies, '.package-lock.json'), lock), writeFile(path.join(dependencies, 'external/index.js'), 'external')]);
  return { appDirectory: app, mcpPackageDirectory: mcp, mcpEntry: entry, nodeWasm: wasm, tarball, dependencyDirectory: dependencies, lockfile, commands: [], close: async () => undefined };
}

it('fingerprints equivalent relocated runtimes equally while retaining raw lock provenance', async () => {
  const roots = await Promise.all([mkdtemp(path.join(tmpdir(), 'femlab-relocated-a-')), mkdtemp(path.join(tmpdir(), 'femlab-relocated-b-'))]);
  try {
    const [left, right] = await Promise.all(roots.map(fixture));
    // Exercise npm's relative spelling as well as an absolute owned path.
    for (const file of [right!.lockfile, path.join(right!.dependencyDirectory, '.package-lock.json')]) {
      const lock = JSON.parse(await readFile(file, 'utf8'));
      lock.packages['node_modules/femlab-mcp'].resolved = 'file:package.tgz';
      lock.packages[''].dependencies['femlab-mcp'] = 'file:package.tgz';
      await writeFile(file, JSON.stringify(lock));
    }
    const before = await readFile(right!.lockfile, 'utf8');
    expect(await readFile(left!.lockfile, 'utf8')).not.toBe(before);
    expect(await hashFrozenArtifacts(left!)).toEqual(await hashFrozenArtifacts(right!));
    expect(await readFile(right!.lockfile, 'utf8')).toBe(before);
    expect(Object.values(await hashFrozenArtifacts(null))).toEqual(Array(6).fill('not-built'));
  } finally { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); }
});

it('detects external runtime byte and lock version/integrity changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'femlab-external-'));
  try {
    const build = await fixture(root), before = await hashFrozenArtifacts(build);
    await writeFile(path.join(build.dependencyDirectory, 'external/index.js'), 'changed external');
    const after = await hashFrozenArtifacts(build);
    expect(after.mcpPackage).toBe(before.mcpPackage); expect(after.mcpTarball).toBe(before.mcpTarball);
    expect(after.mcpDependencies).not.toBe(before.mcpDependencies); expect(after.mcpLock).toBe(before.mcpLock);
    for (const field of ['version', 'integrity', 'resolved']) {
      for (const file of [build.lockfile, path.join(build.dependencyDirectory, '.package-lock.json')]) {
        const original = await readFile(file, 'utf8'), lock = JSON.parse(original);
        lock.packages['node_modules/external'][field] = 'changed';
        await writeFile(file, JSON.stringify(lock));
        const mutated = await hashFrozenArtifacts(build);
        expect(file === build.lockfile ? mutated.mcpLock : mutated.mcpDependencies).not.toBe(file === build.lockfile ? after.mcpLock : after.mcpDependencies);
        await writeFile(file, original);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('refuses to normalize unverified tarball integrity or a different local resolution', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'femlab-unverified-'));
  try {
    const build = await fixture(root);
    for (const file of [build.lockfile, path.join(build.dependencyDirectory, '.package-lock.json')]) {
      const original = await readFile(file, 'utf8'), lock = JSON.parse(original);
      lock.packages['node_modules/femlab-mcp'].integrity = 'sha512-unverified';
      await writeFile(file, JSON.stringify(lock));
      await expect(hashFrozenArtifacts(build)).rejects.toThrow('integrity mismatch');
      lock.packages['node_modules/femlab-mcp'].integrity = JSON.parse(original).packages['node_modules/femlab-mcp'].integrity;
      const other = path.join(root, 'other.tgz'); await writeFile(other, 'packed');
      lock.packages['node_modules/femlab-mcp'].resolved = `file:${other}`;
      await writeFile(file, JSON.stringify(lock));
      await expect(hashFrozenArtifacts(build)).rejects.toThrow('differs from owned tarball');
      await writeFile(file, original);
      const wrongRoot = JSON.parse(original);
      wrongRoot.packages[''].dependencies['femlab-mcp'] = `file:${other}`;
      await writeFile(file, JSON.stringify(wrongRoot));
      await expect(hashFrozenArtifacts(build)).rejects.toThrow('differs from owned tarball');
      await writeFile(file, original);
    }
    await writeFile(build.tarball, 'changed packed bytes');
    await expect(hashFrozenArtifacts(build)).rejects.toThrow('integrity mismatch');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('separates filename and content boundaries in tree fingerprints', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'femlab-hash-boundary-'));
  try {
    const build = await fixture(root), right = path.join(root, 'right'); await mkdir(right);
    await rm(path.join(build.appDirectory, 'index.html'));
    // Undelimited path+content concatenation gives abcde for BOTH distinct trees.
    await Promise.all([writeFile(path.join(build.appDirectory, 'a'), 'bc'), writeFile(path.join(build.appDirectory, 'd'), 'e'), writeFile(path.join(right, 'ab'), 'c'), writeFile(path.join(right, 'd'), 'e')]);
    expect((await hashFrozenArtifacts({ ...build, appDirectory: right })).app).not.toBe((await hashFrozenArtifacts(build)).app);
  } finally { await rm(root, { recursive: true, force: true }); }
});
