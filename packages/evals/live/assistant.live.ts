import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { openaiProvider, type Provider } from '../../app/src/ai/eval-api';
import { BrowserEvalAdapter, McpEvalAdapter } from '../src/adapters';
import { EVAL_CASES } from '../src/cases';
import { markdownReport } from '../src/report';
import { runLane, serializeArtifact, type EvaluationArtifact } from '../src/runner';

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
  const appUrl = process.env['FEMLAB_EVAL_APP_URL'] ?? '';
  const mcpEntry = process.env['FEMLAB_EVAL_MCP_ENTRY'] ?? '';
  const appDir = process.env['FEMLAB_EVAL_APP_DIR'];
  const nodeWasm = process.env['FEMLAB_EVAL_NODE_WASM'];
  const mcpPackage = process.env['FEMLAB_EVAL_MCP_PACKAGE'];
  if (key && (!appUrl || !mcpEntry || !appDir || !nodeWasm || !mcpPackage)) {
    throw new Error('live credentials require the app URL, MCP entry and all frozen artifact paths');
  }
  if (key && dirty) throw new Error('live evaluation requires a clean frozen commit');

  const browser = new BrowserEvalAdapter(appUrl, common);
  const mcp = new McpEvalAdapter(process.execPath, mcpEntry ? [mcpEntry] : [], root, common);
  // Preserve the fixed prompt order and avoid provider/host contention changing one lane's run.
  const lanes = [await runLane(browser), await runLane(mcp)];
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
      artifacts: {
        app: await fileHash(appDir),
        nodeWasm: await fileHash(nodeWasm),
        mcpPackage: await fileHash(mcpPackage),
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
});
