#!/usr/bin/env node
// #525: material-free original shell areas, physical offset forces and host replay parity.
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
const scratch = mkdtempSync(path.join(tmpdir(), 'femlab-shell-pressure-area-'));
const a = 0.25;
const r = Math.sqrt(1 + 2 * a * a);
const bilinearArea = (r + (a * a + 3) / a * Math.asinh(a / Math.sqrt(1 + a * a)) - Math.atan(a * a / r) / (a * a)) / 3;
const angle = Math.atan(0.75);
const planar = [
  { name: 'horizontal', corners: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], normal: [0, 0, 1] },
  { name: 'vertical', corners: [[2, 0, 0], [2, 1, 0], [2, 1, 1], [2, 0, 1]], normal: [1, 0, 0] },
  { name: 'oblique', corners: [[2, 3, 4], [2.6, 3.8, 4], [2.12, 4.16, 4.8], [1.52, 3.36, 4.8]], normal: [0.64, -0.48, 0.6] },
];
const cases = [
  ...planar.flatMap(patch => [1, 2, 4].map(n => ({ ...patch, n: [n, n], area: 1 }))),
  ...[1, 2, 4, 8].map(n => ({ name: 'bilinear', corners: [[1, 0, 0], [1, 1, 0], [1.25, 1, 1], [1, 0, 1]], n: [n, n], area: bilinearArea })),
  ...[1, 2, 4, 8].map(n => ({ name: 'cylinder', corners: [[1, 0, 0], [0.8, 0.6, 0], [0.8, 0.6, 1], [1, 0, 1]], n: [n, 1], area: angle,
    projection: { kind: 'cylinder', center: ['0 m', '0 m', '0 m'], axis: [0, 0, 1], radius: '1 m' } })),
];
const previousErrors = new Map();
try {
  for (const [index, patch] of cases.entries()) {
    const engine = new Engine(1);
    const query = q => JSON.parse(engine.query(JSON.stringify(q)));
    const dispatch = command => engine.dispatch(JSON.stringify(command));
    const setQueries = ['top', 'bottom'].map(side => ({ query: 'query.set', name: `skin.${side}` }));
    try {
      await dispatch({ cmd: 'model.new', name: `shell pressure area ${patch.name}` });
      await dispatch({ cmd: 'model.setUnits', units: { length: 'm', force: 'N' } });
      await dispatch({ cmd: 'mesh.set', mesher: { kind: 'surface', body: 'skin', patches: [{
        corners: patch.corners.map(point => point.map(value => `${value} m`)), n: patch.n,
        tags: [null, null, null, 'root'], ...(patch.projection ? { projection: patch.projection } : {}),
      }] } });
      const before = engine.export_file();
      const areas = setQueries.map(query);
      assert.equal(engine.export_file(), before, 'material-free Queries preserve Model and Journal');
      assert.equal(areas[0].pressureArea.unit, 'm^2');
      assert.ok(Math.abs(areas[0].pressureArea.value - areas[1].pressureArea.value) < 2e-14);
      const error = Math.abs(areas[0].pressureArea.value - patch.area);
      if (patch.normal) assert.ok(error < 2e-14, `${patch.name} unit-square area`);
      else {
        if (patch.name === 'bilinear') assert.ok(error < 5e-6);
        const previous = previousErrors.get(patch.name);
        if (previous !== undefined) {
          const order = Math.log2(previous / error);
          const target = patch.name === 'bilinear' ? 4 : 2;
          assert.ok(Math.abs(order - target) < 0.2, `${patch.name} refinement order ${order}`);
        }
        previousErrors.set(patch.name, error);
      }
      const resultQueries = [];
      if (patch.normal || patch.projection) {
        for (const command of [
          { cmd: 'material.add', name: 'steel', E: '200 GPa', nu: 0.3 },
          { cmd: 'material.assign', material: 'steel', bodies: ['skin'] },
          { cmd: 'section.add', name: 'shell', shape: { kind: 'shell', thickness: '100 mm' } },
          { cmd: 'section.assign', section: 'shell', bodies: ['skin'] },
          { cmd: 'constraint.fix', name: 'root', on: 'skin.root' },
        ]) await dispatch(command);
        for (const side of ['top', 'bottom']) {
          await dispatch({ cmd: 'load.pressure', name: `p_${side}`, on: `skin.${side}`, value: '100 Pa' });
          await dispatch({ cmd: 'step.add', name: side, procedure: 'static', constraints: ['root'], loads: [`p_${side}`] });
          await dispatch({ cmd: 'solve.run', step: side, solver: 'cpu-direct' });
          const q = { query: 'query.result', step: side };
          resultQueries.push(q);
          const summary = query(q);
          const coefficient = patch.normal ? (side === 'top' ? -100 : 100) : (side === 'top' ? -105 : 95);
          const force = (patch.normal ?? [0.6, 0.2, 0]).map(value => value * coefficient);
          force.forEach((exact, axis) => {
            assert.ok(Math.abs(summary.appliedTotal[axis].value - exact) < 1e-10);
            const reaction = summary.reactions.reduce((sum, row) => sum + row.total[axis].value, 0);
            assert.ok(Math.abs(reaction + exact) < 1e-7);
          });
        }
        assert.deepEqual(setQueries.map(query), areas, 'Section and solve preserve original query areas');
      }
      const queries = [...setQueries, ...resultQueries];
      const expected = queries.map(query);
      const entries = JSON.parse(engine.export_file()).journal.entries;
      const file = path.join(scratch, `${index}.json`);
      writeFileSync(file, JSON.stringify(entries));
      for (const threads of [1, 4]) {
        const args = ['run', file, '--cpu', '--threads', String(threads), '--verify'];
        assert.deepEqual(execFileSync(native, [...args, '--hashes'], { encoding: 'utf8' }).trim().split(/\r?\n/), entries.map(entry => entry.hashAfter));
        const actual = JSON.parse(execFileSync(native, [...args, ...queries.flatMap(q => ['--query', JSON.stringify(q)])], { encoding: 'utf8' }));
        assert.deepEqual(actual.slice(0, 2), expected.slice(0, 2));
        for (let i = 2; i < actual.length; i++) {
          for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(actual[i].appliedTotal[axis].value - expected[i].appliedTotal[axis].value) < 1e-10);
        }
      }
      assert.deepEqual(JSON.parse(await engine.replay_hashes(JSON.stringify(entries), false, true)), entries.map(entry => entry.hashAfter));
      assert.deepEqual(setQueries.map(query), areas);
    } finally { engine.free(); }
  }
  console.log('Shell pressure areas, analytic refinement, physical projected offset forces, native 1/4-thread and WASM Journal/query parity passed.');
} finally { rmSync(scratch, { recursive: true, force: true }); }
