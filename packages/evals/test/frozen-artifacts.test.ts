import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { hashFrozenArtifacts, type FrozenBuild } from '../src/frozen-build';

it('detects isolated external dependency changes even when the MCP package and tarball are unchanged', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'femlab-artifact-test-'));
  const app = path.join(root, 'app'), dependencies = path.join(root, 'node_modules'), mcp = path.join(dependencies, 'femlab-mcp');
  try {
    await mkdir(app); await mkdir(mcp, { recursive: true }); await mkdir(path.join(dependencies, 'typescript'));
    const wasm = path.join(mcp, 'engine.wasm'), entry = path.join(mcp, 'index.js'), tarball = path.join(root, 'package.tgz'), lockfile = path.join(root, 'package-lock.json');
    await Promise.all([writeFile(path.join(app, 'index.html'), 'app'), writeFile(wasm, 'wasm'), writeFile(entry, 'entry'), writeFile(tarball, 'packed'), writeFile(lockfile, 'lock'), writeFile(path.join(dependencies, 'typescript/index.js'), 'old external')]);
    const build: FrozenBuild = { appDirectory: app, mcpPackageDirectory: mcp, mcpEntry: entry, nodeWasm: wasm, tarball, dependencyDirectory: dependencies, lockfile, commands: [], close: async () => undefined };
    const before = await hashFrozenArtifacts(build);
    await writeFile(path.join(dependencies, 'typescript/index.js'), 'changed external');
    const after = await hashFrozenArtifacts(build);
    expect(after.mcpPackage).toBe(before.mcpPackage); expect(after.mcpTarball).toBe(before.mcpTarball);
    expect(after.mcpDependencies).not.toBe(before.mcpDependencies);
    expect(after.mcpLock).toBe(before.mcpLock);
    await writeFile(lockfile, 'changed lock');
    expect((await hashFrozenArtifacts(build)).mcpLock).not.toBe(before.mcpLock);
    expect(Object.values(await hashFrozenArtifacts(null))).toEqual(Array(6).fill('not-built'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('separates filename and content boundaries in tree fingerprints', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'femlab-hash-boundary-'));
  const left = path.join(root, 'left'), right = path.join(root, 'right'), shared = path.join(root, 'shared');
  try {
    await Promise.all([mkdir(left), mkdir(right), mkdir(shared)]);
    const payload = path.join(shared, 'payload');
    // Undelimited path+content concatenation gives abcde for BOTH distinct trees.
    await Promise.all([writeFile(path.join(left, 'a'), 'bc'), writeFile(path.join(left, 'd'), 'e'), writeFile(path.join(right, 'ab'), 'c'), writeFile(path.join(right, 'd'), 'e'), writeFile(payload, 'common')]);
    const build: FrozenBuild = { appDirectory: left, mcpPackageDirectory: shared, mcpEntry: payload, nodeWasm: payload, tarball: payload, dependencyDirectory: shared, lockfile: payload, commands: [], close: async () => undefined };
    const before = await hashFrozenArtifacts(build);
    expect((await hashFrozenArtifacts({ ...build, appDirectory: right })).app).not.toBe(before.app);
  } finally { await rm(root, { recursive: true, force: true }); }
});
