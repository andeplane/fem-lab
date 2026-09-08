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
  // #64: surface directors, thickness assignments and element-node stresses cross
  // the same registry boundary. Compare an exact flat strip and a curved patch.
  for (const variant of ['flat', 'curved', 'laminate']) {
    const curved = variant === 'curved';
    const laminate = variant === 'laminate';
    const engine = new Engine(1);
    const query = q => JSON.parse(engine.query(JSON.stringify(q)));
    const dispatch = async command => engine.dispatch(JSON.stringify(command));
    try {
      const corners = curved
        ? [['1 m', '0 m', '0 m'], ['0.8 m', '0.6 m', '0 m'], ['0.8 m', '0.6 m', '1 m'], ['1 m', '0 m', '1 m']]
        : [['0 m', '0 m', '0 m'], ['1 m', '0 m', '0 m'], ['1 m', '1 m', '0 m'], ['0 m', '1 m', '0 m']];
      const patch = { corners, n: [4, 1], tags: [null, 'tip', null, 'root'],
        ...(curved ? { projection: { kind: 'cylinder', center: ['0 m', '0 m', '0 m'], axis: [0, 0, 1], radius: '1 m' } } : {}) };
      for (const command of [
        { cmd: 'model.new', name: curved ? 'curved shell parity' : 'moment strip parity' },
        { cmd: 'mesh.set', mesher: { kind: 'surface', body: 'skin', patches: [patch] } },
        laminate
          ? { cmd: 'material.add', name: 'elastic', orthotropic: { E1: '100 GPa', E2: '20 GPa', E3: '10 GPa', G12: '10 GPa', G13: '5 GPa', G23: '3 GPa', nu12: 0, nu13: 0, nu23: 0 } }
          : { cmd: 'material.add', name: 'elastic', E: '200 GPa', nu: 0, rho: '8000 kg/m^3' },
        { cmd: 'material.assign', material: 'elastic', bodies: ['skin'] },
        { cmd: 'section.add', name: 'thin', shape: laminate
          ? { kind: 'laminate', plies: [{ material: 'elastic', thickness: '5 mm' }, { material: 'elastic', thickness: '5 mm', angle: '90 deg' }] }
          : { kind: 'shell', thickness: '10 mm' } },
        { cmd: 'section.assign', section: 'thin', bodies: ['skin'] },
        { cmd: 'constraint.fix', name: 'root', on: 'skin.root' },
        { cmd: 'load.moment', name: 'bend', on: 'skin.tip', total: ['0 N m', '1 N m', '0 N m'] },
        { cmd: 'step.add', name: 's', procedure: 'static', constraints: ['root'], loads: ['bend'] },
        { cmd: 'solve.run', step: 's', solver: 'cpu-direct' },
      ]) await dispatch(command);
      const queries = [
        { query: 'query.surface', step: 's' },
        ...['displacement', 'rotation', 'stressTop', 'stressBottom', 'shellMoment', ...(laminate ? ['stressPly:1:bottom', 'stressPly:1:top', 'stressPly:2:bottom', 'stressPly:2:top'] : [])].map(field => ({ query: 'query.field', step: 's', field })),
      ];
      const expected = queries.map(query);
      const entries = JSON.parse(engine.export_file()).journal.entries;
      const file = path.join(scratch, 'shell.json');
      writeFileSync(file, JSON.stringify(entries));
      for (const threads of [1, 4]) {
        const args = ['run', file, '--cpu', '--threads', String(threads), '--verify'];
        assert.deepEqual(execFileSync(native, [...args, '--hashes'], { encoding: 'utf8' }).trim().split(/\r?\n/), entries.map(e => e.hashAfter));
        const actual = JSON.parse(execFileSync(native, [...args, ...queries.flatMap(q => ['--query', JSON.stringify(q)])], { encoding: 'utf8' }));
        assert.deepEqual(actual[0], expected[0]);
        for (let i = 1; i < actual.length; i++) {
          const { values, ...metadata } = actual[i];
          const { values: wasmValues, ...wasmMetadata } = expected[i];
          assert.deepEqual(metadata, wasmMetadata);
          assert.equal(values.length, wasmValues.length);
          const scale = Math.max(1e-12, ...values.map(Math.abs), ...wasmValues.map(Math.abs));
          values.forEach((v, j) => assert.ok(Math.abs(v - wasmValues[j]) < 1e-7 * scale, `${curved ? 'curved' : 'flat'} ${queries[i].field}[${j}]`));
          if (!curved && queries[i].field.startsWith('stress')) {
            const reference = laminate
              ? { stressTop: 40000, stressBottom: -100000, 'stressPly:1:bottom': -100000, 'stressPly:1:top': 50000, 'stressPly:2:bottom': 10000, 'stressPly:2:top': 40000 }[queries[i].field]
              : (queries[i].field === 'stressTop' ? 60000 : -60000);
            for (let j = 0; j < values.length; j += 6) {
              assert.ok(Math.abs(values[j] - reference) < 0.001);
              assert.ok(Math.abs(wasmValues[j] - reference) < 0.001);
            }
          }
          if (!curved && queries[i].field === 'shellMoment') {
            for (let j = 0; j < values.length; j += 6) {
              assert.ok(Math.abs(values[j] - 1) < 1e-8);
              assert.ok(Math.abs(wasmValues[j] - 1) < 1e-8);
            }
          }
        }
        console.log(`${variant} shell: journal, geometry and surface stress parity at native ${threads} threads passed`);
      }
    } finally {
      engine.free();
    }
  }
} finally {
  engine.free();
  rmSync(scratch, { recursive: true, force: true });
}
