#!/usr/bin/env node
// #605: independent oscillator oracles, finite extreme response, and real host replay.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { batchModule } from './checked-batch.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const native = process.env.FEMLAB_NATIVE ?? path.join(root, 'target/release/femlab');
const modulePath = process.env.FEMLAB_WASM ?? path.join(root, 'tools/wasm-node/femlab_engine_wasm.js');
const wasmPath = modulePath.replace(/\.js$/, '_bg.wasm');
const { Engine, schema } = batchModule(createRequire(import.meta.url)(modulePath));
const options = { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 };
const committed = JSON.parse(readFileSync(path.join(root, 'packages/registry/src/generated/engine.schema.json'), 'utf8'));
assert.deepEqual(JSON.parse(schema()), committed);
assert.deepEqual(JSON.parse(execFileSync(native, ['schema'], options)), committed);
console.log(`Native ${native}; WASM ${wasmPath}; SHA256 ${createHash('sha256').update(readFileSync(wasmPath)).digest('hex')}`);
const scratch = mkdtempSync(path.join(tmpdir(), 'femlab-reciprocal-'));
const phaseDistance = (actual, expected) => Math.abs(Math.atan2(Math.sin(actual - expected), Math.cos(actual - expected)));
const queries = [
  { query: 'query.result', step: 'modes' },
  { query: 'query.field', step: 'modes', field: 'mode:1' },
  { query: 'query.result', step: 'sweep' },
  { query: 'query.field', step: 'sweep', field: 'displacement' },
  { query: 'query.probe', step: 'sweep', field: 'displacement', component: 0, at: ['1 m', '0.05 m', '0.05 m'] },
  { query: 'query.results' },
];
const commands = c => [
  { cmd: 'model.new', name: 'finite harmonic reciprocal' },
  { cmd: 'geometry.addBox', name: 'bar', size: ['1 m', '0.1 m', '0.1 m'] },
  { cmd: 'material.add', name: 'steel', E: '210 GPa', nu: 0.3, rho: '7800 kg/m^3' },
  { cmd: 'material.assign', material: 'steel', bodies: ['bar'] },
  { cmd: 'mesh.set', mesher: { kind: 'lattice', size: { nx: 1, ny: 1, nz: 1 } }, formulation: 'full' },
  { cmd: 'constraint.fix', name: 'root', on: 'bar.xmin' },
  { cmd: 'constraint.fix', name: 'guide', on: 'bar.xmax', dofs: ['uy', 'uz'] },
  { cmd: 'load.traction', name: 'pull', on: 'bar.xmax', total: ['10 kN', '0 N', '0 N'] },
  { cmd: 'step.add', name: 'modes', procedure: 'modal', constraints: ['root', 'guide'], loads: [], nModes: 4 },
  { cmd: 'step.add', name: 'sweep', procedure: 'harmonic', constraints: ['root', 'guide'], loads: ['pull'],
    after: 'modes', fStart: { value: c.start, unit: 'Hz' }, fStop: { value: c.stop, unit: 'Hz' },
    points: c.points, dampingRatio: c.damping, sweep: 'linear' },
  { cmd: 'solve.run', step: 'modes', solver: 'cpu-direct' },
  { cmd: 'solve.run', step: 'sweep', solver: 'cpu-direct' },
];
function check(answers, c) {
  const [modal, mode, response, field, probe, catalogue] = answers;
  assert.equal(modal.frequencies.length, 4);
  assert.ok(mode.values.some(value => value !== 0));
  assert.deepEqual(catalogue.records.map(record => record.step).sort(), ['modes', 'sweep']);
  const stiffness = 210e9 * (1 - 0.3) / ((1 + 0.3) * (1 - 2 * 0.3)) * 0.01;
  const mass = 7800 * 0.01 / 3;
  const viscous = 2 * c.damping * Math.sqrt(stiffness * mass);
  assert.equal(response.sweep.length, c.points);
  assert.equal(response.sweep[0].frequency.value, c.start);
  assert.equal(response.sweep.at(-1).frequency.value, c.stop);
  let peak = 0;
  response.sweep.forEach((row, i) => {
    const frequency = c.start + (c.stop - c.start) * i / (c.points - 1);
    assert.ok(Math.abs(row.frequency.value / frequency - 1) < 1e-15);
    assert.equal(row.frequency.unit, 'Hz');
    const omega = 2 * Math.PI * row.frequency.value;
    const real = stiffness - mass * omega * omega;
    const imaginary = viscous * omega;
    const expected = 10000 / Math.hypot(real, imaginary);
    assert.ok(expected > 0 && Number.isFinite(expected));
    assert.ok(row.amplitude.value > 0 && Number.isFinite(row.amplitude.value));
    assert.ok(Math.abs(row.amplitude.value / expected - 1) < 1e-10,
      `${row.frequency.value} Hz, damping ${c.damping}: ${row.amplitude.value} versus ${expected}`);
    assert.ok(phaseDistance(row.phase.value, Math.atan2(imaginary, real)) < 1e-12);
    assert.equal(row.amplitude.unit, 'm');
    assert.equal(row.phase.unit, 'rad');
    peak = Math.max(peak, expected);
  });
  assert.ok(field.values.every(Number.isFinite));
  const fieldMax = Math.max(...field.values);
  assert.ok(fieldMax > 0 && Math.abs(fieldMax / peak - 1) < 1e-10);
  assert.ok(probe.value.value > 0 && Math.abs(probe.value.value / peak - 1) < 1e-10);
  return { rows: response.sweep, field: field.values, probe: probe.value,
    mode: mode.values, modalFrequencies: modal.frequencies };
}
function closeArray(actual, expected) {
  assert.equal(actual.length, expected.length);
  const scale = Math.max(...expected.map(Math.abs), Number.MIN_VALUE);
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) <= 1e-12 * scale));
}
const cases = [800, 1e99].flatMap(start => [0, 0.05, 0.8].flatMap(damping =>
  [3, 5, 9].map(points => ({ start, stop: start === 800 ? 2400 : 1e100, damping, points }))));
