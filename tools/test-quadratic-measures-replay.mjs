#!/usr/bin/env node
// #524: original quadratic geometry, independent integrals and cross-host replay.
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
const wasm = process.env.FEMLAB_WASM ?? path.join(root, 'tools/wasm-node/femlab_engine_wasm.js');
const { Engine } = batchModule(createRequire(import.meta.url)(wasm));
const scratch = mkdtempSync(path.join(tmpdir(), 'femlab-quadratic-measures-'));
const queries = ['whole', 'shape.outer', 'shape.inner'].map(name => ({ query: 'query.set', name }));
queries.push({ query: 'query.model' });
const proof = [];

function commands(n, solid, simplices, affine) {
  const block = affine ? {
    corners: [['0 m', '0 m'], ['2 m', '0 m'], ['2 m', '3 m'], ['0 m', '3 m']],
    n: [2, 3], tags: ['radial0', 'outer', 'radial1', 'inner'],
  } : {
    corners: [['1 m', '0 m'], ['2 m', '0 m'], ['0 m', '2 m'], ['0 m', '1 m']],
    edges: [{ kind: 'line' }, { kind: 'arc', center: ['0 m', '0 m'], ccw: true },
      { kind: 'line' }, { kind: 'arc', center: ['0 m', '0 m'], ccw: false }],
    n: [1, n], tags: ['radial0', 'outer', 'radial1', 'inner'],
  };
  const base = { kind: 'mapped', body: 'shape', blocks: [block] };
  const mesher = solid ? { kind: 'sweep', base, sweep: { kind: 'extrude', layers: 2, height: affine ? '4 m' : '3 m' } } : base;
  return [
    { cmd: 'model.new', name: 'original-quadratic-measures' },
    { cmd: 'model.setUnits', units: { length: 'm' } },
    ...(!solid ? [{ cmd: 'model.setIdealisation', idealisation: { kind: 'planeStress', thickness: '2 mm' } }] : []),
    { cmd: 'mesh.set', mesher, order: 2, simplices },
    { cmd: 'geometry.nameRegion', name: 'whole', where: { kind: 'body', name: 'shape' } },
  ];
}

try {
  for (const solid of [false, true]) {
    for (const simplices of [false, true]) {
      let previousGeometryError;
      let previousQuadratureError;
      for (const n of [2, 4, 8, 0]) {
        const affine = n === 0;
        const engine = new Engine(1);
        try {
          for (const command of commands(n, solid, simplices, affine)) await engine.dispatch(JSON.stringify(command));
          const expected = queries.map(query => JSON.parse(engine.query(JSON.stringify(query))));
          const [whole, outer, inner, model] = expected;
          const delta = affine ? 0 : Math.PI / (4 * n);
          const originalArea = affine ? 6 : n * Math.sin(delta) * (4 - Math.cos(delta));
          const scale = solid ? (affine ? 4 : 3) : 1;
          const k = 2 * Math.tan(delta / 2);
          const originalLength = affine ? 3 : 2 * n * Math.sin(delta) * (Math.sqrt(1 + k * k) + Math.asinh(k) / k);
          const originalBoundary = scale * originalLength;
          assert.ok(Math.abs(whole.measure.value - scale * originalArea) < 3e-13, `original area/volume at n=${n}`);
          assert.ok(Math.abs(whole.measure.value - model.bodies[0].measure.value) < 3e-13, 'Body original measure');
          assert.equal(whole.measure.unit, solid ? 'm^3' : 'm^2');
          assert.equal(outer.measure.unit, solid ? 'm^2' : 'm');
          const quadratureError = Math.abs(outer.measure.value - originalBoundary);
          if (affine) {
            assert.ok(quadratureError < 3e-14, 'straight-sided quadratic boundary');
            assert.ok(Math.abs(outer.measure.value - inner.measure.value) < 3e-14, 'opposite rectangle sides');
          } else {
            const geometryError = Math.abs(whole.measure.value - scale * 3 * Math.PI / 4);
            assert.ok(quadratureError / originalBoundary < 5e-6, 'nonpolynomial norm relative error');
            assert.ok(Math.abs(outer.measure.value - 2 * inner.measure.value) < 3e-13, 'radius scaling');
            if (previousGeometryError !== undefined) {
              const order = Math.log2(previousGeometryError / geometryError);
              assert.ok(order > 3.9 && order < 4.1, `P2 circle geometry refinement order ${order}`);
              assert.ok(quadratureError < previousQuadratureError / 20, 'curved norm quadrature refinement');
            }
            previousGeometryError = geometryError;
            previousQuadratureError = quadratureError;
          }
          if (!solid) {
            assert.equal(outer.pressureArea.unit, 'm^2');
            assert.ok(Math.abs(outer.pressureArea.value - 0.002 * outer.measure.value) < 3e-14, 'thickness-weighted physical area');
          }
          const entries = JSON.parse(engine.export_file()).journal.entries;
          const file = path.join(scratch, `journal-${solid}-${simplices}-${n}.json`);
          writeFileSync(file, JSON.stringify(entries));
          for (const threads of [1, 4]) {
            const args = ['run', file, '--cpu', '--threads', String(threads), '--verify', '--skip-solves'];
            const hashes = execFileSync(native, [...args, '--hashes'], { encoding: 'utf8' }).trim().split(/\r?\n/);
            assert.deepEqual(hashes, entries.map(entry => entry.hashAfter));
            const actual = JSON.parse(execFileSync(native, [...args, ...queries.flatMap(query => ['--query', JSON.stringify(query)])], { encoding: 'utf8' }));
            assert.deepEqual(actual, expected);
          }
          assert.deepEqual(JSON.parse(await engine.replay_hashes(JSON.stringify(entries), true, true)), entries.map(entry => entry.hashAfter));
          assert.deepEqual(queries.map(query => JSON.parse(engine.query(JSON.stringify(query)))), expected);
          proof.push({ solid, simplices, n, whole: whole.measure.value, boundary: outer.measure.value, quadratureError });
        } finally {
          engine.free();
        }
      }
    }
  }
  if (process.env.FEMLAB_MEASURE_REPORT) writeFileSync(process.env.FEMLAB_MEASURE_REPORT, JSON.stringify(proof, null, 2));
  console.log('16 original quadratic geometry Journals: analytical measures/refinement, native1/4-thread and WASM values/hashes agree.');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
