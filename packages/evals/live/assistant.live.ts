import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { openaiProvider, type Provider } from '../../app/src/ai/eval-api';
import { BrowserEvalAdapter, McpEvalAdapter } from '../src/adapters';
import { EVAL_CASES } from '../src/cases';
import { prepareFrozenBuild } from '../src/frozen-build';
import { markdownReport } from '../src/report';
import { runLane, serializeArtifact, type EvaluationArtifact } from '../src/runner';
import { assertInFrozenPackage, serveFrozenApp } from '../src/static-app';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function fileHash(target: string | undefined): Promise<string> {
  if (!target) return 'not-built';
  const info = await stat(target);
  if (info.isFile()) return sha(await readFile(target));
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const full = path.join(dir, name);
      if ((await stat(full)).isDirectory()) await walk(full);
      else files.push(full);
    }
  };
  await walk(target);
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(path.relative(target, file));
    digest.update(await readFile(file));
  }
  return digest.digest('hex');
}

async function artifactHashes(app: string | undefined, nodeWasm: string | undefined, mcpPackage: string | undefined, tarball: string | undefined) {
  return { app: await fileHash(app), nodeWasm: await fileHash(nodeWasm), mcpPackage: await fileHash(mcpPackage), mcpTarball: await fileHash(tarball) };
}

it('runs the fixed twenty problems through real browser and MCP hosts', async () => {
  const key = process.env['OPENAI_API_KEY'];
  const model = process.env['FEMLAB_EVAL_MODEL'] ?? 'gpt-5.6-sol';
  const startedAt = new Date().toISOString();
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== '';
  const unavailableProvider: Provider = {
    id: 'openai',
    models: [],
    async *chat() { throw new Error('provider credential unavailable'); },
  };
  const common = {
    provider: key ? openaiProvider(key) : unavailableProvider, credential: key, model,
    maxTokens: Number(process.env['FEMLAB_EVAL_MAX_TOKENS'] ?? 16_000),
    maxRounds: Number(process.env['FEMLAB_EVAL_MAX_ROUNDS'] ?? 20),
    timeoutMs: Number(process.env['FEMLAB_EVAL_TIMEOUT_MS'] ?? 600_000),
  };
  if (key && dirty) throw new Error('live evaluation requires a clean frozen commit');

  const build = key ? await prepareFrozenBuild(root) : null;
  try {
    const appDir = build?.appDirectory;
    const nodeWasm = build?.nodeWasm;
    const mcpPackage = build?.mcpPackageDirectory;
    const mcpEntry = build?.mcpEntry ?? '';
    const tarball = build?.tarball;
    if (build) await assertInFrozenPackage(build.mcpPackageDirectory, [build.mcpEntry, build.nodeWasm]);
    const before = await artifactHashes(appDir, nodeWasm, mcpPackage, tarball);
    const server = build ? await serveFrozenApp(build.appDirectory) : null;
    const browser = new BrowserEvalAdapter(server?.url ?? '', common);
    const mcp = new McpEvalAdapter(process.execPath, mcpEntry ? [mcpEntry] : [], root, common);
    let lanes;
    try {
      // Preserve fixed order and avoid provider/host contention changing one lane's run.
      lanes = [await runLane(browser), await runLane(mcp)];
    } finally {
      await server?.close();
    }
    const after = await artifactHashes(appDir, nodeWasm, mcpPackage, tarball);
    const stable = JSON.stringify(before) === JSON.stringify(after);
    const laneCapabilities = (host: 'browser' | 'mcp'): unknown =>
      lanes.find((lane) => lane.host === host)?.cases.find((score) => score.evidence.capabilities !== undefined)?.evidence.capabilities;
    const browserCapabilities = laneCapabilities('browser');
    const mcpCapabilities = laneCapabilities('mcp');
    const capabilities = (browserCapabilities ?? mcpCapabilities) as { engineVersion?: string; schemaVersion?: string } | undefined;
    const artifact: EvaluationArtifact = {
      format: 'femlab-assistant-eval/1',
      manifest: {
        gitCommit: commit,
        dirty,
        engineVersion: capabilities?.engineVersion ?? 'not-run',
        schemaVersion: capabilities?.schemaVersion ?? 'not-run',
        specificationSha256: sha(JSON.stringify(EVAL_CASES)),
        artifacts: { before, after, stable },
        provenance: {
          source: build ? 'built-from-clean-HEAD' : 'not-run',
          buildCommands: build?.commands ?? [],
          appServer: build ? 'runner-loopback' : 'not-run',
          mcp: build ? 'isolated-tarball-install' : 'not-run',
        },
        hosts: {
          browser: { capabilities: browserCapabilities ?? 'not-run' },
          mcp: { node: process.version, platform: process.platform, arch: process.arch, capabilities: mcpCapabilities ?? 'not-run' },
        },
        provider: 'openai',
        model,
        configuration: {
          providerControls: 'provider defaults; ChatRequest currently exposes model and maxTokens',
          maxTokens: common.maxTokens, maxRounds: common.maxRounds, timeoutMs: common.timeoutMs,
          node: process.version, platform: process.platform, arch: process.arch,
        },
        startedAt,
        finishedAt: new Date().toISOString(),
      },
      lanes,
    };
    const output = path.resolve(root, process.env['FEMLAB_EVAL_OUTPUT'] ?? 'docs/evaluations/results/latest.json');
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, serializeArtifact(artifact, [key ?? '']));
    await writeFile(output.replace(/\.json$/, '.md'), markdownReport(artifact));

    if (!key) {
      expect(lanes).toEqual([
        expect.objectContaining({ host: 'browser', status: 'not-run', reason: 'provider credential unavailable' }),
        expect.objectContaining({ host: 'mcp', status: 'not-run', reason: 'provider credential unavailable' }),
      ]);
      return;
    }
    expect(lanes.map((lane) => ({ host: lane.host, gatePassed: lane.gatePassed }))).toEqual([
      { host: 'browser', gatePassed: true },
      { host: 'mcp', gatePassed: true },
    ]);
    expect(stable, 'frozen app/MCP artifacts changed during the evaluation').toBe(true);
  } finally {
    await build?.close();
  }
});
