import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, stat, statfs, writeFile, mkdir, rename, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import { responseParameters, responsesProvider, type Provider } from '@femlab/ai';
import { expect, it } from 'vitest';
import { BrowserEvalAdapter, McpEvalAdapter } from '../src/adapters';
import { boundedProvider, EvaluationBudget, requireFreeDisk, restoreEvaluationBudget } from '../src/budget';
import { EVAL_CASES } from '../src/cases';
import { prepareFrozenBuild } from '../src/frozen-build';
import { markdownReport } from '../src/report';
import { runLane, serializeArtifact, type EvaluationArtifact, type FrozenManifest, type EvalAdapter } from '../src/runner';
import { laneResult } from '../src/score';
import { assertInFrozenPackage, serveFrozenApp } from '../src/static-app';
import type { LaneResult } from '../src/types';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function fileHash(target: string | undefined): Promise<string> {
  if (!target) return 'not-built';
  const info = await stat(target);
  if (info.isFile()) return sha(await readFile(target));
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
  for (const file of files) { digest.update(path.relative(target, file)); digest.update(await readFile(file)); }
  return digest.digest('hex');
}
async function artifactHashes(app?: string, nodeWasm?: string, mcpPackage?: string, tarball?: string) {
  return { app: await fileHash(app), nodeWasm: await fileHash(nodeWasm), mcpPackage: await fileHash(mcpPackage), mcpTarball: await fileHash(tarball) };
}

