#!/usr/bin/env node
// Install the actual npm tarball outside the checkout and exercise its installed stdio binary.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  for (const file of ['dist/femlab-mcp.js', 'dist/script-worker.js', 'dist/script-validation-worker.js', 'dist/wasm-node/femlab_engine_wasm.js', 'dist/wasm-node/femlab_engine_wasm_bg.wasm', 'dist/wasm-node/package.json']) {
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
  const helperManifest = JSON.parse(readFileSync(path.join(installed, 'dist/project-io/manifest.json'), 'utf8'));
  if (process.env.FEMLAB_RELEASE_HELPERS === 'all') assert.equal(Object.keys(helperManifest).length, 4, 'release must contain all four native helper targets');
  for (const [relative, expected] of Object.entries(helperManifest)) {
    assert.equal(hash(path.join(installed, 'dist/project-io', relative)), expected, `helper payload changed: ${relative}`);
  }
  assert(Object.keys(helperManifest).some(name => name.startsWith(`${process.platform}-${process.arch}/`)), 'installed host helper is missing');

  assert.equal(hash(path.join(installed, 'dist/wasm-node/femlab_engine_wasm_bg.wasm')), hash(path.join(root, 'tools/wasm-node/femlab_engine_wasm_bg.wasm')));
  // No inherited FEMLAB_WASM, NODE_PATH or NODE_OPTIONS can make the checkout rescue this package.
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  client = new Client({ name: 'installed-package-smoke', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(installed, manifest.bin['femlab-mcp']), '--project', directory], cwd: directory, env, stderr: 'inherit' }));
  const { tools } = await client.listTools();
  const names = new Set(tools.map(({ name }) => name));
  for (const name of ['query_model', 'model_new', 'run_script', 'validate_script', 'file_importAbaqus']) assert(names.has(name), `missing installed tool ${name}`);
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    return JSON.parse(response.content[0].text);
  };
  await call('model_new', { name: 'installed artifact' });
  assert.equal((await call('query_model', {})).name, 'installed artifact');
  const beforeValidation = await call('query_journal', {});
  const invalid = await call('validate_script', { code: 'await fem.geometry.addBox({name: "invalid", size: [false, "1 m", "1 m"]});' });
  assert.equal(invalid.ok, false);
  assert(invalid.diagnostics.length > 0, 'installed validation worker must return diagnostics');
  const valid = await call('validate_script', { code: 'const m = await fem.query.model(); return m.name;' });
  assert.equal(valid.ok, true, JSON.stringify(valid));
  assert.deepEqual(await call('query_journal', {}), beforeValidation, 'validation must not mutate the installed engine');
  const script = await call('run_script', { code: 'const m = await fem.query.model(); return m.name;' });
  assert.equal(script.error, undefined);
  assert.equal(script.result, 'installed artifact');
  // The SDK validated listTools above. The provider-facing object projection does not relax
  // the original mode/Force/source constraints used by actual installed dispatch.
  const meshText = readFileSync(path.join(root, 'crates/engine/tests/fixtures/abaqus/sparse-label-tet.inp'), 'utf8');
  const staticText = readFileSync(path.join(root, 'crates/engine/tests/fixtures/abaqus-static/bar-hex-mm-n.inp'), 'utf8');
  const meshArgs = { name: 'installed mesh', body: 'tet', mode: 'mesh', unitLength: '1 cm', text: meshText };
  const staticArgs = { name: 'installed static', body: 'bar', mode: 'static', unitLength: '1 mm', text: staticText };
  for (const args of [staticArgs, { ...meshArgs, unitForce: '1 N' }, { ...meshArgs, path: 'conflicting.inp' }]) {
    const rejected = await client.callTool({ name: 'file_importAbaqus', arguments: args });
    assert.equal(rejected.isError, true, JSON.stringify(rejected));
    assert.equal(JSON.parse(rejected.content[0].text).code, 'schema');
    assert.deepEqual(await call('query_journal', {}), beforeValidation, 'rejected imports must preserve the installed engine');
  }
  const meshImport = await call('file_importAbaqus', meshArgs);
  assert.deepEqual(meshImport.report.sourceLabels.unusedNodes, [99]);
  assert.equal(meshImport.report.analysisConfigured, false);
  assert.deepEqual((await call('query_model', {})).steps, []);
  assert.equal((await call('query_mesh', {})).nodes, 4);
  writeFileSync(path.join(directory, 'input.inp'), meshText);
  const diskMeshArgs = { ...meshArgs, path: 'input.inp' };
  delete diskMeshArgs.text;
  await call('file_importAbaqus', diskMeshArgs);
  await call('export_file', { format: 'journal', path: 'nested/output.femlab.json' });
  assert.equal(JSON.parse(readFileSync(path.join(directory, 'nested/output.femlab.json'), 'utf8')).format, 'femlab/1');
  const staticImport = await call('file_importAbaqus', { ...staticArgs, unitForce: '1 N' });
  assert.equal(staticImport.report.analysisConfigured, true);
  assert.equal((await call('query_model', {})).steps[0].solved, false);
  // Named-material regressions: the installed tool must preserve the entire selected
  // catalogue definition, then survive a real saved Journal replay without a provider call.
  assert(names.has('material_addFromLibrary'), 'installed catalogue application tool is missing');
  for (const [entry, expected] of [
    ['s355j2', { E: '210 GPa', nu: 0.3, rho: '7850 kg/m^3', alpha: '0.000012 1/K', yield: '355 MPa' }],
    ['6061-t6-sheet', { E: '68.3 GPa', nu: 0.33, rho: '2710 kg/m^3', alpha: '0.0000227 1/K', k: '152 W/(m K)', cp: '879 J/(kg K)', yield: '248 MPa' }],
  ]) {
    await call('model_new', { name: entry });
    const catalogue = await call('query_materialLibrary', { name: entry });
    const validation = await call('validate_script', { code: `await fem.material.addFromLibrary({ entry: '${entry}', name: 'material' });` });
    assert.equal(validation.ok, true, JSON.stringify(validation));
    await call('material_addFromLibrary', { entry, name: 'material' });
    const before = await call('query_model', {});
    const journal = await call('query_journal', {});
    assert.deepEqual(journal.entries.at(-1).cmd, { cmd: 'material.add', name: 'material', source: catalogue.entries[0].materialAddSource, ...expected });
    await call('export_file', { format: 'journal', path: `${entry}.femlab.json` });
    const saved = JSON.parse(readFileSync(path.join(directory, `${entry}.femlab.json`), 'utf8'));
    assert.deepEqual(saved.journal.entries, journal.entries);
    await call('model_new', { name: 'replacement' });
    for (const row of saved.journal.entries) {
      const { cmd, ...args } = row.cmd;
      await call(cmd.replaceAll('.', '_'), args);
    }
    const restored = await call('query_model', {});
    assert.deepEqual(restored.materials, before.materials);
    assert.equal(restored.hash, before.hash);
  }
  // Release publication consumes the exact tarball that this process installed and tested.
  if (process.argv[2]) {
    const destination = path.resolve(process.argv[2]);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(directory, packed.filename), destination);
  }
  console.log(`Installed ${packed.filename}: stdio tools, strict Abaqus modes, engine, worker script and exact WASM payload passed`);
} finally {
  await client?.close();
  rmSync(directory, { recursive: true, force: true });
}
