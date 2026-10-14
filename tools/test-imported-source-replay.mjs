#!/usr/bin/env node
// #516: authored labels, exact Sets and ordinary solved Fields cross the native/WASM boundary.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { batchModule } from './checked-batch.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const native = process.env.FEMLAB_NATIVE ?? path.join(root, 'target/release/femlab');
const { Engine } = batchModule(createRequire(import.meta.url)(path.join(root, 'tools/wasm-node/femlab_engine_wasm.js')));
const scratch = mkdtempSync(path.join(tmpdir(), 'femlab-imported-replay-'));

// Independent Cartesian source records, never produced by a mesher, parser or writer.
function bar(cells, tetrahedra) {
  const label = (x, y, z) => 101 + 13 * (4 * x + 2 * z + y);
  const nodes = [];
  for (let x = 0; x <= cells; x++) for (let z = 0; z < 2; z++) for (let y = 0; y < 2; y++) {
    nodes.push({ label: label(x, y, z), at: [String(x / cells) + ' m', String(y / 10) + ' m', String(z / 10) + ' m'] });
  }
  nodes.push({ label: 9999, at: ['0 m', '0 m', '0 m'] });
  const elements = [], faces = [];
  for (let x = 0; x < cells; x++) {
    const corners = [label(x, 0, 0), label(x + 1, 0, 0), label(x + 1, 1, 0), label(x, 1, 0), label(x, 0, 1), label(x + 1, 0, 1), label(x + 1, 1, 1), label(x, 1, 1)];
    if (tetrahedra) {
      [[0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6], [0, 5, 1, 6]].forEach((conn, i) => {
        const element = 401 + 17 * (6 * x + i);
        elements.push({ label: element, kind: 'tet4', nodes: conn.map(k => corners[k]) });
        if (x + 1 === cells && (i === 0 || i === 5)) faces.push({ element, face: 3 });
      });
    } else {
      const element = 401 + 17 * x;
      elements.push({ label: element, kind: 'hex8', nodes: corners });
      if (x + 1 === cells) faces.push({ element, face: 4 });
    }
  }
  const plane = x => [label(x, 0, 0), label(x, 1, 0), label(x, 0, 1), label(x, 1, 1)];
  return { cmd: 'mesh.set', mesher: { kind: 'imported', body: 'bar', nodes: nodes.reverse(), elements: elements.reverse(), nodeSets: { ROOT: plane(0), TIP: plane(cells), COINCIDENT: [9999, label(0, 0, 0)] }, surfaces: { TIP: faces } } };
}

function checkOracle(outputs) {
  const [mesh, sourceSet, surface, displacement, stress, reaction] = outputs;
  assert.deepEqual(mesh.sourceLabels.unusedNodes, [9999]);
  assert.equal(mesh.nodes, mesh.sourceLabels.nodes.length);
  assert.equal(displacement.values.length, 3 * mesh.nodes);
  assert.deepEqual(sourceSet.sourceNodeLabels, [101, 9999]);
  assert.deepEqual(sourceSet.unusedSourceNodeLabels, [9999]);
  assert.equal(sourceSet.count, 2);
  assert.deepEqual(surface.sourceLabels, mesh.sourceLabels);
  // FL/(EA)=5e-7 m, sigma=F/A=100 kPa, total support reaction=-1 kN.
  mesh.sourceLabels.nodes.forEach((label, i) => {
    const x = Math.floor((label - 101) / 52) / ((mesh.nodes / 4) - 1);
    assert.ok(Math.abs(displacement.values[3 * i] - 5e-7 * x) < 5e-18);
    assert.ok(Math.abs(displacement.values[3 * i + 1]) < 5e-18);
    assert.ok(Math.abs(displacement.values[3 * i + 2]) < 5e-18);
  });
  for (let i = 0; i < stress.values.length; i += stress.components) assert.ok(Math.abs(stress.values[i] - 1e5) < 1e-6);
  let total = 0;
  for (let i = 0; i < reaction.values.length; i += 3) total += reaction.values[i];
  assert.ok(Math.abs(total + 1000) < 1e-8);
}

try {
  for (const tetrahedra of [false, true]) for (const cells of [2, 4, 8]) {
    const engine = new Engine(1);
    try {
      for (const command of [
        { cmd: 'model.new', name: 'imported source parity' }, bar(cells, tetrahedra),
        { cmd: 'material.add', name: 'steel', E: '200 GPa', nu: 0 },
        { cmd: 'material.assign', material: 'steel', bodies: ['bar'] },
        { cmd: 'constraint.fix', name: 'root', on: 'bar.nset_ROOT' },
        { cmd: 'load.traction', name: 'pull', on: 'bar.surface_TIP', total: ['1000 N', '0 N', '0 N'] },
        { cmd: 'step.add', name: 'axial', procedure: 'static', constraints: ['root'], loads: ['pull'] },
        { cmd: 'solve.run', step: 'axial', solver: 'cpu-direct' },
      ]) await engine.dispatch(JSON.stringify(command));
      const entries = JSON.parse(engine.export_file()).journal.entries;
      const file = path.join(scratch, 'source.json');
      writeFileSync(file, JSON.stringify(entries));
      const queries = [
        { query: 'query.mesh' }, { query: 'query.set', name: 'bar.nset_COINCIDENT' },
        { query: 'query.surface', step: 'axial' },
        ...['displacement', 'stress', 'reaction'].map(field => ({ query: 'query.field', step: 'axial', field })),
      ];
      const expected = queries.map(q => JSON.parse(engine.query(JSON.stringify(q))));
      checkOracle(expected);
      for (const threads of [1, 4]) {
        const args = ['run', file, '--cpu', '--threads', String(threads), '--verify'];
        for (const skip of [false, true]) {
          const hashes = execFileSync(native, [...args, '--hashes', ...(skip ? ['--skip-solves'] : [])], { encoding: 'utf8' }).trim().split(/\r?\n/);
          assert.deepEqual(hashes, entries.map(e => e.hashAfter));
        }
        const actual = JSON.parse(execFileSync(native, [...args, ...queries.flatMap(q => ['--query', JSON.stringify(q)])], { encoding: 'utf8' }));
        for (let i = 0; i < 3; i++) assert.deepEqual(actual[i], expected[i]);
        for (let i = 3; i < actual.length; i++) {
          const { values, ...metadata } = actual[i];
          const { values: wasmValues, ...wasmMetadata } = expected[i];
          assert.deepEqual(metadata, wasmMetadata);
          assert.equal(values.length, wasmValues.length);
          values.forEach((value, j) => assert.ok(Math.abs(value - wasmValues[j]) < (i === 3 ? 5e-18 : 1e-6)));
        }
        checkOracle(actual);
      }
      for (const skip of [false, true]) assert.deepEqual(JSON.parse(await engine.replay_hashes(JSON.stringify(entries), skip, true)), entries.map(e => e.hashAfter));
      console.log('Imported ' + (tetrahedra ? 'Tet4' : 'Hex8') + ', ' + cells + ' cells: exact source hashes/labels/Sets and analytical Fields agree in native 1/4 threads and WASM.');
    } finally { engine.free(); }
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
