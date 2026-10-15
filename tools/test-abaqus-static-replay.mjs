#!/usr/bin/env node
// #503: independent static decks, exact native/WASM conversion and persisted Journal parity.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { batchModule } from './checked-batch.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const native = process.env.FEMLAB_NATIVE ?? path.join(root, 'target/release/femlab');
const { Engine } = batchModule(createRequire(import.meta.url)(path.join(root, 'tools/wasm-node/femlab_engine_wasm.js')));
const scratch = mkdtempSync(path.join(tmpdir(), 'femlab-abaqus-static-'));
const empty = path.join(scratch, 'empty.json');
writeFileSync(empty, '[]');

function request(text, unitLength) {
  return { query: 'query.convertAbaqus', mode: 'static', text, name: 'Independent static parity', body: 'bar', unitLength, unitForce: '1 N', sha256: createHash('sha256').update(text).digest('hex') };
}
function query(engine, input) { return JSON.parse(engine.query(JSON.stringify(input))); }
function nativeQueries(file, threads, queries) {
  return JSON.parse(execFileSync(native, ['run', file, '--cpu', '--threads', String(threads), '--verify', ...queries.flatMap(input => ['--query', JSON.stringify(input)])], { encoding: 'utf8' }));
}
function fieldsEqual(actual, expected) {
  assert.equal(actual.length, expected.length);
  for (let field = 0; field < actual.length; field++) {
    const { values: got, ...metadata } = actual[field];
    const { values: want, ...wantedMetadata } = expected[field];
    assert.deepEqual(metadata, wantedMetadata);
    assert.equal(got.length, want.length);
    const scale = Math.max(...want.map(Math.abs), Number.MIN_VALUE);
    for (let index = 0; index < got.length; index++) assert.ok(Math.abs(got[index] - want[index]) <= 1e-12 * scale, `${metadata.field}[${index}]`);
  }
}

try {
  for (const fixture of ['bar-hex-si.inp', 'bar-hex-mm-n.inp', 'bar-tet-si.inp', 'bar-tet-mm-n.inp']) {
    const original = readFileSync(path.join(root, 'crates/engine/tests/fixtures/abaqus-static', fixture), 'utf8');
    for (const signedZero of [false, true]) {
    const text = signedZero ? original
      .replace(',0\n*SOLID SECTION', ',-0\n*SOLID SECTION')
      .replace('101,0,0,0', '101,-0,-0,-0')
      .replace('ROOT,1,3\n', 'ROOT,1,3,-0\n')
      .replace('*END STEP', 'TIP,2,-0\nTIP,3,-0\n*END STEP') : original;
    if (signedZero) assert.notEqual(text, original);
    const conversionQuery = request(text, fixture.includes('mm-n') ? '1 mm' : '1 m');
    const engine = new Engine(1);
    try {
      const before = engine.export_file();
      const conversion = query(engine, conversionQuery);
      assert.equal(engine.export_file(), before, 'conversion cannot mutate the active document');
      assert.equal(conversion.report.sha256, conversionQuery.sha256);
      assert.equal(conversion.commands[2].mesher.provenance.sha256, conversionQuery.sha256);
      assert.equal(conversion.report.analysisConfigured, true);
      assert.equal(conversion.report.unitForce.value, 1);
      assert.equal(conversion.report.unitForce.unit, 'N');
      assert.equal(conversion.report.analysis.material, 'STEEL');
      assert.equal(conversion.report.analysis.step, 'AXIAL');
      assert.equal(conversion.report.analysis.finalEquilibriumOnly, true);
      assert.equal(conversion.commands[2].formulation, fixture.includes('hex') ? 'mean-dilatation' : 'full');
      assert.ok(conversion.commands.every(command => command.cmd !== 'solve.run'));
      assert.ok(!JSON.stringify(conversion.commands).includes('-0.0'));
      for (const threads of [1, 4]) assert.deepEqual(nativeQueries(empty, threads, [conversionQuery]), [conversion]);

      for (const command of conversion.commands) await engine.dispatch(JSON.stringify(command));
      await engine.dispatch(JSON.stringify({ cmd: 'model.setUnits', units: { length: 'm', stress: 'Pa', force: 'N' } }));
      assert.equal(query(engine, { query: 'query.results' }).records.length, 0);
      await engine.dispatch(JSON.stringify({ cmd: 'solve.run', step: 'AXIAL', solver: 'cpu-direct' }));
      const probe = query(engine, { query: 'query.probe', step: 'AXIAL', field: 'displacement', component: 0, at: ['1 m', '0.05 m', '0.05 m'] });
      assert.equal(probe.value.unit, 'm');
      assert.ok(Math.abs(probe.value.value - 5e-7) < 1e-16, fixture);
      const queries = ['displacement', 'stress', 'reaction'].map(field => ({ query: 'query.field', step: 'AXIAL', field }));
      const expected = queries.map(input => query(engine, input));
      for (let index = 0; index < expected[1].values.length; index += 6) assert.ok(Math.abs(expected[1].values[index] - 1e5) < 1e-6);
      const reaction = expected[2].values.filter((_, index) => index % 3 === 0).reduce((sum, value) => sum + value, 0);
      assert.ok(Math.abs(reaction + 1000) < 1e-8);

      const model = JSON.parse(engine.export_file());
      const entriesPath = path.join(scratch, 'journal.json');
      const modelPath = path.join(scratch, 'model.json');
      writeFileSync(entriesPath, JSON.stringify(model.journal.entries));
      writeFileSync(modelPath, JSON.stringify(model));
      const hashes = model.journal.entries.map(entry => entry.hashAfter);
      let nativeFields;
      // Only portable Commands or a Model file reach replay; the original .inp is absent.
      for (const threads of [1, 4]) {
        for (const source of [entriesPath, modelPath]) {
          const actualHashes = execFileSync(native, ['run', source, '--cpu', '--threads', String(threads), '--verify', '--hashes'], { encoding: 'utf8' }).trim().split(/\r?\n/);
          assert.deepEqual(actualHashes, hashes);
          const actual = nativeQueries(source, threads, queries);
          if (nativeFields) assert.deepEqual(actual, nativeFields, 'native fields must be bit-identical at 1/4 threads');
          nativeFields = actual;
          fieldsEqual(actual, expected);
        }
      }
      assert.deepEqual(JSON.parse(await engine.replay_hashes(JSON.stringify(model.journal.entries), false, true)), hashes);
      fieldsEqual(queries.map(input => query(engine, input)), expected);

      const badText = text.replace('*END STEP', '*USER ELEMENT\n*END STEP');
      const bad = request(badText, conversionQuery.unitLength);
      const installed = engine.export_file();
      let failure;
      try { query(engine, bad); } catch (error) { failure = error; }
      assert.equal(failure?.code, 'unsupported');
      assert.equal(engine.export_file(), installed);
      const nativeFailure = spawnSync(native, ['run', entriesPath, '--cpu', '--query', JSON.stringify(bad)], { encoding: 'utf8' });
      assert.equal(nativeFailure.status, 1);
      const error = JSON.parse(nativeFailure.stderr.trim());
      for (const field of ['code', 'cause', 'where', 'suggestion']) assert.equal(error[field], failure[field]);
      fieldsEqual(queries.map(input => query(engine, input)), expected);
      console.log(`${fixture}${signedZero ? ' with semantic -0' : ''}: SI analytical displacement/stress/reaction, exact conversion and source-independent native1/4-thread/WASM replay passed.`);
    } finally { engine.free(); }
    }
  }
} finally { rmSync(scratch, { recursive: true }); }
