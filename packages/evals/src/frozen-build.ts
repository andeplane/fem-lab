import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface FrozenBuild {
  appDirectory: string;
  mcpPackageDirectory: string;
  mcpEntry: string;
  nodeWasm: string;
  tarball: string;
  commands: string[];
  close(): Promise<void>;
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 1_800_000, stdio: ['ignore', 'pipe', 'inherit'] });
}

/** Build HEAD, pack MCP, and install its actual tarball away from the checkout. */
export async function prepareFrozenBuild(root: string): Promise<FrozenBuild> {
  const directory = await mkdtemp(path.join(tmpdir(), 'femlab-assistant-build-'));
  const commands = ['node tools/build-wasm.mjs', 'npm run build -w packages/app', 'npm pack + isolated npm install packages/mcp'];
  try {
    run(process.execPath, ['tools/build-wasm.mjs'], root);
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
      commands,
      close: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
