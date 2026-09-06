#!/usr/bin/env node
// Install the actual npm tarball outside the checkout and exercise its installed stdio binary.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'packages/mcp/package.json'));
const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'));
const { StdioClientTransport } = await import(require.resolve('@modelcontextprotocol/sdk/client/stdio.js'));
const directory = mkdtempSync(path.join(tmpdir(), 'femlab-installed-mcp-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const runNpm = (args, cwd) => execFileSync(npm, args, { cwd, encoding: 'utf8', timeout: 180_000 });
let client;
try {
  const output = runNpm(['pack', '--json', '--pack-destination', directory], path.join(root, 'packages/mcp'));
  // Lifecycle scripts may write before npm's final JSON array, even with --json.
  const [packed] = JSON.parse(output.slice(output.lastIndexOf('\n[') + 1));
  const files = new Set(packed.files.map(({ path }) => path));
  for (const file of ['dist/femlab-mcp.js', 'dist/script-worker.js', 'dist/wasm-node/femlab_engine_wasm.js', 'dist/wasm-node/femlab_engine_wasm_bg.wasm', 'dist/wasm-node/package.json']) {
    assert(files.has(file), `tarball is missing ${file}`);
  }
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'isolated-mcp-smoke', private: true }));
  runNpm(['install', '--omit=dev', '--no-audit', '--no-fund', path.join(directory, packed.filename)], directory);
  const installed = path.join(directory, 'node_modules/femlab-mcp');
  assert(realpathSync(installed).startsWith(realpathSync(directory) + path.sep), 'must be an installed copy, not a workspace link');
  const manifest = JSON.parse(readFileSync(path.join(installed, 'package.json'), 'utf8'));
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    assert(!name.startsWith('@femlab/'), `private workspace dependency leaked: ${name}`);
    assert(!/^(file:|workspace:)/.test(version), `local dependency leaked: ${name}`);
  }
  const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
  assert.equal(hash(path.join(installed, 'dist/wasm-node/femlab_engine_wasm_bg.wasm')), hash(path.join(root, 'tools/wasm-node/femlab_engine_wasm_bg.wasm')));
  // No inherited FEMLAB_WASM, NODE_PATH or NODE_OPTIONS can make the checkout rescue this package.
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  client = new Client({ name: 'installed-package-smoke', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(installed, manifest.bin['femlab-mcp'])], cwd: directory, env, stderr: 'inherit' }));
  const { tools } = await client.listTools();
  const names = new Set(tools.map(({ name }) => name));
  for (const name of ['query_model', 'model_new', 'run_script']) assert(names.has(name), `missing installed tool ${name}`);
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    return JSON.parse(response.content[0].text);
  };
  await call('model_new', { name: 'installed artifact' });
  assert.equal((await call('query_model', {})).name, 'installed artifact');
  const script = await call('run_script', { code: 'const m = await fem.query.model({}); return m.name;' });
  assert.equal(script.error, undefined);
  assert.equal(script.result, 'installed artifact');
  console.log(`Installed ${packed.filename}: stdio tools, engine, worker script and exact WASM payload passed`);
} finally {
  await client?.close();
  rmSync(directory, { recursive: true, force: true });
}
