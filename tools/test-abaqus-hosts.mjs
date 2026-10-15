// Native disk import -> ordinary Model file -> independent native/WASM replay and explicit solve.
// Run with the built CLI path: node tools/test-abaqus-hosts.mjs target/debug/femlab
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
if (!process.argv[2]) throw new Error('pass the built native femlab executable as the first argument');
const binary = path.resolve(process.argv[2]);
const scratch = mkdtempSync(path.join(tmpdir(), 'femlab-504-parity-'));
const run = args => {
  const output = spawnSync(binary, args, { encoding: 'utf8' });
  assert.equal(output.status, 0, output.stderr || output.error?.message);
  return JSON.parse(output.stdout);
};
const close = (actual, expected, tolerance) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const check = (result, field) => {
  const ux = result.extremes.find(row => row.field === 'displacement' && row.component === 0);
  assert.equal(ux.max.unit, 'm'); close(ux.max.value, 5e-7, 1e-14);
  close(result.reactions.reduce((sum, row) => sum + row.total[0].value, 0), -1000, 1e-7);
  assert.equal(result.stale, false); assert.equal(field.unit, 'Pa');
  assert.equal(field.components, 6);
  assert.ok(field.values.length > 0 && field.values.length % field.components === 0);
  for (let offset = 0; offset < field.values.length; offset += field.components) {
    close(field.values[offset], 1e5, 1e-5);
    for (let component = 1; component < field.components; component++) close(field.values[offset + component], 0, 1e-5);
  }
};

try {
  const source = path.join(scratch, 'independent-bar.inp');
  const saved = path.join(scratch, 'bar.femlab.json');
  const original = readFileSync(path.join(root, 'crates/engine/tests/fixtures/abaqus-static/bar-hex-mm-n.inp'), 'utf8');
  const material = original.indexOf('*MATERIAL');
  assert.ok(material > 0);
  const mesh = original.slice(0, material) + '*INCLUDE,INPUT=Material.inp\n';
  const physics = original.slice(material);
  const input = '** Independently authored multi-file bar\n*INCLUDE,INPUT=Parts/Mesh.inc\n';
  mkdirSync(path.join(scratch, 'Parts'));
  writeFileSync(source, input);
  writeFileSync(path.join(scratch, 'Parts/Mesh.inc'), mesh);
  writeFileSync(path.join(scratch, 'Material.inp'), physics);
  const digest = createHash('sha256').update(readFileSync(source)).digest('hex');
  const report = run(['import-inp', source, '--out', saved, '--name', 'cross-host import', '--body', 'bar', '--mode', 'static', '--unit-length', '1 mm', '--unit-force', '1 N', '--unit-time', '1 s', '--threads', '1', '--cpu']);
  assert.equal(report.sha256, digest); assert.equal(report.analysis.step, 'AXIAL');
  assert.equal(report.inputBytes, Buffer.byteLength(input) + Buffer.byteLength(mesh) + Buffer.byteLength(physics));
  const bytes = readFileSync(saved, 'utf8');
  assert.ok(Buffer.byteLength(bytes) <= 16 * 1024 * 1024);
  assert.ok(!bytes.includes(source)); assert.ok(!bytes.includes('*NODE'));
  const file = JSON.parse(bytes); assert.equal(file.format, 'femlab/1');
  const sourceCommand = file.journal.entries.find(entry => entry.cmd.cmd === 'mesh.set').cmd;
  for (const [name, text] of [['Parts/Mesh.inc', mesh], ['Material.inp', physics]]) {
    assert.equal(sourceCommand.mesher.provenance.sourceFiles[name], createHash('sha256').update(text).digest('hex'));
  }
  rmSync(source);
  rmSync(path.join(scratch, 'Parts'), { recursive: true });
  rmSync(path.join(scratch, 'Material.inp')); // Neither subsequent host has any original source files.
  const [nativeModel, nativeMesh] = run(['run', saved, '--cpu', '--threads', '1', '--query', '{"query":"query.model"}', '--query', '{"query":"query.mesh"}']);
  assert.equal(nativeModel.steps[0].solved, false);
  assert.equal(nativeMesh.nodes, 12); assert.equal(nativeMesh.elements, 2);
  const solve = { cmd: 'solve.run', step: 'AXIAL', solver: 'cpu-direct' };
  const commands = file.journal.entries.map(entry => entry.cmd);
  const script = path.join(scratch, 'explicit-solve.json');
  writeFileSync(script, JSON.stringify([...commands, solve]));
  const [nativeResult, nativeStress] = run(['run', script, '--cpu', '--threads', '1', '--query', '{"query":"query.result","step":"AXIAL"}', '--query', '{"query":"query.field","step":"AXIAL","field":"stress"}']);
  check(nativeResult, nativeStress);

  const wasm = createRequire(import.meta.url)(path.join(root, 'tools/wasm-node/femlab_engine_wasm.js'));
  const owner = new wasm.SessionEngine(1, 'abaqus-host-parity');
  let stamp = JSON.parse(owner.stamp());
  let lease = JSON.parse(owner.begin_run(JSON.stringify(stamp.session)));
  let operation = 0;
  const context = () => ({ session: stamp.session, runId: lease.runId, operationId: String(++operation) });
  const ticket = owner.begin_replacement(JSON.stringify(context()), stamp.stateVersion);
  const candidate = await wasm.PreparedEngine.create(ticket, { threads: 1, gpu: false });
  await candidate.file(bytes);
  candidate.finish(compact => `${JSON.stringify(JSON.parse(compact), null, 2)}\n`, 16 * 1024 * 1024);
  const snapshot = JSON.parse(owner.commit_candidate(candidate));
  stamp = snapshot.stamp; lease = { ...lease, stamp };
  assert.equal(snapshot.model.hash, nativeModel.hash);
  assert.equal(snapshot.model.steps[0].solved, false);
  const reply = JSON.parse(await owner.dispatch(JSON.stringify({ context: context(), expectedVersion: stamp.stateVersion, command: solve })));
  stamp = reply.stamp; lease = { ...lease, stamp };
  const query = input => JSON.parse(owner.query(JSON.stringify({ context: context(), query: input }))).value;
  const result = query({ query: 'query.result', step: 'AXIAL' });
  check(result, query({ query: 'query.field', step: 'AXIAL', field: 'stress' }));
  assert.equal(query({ query: 'query.model' }).hash, nativeModel.hash);
  owner.cancel_run(JSON.stringify(stamp.session), lease.runId); owner.free();
  console.log('Native CLI nested-include import and source-free native/WASM replay verified: 12 nodes, 2 Hex8, ux=5e-7 m, stress xx=1e5 Pa, root force=-1000 N.');
} finally { rmSync(scratch, { recursive: true, force: true }); }
