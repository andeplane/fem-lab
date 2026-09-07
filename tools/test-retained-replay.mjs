#!/usr/bin/env node
import { batchModule } from './checked-batch.mjs';
// #282: the registry Query is shared by native and WASM; transfers own only staging arrays.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const native = process.env.FEMLAB_NATIVE ?? path.join(root, 'target/release/femlab');
const { Engine } = batchModule(createRequire(import.meta.url)(path.join(root, 'tools/wasm-node/femlab_engine_wasm.js')));
const scratch = mkdtempSync(path.join(tmpdir(), 'femlab-retained-replay-'));
const engine = new Engine(1);
const query = q => JSON.parse(engine.query(JSON.stringify(q)));
const dispatch = async command => engine.dispatch(JSON.stringify(command));
try {
  for (const command of [
    { cmd: 'model.new', name: 'retained Fourier bar' },
    { cmd: 'geometry.addBox', name: 'bar', size: ['1 m', '0.1 m', '0.1 m'] },
    { cmd: 'material.add', name: 'steel', E: '210 GPa', nu: 0.3, k: '45 W/(m K)' },
    { cmd: 'material.assign', material: 'steel', bodies: ['bar'] },
    { cmd: 'constraint.temperature', name: 'cold', on: 'bar.xmin', value: '0 degC' },
    { cmd: 'load.heatFlux', name: 'hot', on: 'bar.xmax', q: '1000 W/m^2' },
    { cmd: 'step.add', name: 'heat', procedure: 'heat-steady', constraints: ['cold'], loads: ['hot'] },
  ]) await dispatch(command);
  const ids = [];
  for (const [nx, order, x] of [[3, 1, 0], [4, 2, 0.5]]) {
    await dispatch({ cmd: 'geometry.addBox', name: 'bar', size: ['1 m', '0.1 m', '0.1 m'], at: [`${x} m`, '0 m', '0 m'] });
    await dispatch({ cmd: 'mesh.set', mesher: { kind: 'lattice', size: { nx, ny: 1, nz: 1 } }, order });
    await dispatch({ cmd: 'solve.run', step: 'heat', solver: 'cpu-direct' });
    ids.push(query({ query: 'query.result' }).resultId);
  }
  const queries = ids.flatMap(resultId => [
    { query: 'query.surface', resultId },
    { query: 'query.field', resultId, field: 'temperature' },
  ]);
  for (const onto of ['left', 'right']) queries.push({ query: 'query.difference', left: { resultId: ids[0], field: 'temperature' }, right: { resultId: ids[1], field: 'temperature' }, onto });
  const expected = queries.map(query);
  const entries = JSON.parse(engine.export_file()).journal.entries;
  const file = path.join(scratch, 'retained.json');
  writeFileSync(file, JSON.stringify(entries));
  for (const threads of [1, 4]) {
    const args = ['run', file, '--cpu', '--threads', String(threads), '--verify'];
    const hashes = execFileSync(native, [...args, '--hashes'], { encoding: 'utf8' }).trim().split(/\r?\n/);
    assert.deepEqual(hashes, entries.map(e => e.hashAfter));
    const actual = JSON.parse(execFileSync(native, [...args, ...queries.flatMap(q => ['--query', JSON.stringify(q)])], { encoding: 'utf8' }));
    for (let i = 0; i < actual.length; i++) {
      if (queries[i].query === 'query.surface') {
        assert.deepEqual(actual[i], expected[i]);
        continue;
      }
      const { values, ...metadata } = actual[i];
      const { values: wasmValues, ...wasmMetadata } = expected[i];
      assert.deepEqual(metadata, wasmMetadata);
      assert.equal(values.length, wasmValues.length);
      for (let j = 0; j < values.length; j++) {
        if (values[j] === null || wasmValues[j] === null) assert.equal(values[j], wasmValues[j]);
        else assert.ok(Math.abs(values[j] - wasmValues[j]) < 1e-9);
      }
      if (i < 4) {
        const coords = actual[i - 1].positions;
        const origin = i === 1 ? 0 : 0.5;
        for (let n = 0; n < values.length / 3; n++) {
          const exact = 273.15 + 1000 / 45 * (coords[3 * n] - origin);
          assert.ok(Math.abs(values[3 * n] - exact) < 1e-9);
          assert.ok(Math.abs(wasmValues[3 * n] - exact) < 1e-9);
        }
      } else {
        assert.ok(values.includes(null));
        for (let j = 0; j < values.length; j++) if (values[j] !== null) {
          assert.ok(Math.abs(values[j] - (j % 3 === 0 ? 1000 / 90 : 0)) < 1e-9);
        }
      }
    }
    console.log(`retained surfaces/fields/differences: exact hashes, surface topology/coordinates/identity and Fourier oracle, native ${threads} threads vs WASM passed`);
  }
} finally {
  engine.free();
  rmSync(scratch, { recursive: true, force: true });
}