try {
  let previousGrid;
  for (const [index, c] of cases.entries()) {
    const engine = new Engine(1);
    const query = q => JSON.parse(engine.query(JSON.stringify(q)));
    try {
      const fixture = commands(c);
      for (const command of fixture.slice(0, -1)) await engine.dispatch(JSON.stringify(command));
      const before = queries.slice(0, 2).map(query);
      await engine.dispatch(JSON.stringify(fixture.at(-1)));
      assert.deepEqual(queries.slice(0, 2).map(query), before);
      const expected = check(queries.map(query), c);
      if (c.points === 3) previousGrid = undefined;
      if (previousGrid) previousGrid.forEach((f, i) => assert.deepEqual(expected.rows[2 * i].frequency, f));
      previousGrid = expected.rows.map(row => row.frequency);
      const entries = JSON.parse(engine.export_file()).journal.entries;
      const file = path.join(scratch, `case-${index}.json`);
      writeFileSync(file, JSON.stringify(entries));
      let nativeSnapshot;
      for (const threads of [1, 4]) {
        const args = ['run', file, '--cpu', '--threads', String(threads), '--verify'];
        assert.deepEqual(execFileSync(native, [...args, '--hashes'], options).trim().split(/\r?\n/),
          entries.map(entry => entry.hashAfter));
        const actual = check(JSON.parse(execFileSync(native,
          [...args, ...queries.flatMap(q => ['--query', JSON.stringify(q)])], options)), c);
        if (nativeSnapshot) assert.deepEqual(actual, nativeSnapshot, 'native one/four physical Results');
        nativeSnapshot = actual;
        assert.deepEqual(actual.rows.map(row => row.frequency), expected.rows.map(row => row.frequency));
        closeArray(actual.rows.map(row => row.amplitude.value), expected.rows.map(row => row.amplitude.value));
        actual.rows.forEach((row, i) => assert.ok(phaseDistance(row.phase.value, expected.rows[i].phase.value) < 1e-12));
        closeArray(actual.field, expected.field);
        closeArray(actual.mode, expected.mode);
        closeArray(actual.modalFrequencies.map(row => row.value), expected.modalFrequencies.map(row => row.value));
      }
      assert.deepEqual(JSON.parse(await engine.replay_hashes(JSON.stringify(entries), false, true)),
        entries.map(entry => entry.hashAfter));
      assert.deepEqual(check(queries.map(query), c), expected);
    } finally { engine.free(); }
  }
  // Use the disclosed frequency as an exact endpoint on an identical physical Model.
  const probe = new Engine(1);
  let resonance;
  try {
    for (const command of commands(cases[0]).slice(0, -1)) await probe.dispatch(JSON.stringify(command));
    resonance = JSON.parse(probe.query(JSON.stringify(queries[0]))).frequencies[0].value;
  } finally { probe.free(); }
  for (const c of [
    { start: resonance, stop: 2 * resonance, points: 3, damping: 0 },
    { start: 1e200, stop: 2e200, points: 3, damping: 0.05 },
  ]) {
    const engine = new Engine(1);
    try {
      for (const command of commands(c).slice(0, -1)) await engine.dispatch(JSON.stringify(command));
      const snapshot = () => ({ file: JSON.parse(engine.export_file()),
        mode: JSON.parse(engine.query(JSON.stringify(queries[1]))),
        result: JSON.parse(engine.query(JSON.stringify(queries[0]))),
        catalogue: JSON.parse(engine.query(JSON.stringify(queries[5]))) });
      const before = snapshot();
      await assert.rejects(engine.dispatch(JSON.stringify(commands(c).at(-1))), error =>
        error.code === 'unit.display' && error.where === 'displayUnits');
      assert.deepEqual(snapshot(), before, 'nonfinite/singular solve preserves prior modal publication');
      await engine.dispatch(JSON.stringify({ cmd: 'solve.run', step: 'modes', solver: 'cpu-direct' }));
      assert.equal(JSON.parse(engine.query(JSON.stringify(queries[0]))).resultId, 'result-2');
    } finally { engine.free(); }
  }
  console.log('18 analytical harmonic Journals: ordinary/extreme amplitudes, signed phase, refinement, retained fields/modes, native 1/4 and WASM replay; singular/nonfinite publication boundaries passed.');
} finally { rmSync(scratch, { recursive: true, force: true }); }
