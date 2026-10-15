import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyReusedWasm, type ReusedWasm } from './frozen-reuse';

export interface FrozenBuild {
  appDirectory: string;
  mcpPackageDirectory: string;
  mcpEntry: string;
  nodeWasm: string;
  tarball: string;
  dependencyDirectory: string;
  lockfile: string;
  commands: string[];
  wasmProvenance?: Record<string, unknown>;
  close(): Promise<void>;
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 1_800_000, stdio: ['ignore', 'pipe', 'inherit'] });
}

/** Build HEAD, pack MCP, and install its actual tarball away from the checkout. */
export async function prepareFrozenBuild(root: string, reusedWasm?: ReusedWasm): Promise<FrozenBuild> {
  const directory = await mkdtemp(path.join(tmpdir(), 'femlab-assistant-build-'));
  const commands = [reusedWasm ? 'verify sealed source/schema/all eight reused wasm bindings' : 'node tools/build-wasm.mjs', 'npm run build -w packages/app', 'npm pack + isolated npm install packages/mcp'];
  try {
    const wasmProvenance = reusedWasm ? await verifyReusedWasm(root, reusedWasm, reference => run('git', ['diff', '--name-only', reference, '--', 'Cargo.lock', 'Cargo.toml', 'rust-toolchain.toml', 'crates'], root)) : undefined;
    if (!reusedWasm) run(process.execPath, ['tools/build-wasm.mjs'], root);
    run(npm, ['run', 'build', '-w', 'packages/app'], root);
    const packedOutput = run(npm, ['pack', '--json', '--pack-destination', directory], path.join(root, 'packages/mcp'));
    const start = packedOutput.lastIndexOf('\n[') + 1;
    const packed = JSON.parse(packedOutput.slice(start)) as { filename: string }[];
    if (packed.length !== 1) throw new Error(`expected one packed MCP artifact, got ${packed.length}`);
    const tarball = path.join(directory, packed[0]!.filename);
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'femlab-assistant-evaluation', private: true }));
    run(npm, ['install', '--omit=dev', '--no-audit', '--no-fund', tarball], directory);
    const installed = path.join(directory, 'node_modules/femlab-mcp');
    const manifest = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8')) as { bin?: Record<string, string> };
    const entry = manifest.bin?.['femlab-mcp'];
    if (entry === undefined) throw new Error('packed MCP package has no femlab-mcp executable');
    return {
      appDirectory: path.join(root, 'packages/app/dist'),
      mcpPackageDirectory: installed,
      mcpEntry: path.join(installed, entry),
      nodeWasm: path.join(installed, 'dist/wasm-node/femlab_engine_wasm_bg.wasm'),
      tarball,
      dependencyDirectory: path.join(directory, 'node_modules'),
      lockfile: path.join(directory, 'package-lock.json'),
      commands,
      ...(wasmProvenance ? { wasmProvenance } : {}),
      close: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function fileHash(target: string | undefined): Promise<string> {
  if (!target) return 'not-built';
  if ((await stat(target)).isFile()) return createHash('sha256').update(await readFile(target)).digest('hex');
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const full = path.join(directory, name);
      if ((await stat(full)).isDirectory()) await walk(full);
      else files.push(full);
    }
  };
  await walk(target);
  const digest = createHash('sha256');
  for (const file of files) {
    const contentHash = createHash('sha256').update(await readFile(file)).digest('hex');
    digest.update(path.relative(target, file)).update('\0').update(contentHash).update('\0');
  }
  return digest.digest('hex');
}

/** Include actual isolated externals and their resolution lock, not only the MCP package. */
export async function hashFrozenArtifacts(build: FrozenBuild | null) {
  const [app, nodeWasm, mcpPackage, mcpTarball, mcpDependencies, mcpLock] = await Promise.all([
    fileHash(build?.appDirectory), fileHash(build?.nodeWasm), fileHash(build?.mcpPackageDirectory),
    fileHash(build?.tarball), fileHash(build?.dependencyDirectory), fileHash(build?.lockfile),
  ]);
  return { app, nodeWasm, mcpPackage, mcpTarball, mcpDependencies, mcpLock };
}