it('runs the fixed twenty problems through real browser and MCP hosts', async () => {
  const key = process.env['OPENAI_API_KEY'];
  const model = process.env['FEMLAB_EVAL_MODEL'] ?? 'gpt-5.6-sol';
  const startedAt = new Date().toISOString();
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== '';
  const limits = { model, maxUsd: Number(process.env['FEMLAB_EVAL_MAX_USD'] ?? 50), maxRequests: Number(process.env['FEMLAB_EVAL_MAX_REQUESTS'] ?? 400), maxInputTokens: Number(process.env['FEMLAB_EVAL_MAX_INPUT_TOKENS'] ?? 128_000) };
  const controls = { maxTokens: Number(process.env['FEMLAB_EVAL_MAX_TOKENS'] ?? 16_000), maxRounds: Number(process.env['FEMLAB_EVAL_MAX_ROUNDS'] ?? 20), timeoutMs: Number(process.env['FEMLAB_EVAL_TIMEOUT_MS'] ?? 600_000) };
  const maxWallMs = Number(process.env['FEMLAB_EVAL_MAX_WALL_MS'] ?? 5_400_000);
  if (![controls.maxTokens, controls.maxRounds, controls.timeoutMs, maxWallMs].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('invalid evaluation request/time limits');
  const resume = process.env['FEMLAB_EVAL_RESUME'];
  const previousBytes = resume ? await readFile(path.resolve(root, resume)) : undefined;
  const previous = previousBytes ? JSON.parse(previousBytes.toString()) as EvaluationArtifact : undefined;
  const sdkVersion = (JSON.parse(await readFile(path.join(root, 'node_modules/openai/package.json'), 'utf8')) as { version: string }).version;
  const configuration = { providerSdk: `openai@${sdkVersion}`, ...limits, ...controls, maxWallMs, minimumFreeGiB: 30, maxRetries: 0, serviceTier: 'default', reasoning: 'provider default', priceReference: 'https://developers.openai.com/api/docs/models/gpt-5.6-sol', priceVerified: '2026-10-15', node: process.version, platform: process.platform, arch: process.arch };
  if (previous && (previous.format !== 'femlab-assistant-eval/1' || previous.manifest.gitCommit !== commit || previous.manifest.dirty || previous.manifest.specificationSha256 !== sha(JSON.stringify(EVAL_CASES)) || previous.manifest.provider !== 'openai' || previous.manifest.model !== model || JSON.stringify(previous.manifest.configuration) !== JSON.stringify(configuration) || previous.lanes.some(lane => !lane.live) || !previous.controls || previous.controls.caseInFlight !== false)) throw new Error('checkpoint configuration or frozen source differs; start a new evaluation');
  const budget = previous ? restoreEvaluationBudget(limits, previous.controls?.budget) : new EvaluationBudget(limits);
  const runStartedAt = previous?.manifest.startedAt ?? startedAt;
  const resources = async () => {
    const disk = await statfs(root);
    requireFreeDisk(disk.bavail * disk.bsize, 30 * 2 ** 30);
    if (Date.now() - Date.parse(runStartedAt) > maxWallMs) throw new Error('evaluation wall-time limit reached');
  };
  let caseInFlight = false;
  let persistProgress: () => Promise<void> = async () => undefined;
  const beforeCase = async () => { budget.assertReady(); await resources(); caseInFlight = true; await persistProgress(); };
  const client = key ? new OpenAI({ apiKey: key, maxRetries: 0, timeout: 120_000 }) : null;
  const unavailableProvider: Provider = { id: 'openai', models: [], async *chat() { throw new Error('provider credential unavailable'); } };
  const provider = client ? boundedProvider(responsesProvider(client), budget, async request => {
    const { model: requestedModel, input, instructions, tools } = responseParameters(request);
    return (await client.responses.inputTokens.count({ model: requestedModel, input, instructions, tools }, { signal: request.signal })).input_tokens;
  }, resources, () => persistProgress()) : unavailableProvider;
  const common = { provider, credential: key, model, ...controls };
  const reuseSource = process.env['FEMLAB_EVAL_WASM_SOURCE_MANIFEST'];
  const reuseRuntime = process.env['FEMLAB_EVAL_WASM_RUNTIME_MANIFEST'];
  const reusedWasm = reuseSource && reuseRuntime ? { sourceManifest: reuseSource, runtimeManifest: reuseRuntime } : undefined;
  let unavailable: string | undefined = !key ? 'provider credential unavailable' : undefined;
  if (key && dirty) throw new Error('live evaluation requires a clean frozen commit');
  if (!unavailable && !reusedWasm && process.env['FEMLAB_EVAL_BUILD_ENGINE'] !== '1') unavailable = 'verified wasm receipts unavailable; supply both manifests or explicitly authorize an engine build';
  if (!unavailable) { try { await resources(); } catch (error) { unavailable = error instanceof Error ? error.message : String(error); } }
  const output = path.resolve(root, resume ?? process.env['FEMLAB_EVAL_OUTPUT'] ?? `docs/evaluations/results/${startedAt.replaceAll(':', '-')}.json`);
  await mkdir(path.dirname(output), { recursive: true });
  if (previousBytes) await copyFile(output, `${output}.before-resume-${Date.now()}`);
  else { try { await stat(output); throw new Error('evaluation output already exists; use a new path or explicit resume'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
  const build = !unavailable ? await prepareFrozenBuild(root, reusedWasm) : null;
  try {
    if (build) await assertInFrozenPackage(build.mcpPackageDirectory, [build.mcpEntry, build.nodeWasm]);
    const before = await artifactHashes(build?.appDirectory, build?.nodeWasm, build?.mcpPackageDirectory, build?.tarball);
    if (previous && JSON.stringify(previous.manifest.artifacts.before) !== JSON.stringify(before)) throw new Error('checkpoint app/MCP artifact hashes differ; start a new evaluation');
    const manifest: FrozenManifest = {
      gitCommit: commit, dirty, engineVersion: 'not-run', schemaVersion: 'not-run', specificationSha256: sha(JSON.stringify(EVAL_CASES)),
      artifacts: { before, after: before, stable: true },
      provenance: { source: build ? (build.wasmProvenance ? 'built-from-clean-HEAD-with-verified-wasm' : 'built-from-clean-HEAD') : 'not-run', buildCommands: build?.commands ?? [], ...(build?.wasmProvenance ? { wasmProvenance: build.wasmProvenance } : {}), appServer: build ? 'runner-loopback' : 'not-run', mcp: build ? 'isolated-tarball-install' : 'not-run' },
      hosts: { browser: { capabilities: 'not-run' }, mcp: { node: process.version, platform: process.platform, arch: process.arch, capabilities: 'not-run' } },
      provider: 'openai', model, configuration, startedAt: runStartedAt, finishedAt: startedAt,
    };
    const lanes: LaneResult[] = [];
    let persistence = Promise.resolve();
    const persist = async () => {
      manifest.finishedAt = new Date().toISOString();
      const artifact: EvaluationArtifact = { format: 'femlab-assistant-eval/1', manifest, lanes, controls: { budget: budget.snapshot(), resumedFromSha256: previousBytes ? sha(previousBytes) : null, caseInFlight } };
      const text = serializeArtifact(artifact, [key ?? '']);
      const markdown = markdownReport(artifact);
      persistence = persistence.then(async () => {
        const temporary = `${output}.${randomUUID()}.pending`;
        await writeFile(temporary, text, { flag: 'wx' });
        await rename(temporary, output);
        await writeFile(output.replace(/\.json$/, '') + '.md', markdown);
      });
      await persistence;
    };
    persistProgress = persist;
    const server = build ? await serveFrozenApp(build.appDirectory) : null;
    try {
      const preparationOnly = process.env['FEMLAB_EVAL_PREPARE_ONLY'] === '1';
      const browser = new BrowserEvalAdapter(server?.url ?? '', common);
      const mcp = new McpEvalAdapter(process.execPath, build ? [build.mcpEntry] : [], root, common);
      for (const adapter of [browser, mcp]) {
        const reason = unavailable ?? (preparationOnly ? 'preparation only; no generation requested' : undefined);
        const actual: EvalAdapter = reason ? { host: adapter.host, live: true, availability: async () => ({ available: false, reason }), execute: spec => adapter.execute(spec), close: () => adapter.close() } : adapter;
        const prior = previous?.lanes.find(lane => lane.host === actual.host);
        const lane = await runLane(actual, EVAL_CASES, { completed: prior?.cases, beforeCase, onCase: async scores => {
          caseInFlight = false;
          lanes[lanes.length] = { ...laneResult(actual.host, actual.live, [...scores]), status: 'interrupted', reason: 'evaluation in progress', gatePassed: false };
          await persist();
          lanes.pop();
        } });
        const stopped = budget.snapshot().stoppedReason;
        lanes.push(stopped ? { ...lane, status: 'interrupted', reason: stopped, total: 20, passRate: lane.passed / 20, gatePassed: false } : lane);
        await persist();
      }
    } finally { await server?.close(); }
    manifest.artifacts.after = await artifactHashes(build?.appDirectory, build?.nodeWasm, build?.mcpPackageDirectory, build?.tarball);
    manifest.artifacts.stable = JSON.stringify(before) === JSON.stringify(manifest.artifacts.after);
    for (const lane of lanes) {
      const capabilities = lane.cases.find(score => score.evidence.capabilities !== undefined)?.evidence.capabilities;
      if (capabilities) manifest.hosts[lane.host].capabilities = capabilities;
    }
    const capabilities = (manifest.hosts.browser.capabilities === 'not-run' ? manifest.hosts.mcp.capabilities : manifest.hosts.browser.capabilities) as { engineVersion?: string; schemaVersion?: string };
    manifest.engineVersion = capabilities.engineVersion ?? 'not-run'; manifest.schemaVersion = capabilities.schemaVersion ?? 'not-run';
    await persist();
    if (unavailable || process.env['FEMLAB_EVAL_PREPARE_ONLY'] === '1') { expect(lanes.every(lane => lane.status === 'not-run')).toBe(true); return; }
    expect(lanes.map(lane => ({ host: lane.host, status: lane.status, gatePassed: lane.gatePassed }))).toEqual([{ host: 'browser', status: 'completed', gatePassed: true }, { host: 'mcp', status: 'completed', gatePassed: true }]);
    expect(manifest.artifacts.stable, 'frozen app/MCP artifacts changed during evaluation').toBe(true);
  } finally { await build?.close(); }
});
