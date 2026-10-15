#!/usr/bin/env node
// #602: independently known log grids and guided-bar response, with real solve/replay parity.
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
const scratch = mkdtempSync(path.join(tmpdir(), 'femlab-log-sweep-'));
const cases = [
  { stop: 1e100, points: 3, every: 1, physics: false },
  { stop: 1e100, points: 9, every: 4, physics: false },
  ...[3, 5, 9, 17].map(points => ({ stop: 1e20, points, every: 1, physics: true })),
];
const queries = [
  { query: 'query.result', step: 'modes' },
  { query: 'query.field', step: 'modes', field: 'mode:1' },
  { query: 'query.result', step: 'sweep' },
  { query: 'query.results' },
];
const commands = c => [
  { cmd: 'model.new', name: 'finite logarithmic sweep' },
  { cmd: 'geometry.addBox', name: 'bar', size: ['1 m', '0.1 m', '0.1 m'] },
  { cmd: 'material.add', name: 'steel', E: '210 GPa', nu: 0.3, rho: '7800 kg/m^3', source: 'EN 10025' },
  { cmd: 'material.assign', material: 'steel', bodies: ['bar'] },
  { cmd: 'mesh.set', mesher: { kind: 'lattice', size: { nx: 1, ny: 1, nz: 1 } }, formulation: 'full' },
  { cmd: 'constraint.fix', name: 'root', on: 'bar.xmin' },
  { cmd: 'constraint.fix', name: 'guide', on: 'bar.xmax', dofs: ['uy', 'uz'] },
  { cmd: 'load.traction', name: 'pull', on: 'bar.xmax', total: ['10 kN', '0 N', '0 N'] },
  { cmd: 'step.add', name: 'modes', procedure: 'modal', constraints: ['root', 'guide'], loads: [], nModes: 4 },
  { cmd: 'step.add', name: 'sweep', procedure: 'harmonic', constraints: ['root', 'guide'], loads: ['pull'],
    after: 'modes', fStart: '1e-300 Hz', fStop: String(c.stop) + ' Hz', points: c.points,
    outputEvery: c.every, dampingRatio: 0, sweep: 'log' },
  { cmd: 'solve.run', step: 'modes', solver: 'cpu-direct' },
  { cmd: 'solve.run', step: 'sweep', solver: 'cpu-direct' },
];
function check(answers, c) {
  const [modal, mode, response, catalogue] = answers;
  assert.equal(modal.frequencies.length, 4);
  assert.ok(mode.values.some(value => value !== 0));
  assert.deepEqual(catalogue.records.map(record => record.step).sort(), ['modes', 'sweep']);
  const retained = Array.from({ length: c.points }, (_, i) => i)
    .filter(i => i === 0 || i % c.every === 0 || i === c.points - 1);
  assert.equal(response.sweep.length, retained.length);
  assert.equal(response.sweep[0].frequency.value, 1e-300);
  assert.equal(response.sweep.at(-1).frequency.value, c.stop);
  const stiffness = 210e9 * (1 - 0.3) / ((1 + 0.3) * (1 - 2 * 0.3)) * 0.01;
  const mass = 7800 * 0.01 / 3;
  response.sweep.forEach((row, index) => {
    // These integer decimal powers are independent known quantiles, not a copy of log/exp interpolation.
    const exact = 10 ** (-300 + (c.physics ? 320 : 400) * retained[index] / (c.points - 1));
    assert.equal(row.frequency.unit, 'Hz');
    assert.ok(Number.isFinite(row.frequency.value));
    assert.ok(Math.abs(row.frequency.value / exact - 1) < 4e-13);
    if (index > 0) assert.ok(row.frequency.value > response.sweep[index - 1].frequency.value);
    if (c.physics) {
      const omega = 2 * Math.PI * row.frequency.value;
      const dynamicStiffness = stiffness - mass * omega * omega;
      assert.ok(Math.abs(row.amplitude.value / (10000 / Math.abs(dynamicStiffness)) - 1) < 1e-10);
      assert.ok(Math.abs(Math.abs(row.phase.value) - (dynamicStiffness > 0 ? 0 : Math.PI)) < 1e-12);
    }
  });
  // The 1e100 Hz cases check the grid and retained modal result only. Their high-frequency
  // reciprocal arithmetic is a separate reported response defect, not a zero-amplitude oracle.
  return {
    frequencies: response.sweep.map(row => row.frequency),
    modalFrequencies: modal.frequencies,
    mode: mode.values,
    ...(c.physics ? { amplitude: response.sweep.map(row => row.amplitude.value),
      phase: response.sweep.map(row => row.phase.value) } : {}),
  };
}
function closeArray(actual, expected, tolerance) {
  assert.equal(actual.length, expected.length);
  const scale = Math.max(...expected.map(Math.abs), Number.MIN_VALUE);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) <= tolerance * scale));
}
let previousGrid;
try {
  for (const [index, c] of cases.entries()) {
    const engine = new Engine(1);
    const query = q => JSON.parse(engine.query(JSON.stringify(q)));
    try {
      const fixture = commands(c);
      for (const command of fixture.slice(0, -1)) await engine.dispatch(JSON.stringify(command));
      const modalBefore = queries.slice(0, 2).map(query);
      await engine.dispatch(JSON.stringify(fixture.at(-1)));
      assert.deepEqual(queries.slice(0, 2).map(query), modalBefore, 'harmonic solve preserves retained modal fields');
      const expected = check(queries.map(query), c);
      if (c.physics) {
        if (previousGrid) previousGrid.forEach((frequency, i) => assert.deepEqual(expected.frequencies[2 * i], frequency));
        previousGrid = expected.frequencies;
      }
      const entries = JSON.parse(engine.export_file()).journal.entries;
      const file = path.join(scratch, 'sweep-' + index + '.json');
      writeFileSync(file, JSON.stringify(entries));
      let nativeSnapshot;
      for (const threads of [1, 4]) {
        const args = ['run', file, '--cpu', '--threads', String(threads), '--verify'];
        assert.deepEqual(execFileSync(native, [...args, '--hashes'], { encoding: 'utf8' }).trim().split(/\r?\n/),
          entries.map(entry => entry.hashAfter));
        const answers = JSON.parse(execFileSync(native,
          [...args, ...queries.flatMap(q => ['--query', JSON.stringify(q)])], { encoding: 'utf8' }));
        const actual = check(answers, c);
        if (nativeSnapshot) assert.deepEqual(actual, nativeSnapshot, 'native 1/4-thread results are bit-identical');
        nativeSnapshot = actual;
        assert.deepEqual(actual.frequencies, expected.frequencies);
        closeArray(actual.modalFrequencies.map(row => row.value), expected.modalFrequencies.map(row => row.value), 1e-12);
        closeArray(actual.mode, expected.mode, 1e-12);
        if (c.physics) {
          closeArray(actual.amplitude, expected.amplitude, 1e-12);
          closeArray(actual.phase, expected.phase, 1e-12);
        }
      }
      assert.deepEqual(JSON.parse(await engine.replay_hashes(JSON.stringify(entries), false, true)),
        entries.map(entry => entry.hashAfter));
      assert.deepEqual(check(queries.map(query), c), expected, 'WASM replay recomputes both Results');
    } finally { engine.free(); }
  }
  console.log('Six finite log-sweep Journals: independent grids/response/refinement, retained modes, native 1/4-thread and WASM solve/replay parity passed.');
} finally { rmSync(scratch, { recursive: true, force: true }); }
