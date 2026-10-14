#!/usr/bin/env node
// #445: B25 statics oracles and retained wrench ledgers in native 1/4 threads and built WASM.
// Run after the ordinary optimized build-wasm.mjs build; this script never rebuilds artifacts.
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
const wasmPath = path.join(root, 'tools/wasm-node/femlab_engine_wasm_bg.wasm');
const { Engine, schema } = batchModule(createRequire(import.meta.url)(path.join(root, 'tools/wasm-node/femlab_engine_wasm.js')));
const benchmark = JSON.parse(readFileSync(path.join(root, 'crates/femlab/benches/cases/beam-torsion-shaft.json'), 'utf8'));
const committedSchema = JSON.parse(readFileSync(path.join(root, 'packages/registry/src/generated/engine.schema.json'), 'utf8'));
const nativeOptions = { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 };
assert.deepEqual(JSON.parse(schema()), committedSchema, 'built WASM schema must match the committed registry');
assert.deepEqual(JSON.parse(execFileSync(native, ['schema'], nativeOptions)), committedSchema, 'native schema must match the same registry');
console.log(`Native: ${native}; WASM: ${wasmPath}; SHA256 ${createHash('sha256').update(readFileSync(wasmPath)).digest('hex')}`);

const queries = [
  { query: 'query.result', step: 'static' },
  { query: 'query.result', step: 'bend' },
  { query: 'query.probe', step: 'static', field: 'rotation', component: 0, at: ['1 m', '0 m', '0 m'] },
  { query: 'query.probe', step: 'bend', field: 'rotation', component: 1, at: ['1 m', '0 m', '0 m'] },
  { query: 'query.probe', step: 'bend', field: 'displacement', component: 2, at: ['1 m', '0 m', '0 m'] },
  { query: 'query.report' },
];

function close(actual, expected, absolute = 1e-8, relative = 1e-10) {
  assert.ok(Number.isFinite(actual), `nonfinite value ${actual}`);
  assert.ok(Math.abs(actual - expected) <= absolute + relative * Math.abs(expected), `${actual} versus ${expected}`);
}

function vector(actual, expected, unit, tolerance = 1e-8) {
  assert.equal(actual.length, 3);
  actual.forEach((quantity, c) => {
    assert.equal(quantity.unit, unit);
    close(quantity.value, expected[c], tolerance);
  });
}

function oracle(outputs) {
  for (const [i, applied] of [[0, [1000, 0, 0]], [1, [0, 1000, 0]]]) {
    const result = outputs[i];
    const ledger = result.staticEquilibrium;
    assert.ok(ledger, 'linear Cartesian static equilibrium must be retained');
    vector(ledger.reference, [0, 0, 0], 'mm');
    assert.equal(ledger.characteristicLength.unit, 'mm');
    close(ledger.characteristicLength.value, 1000);
    vector(result.appliedTotal, [0, 0, 0], 'kN');
    vector(result.reactions[0].total, [0, 0, 0], 'kN');
    vector(ledger.forceResidual, [0, 0, 0], 'kN');
    vector(ledger.appliedMoment, applied, 'kN mm');
    assert.equal(ledger.reactionMoments[0].constraint, 'root');
    vector(ledger.reactionMoments[0].total, applied.map(v => -v), 'kN mm');
    vector(ledger.momentResidual, [0, 0, 0], 'kN mm', 1e-6);
    assert.equal(ledger.forceScale.unit, 'kN');
    assert.equal(ledger.momentScale.unit, 'kN mm');
    assert.ok(ledger.forceScale.value >= 1, 'M/L must keep a real force scale under pure moments');
    assert.ok(ledger.momentScale.value >= 1000);
    assert.ok(Number.isFinite(result.balance) && result.balance <= 1e-9);
    assert.ok(Number.isFinite(ledger.momentBalance) && ledger.momentBalance <= 1e-9);
  }
  const inertia = Math.PI * 0.05 ** 4 / 4;
  const shear = 200e9 / (2 * 1.3);
  const twist = 1000 / (shear * 2 * inertia);
  const slope = 1000 / (200e9 * inertia);
  // Rotation probes use the existing dimensionless display label "SI"; their numeric
  // SI angles are radians, so the physical twist/slope oracles below are unchanged.
  assert.equal(outputs[2].value.unit, 'SI');
  assert.equal(outputs[3].value.unit, 'SI');
  assert.equal(outputs[4].value.unit, 'mm');
  close(outputs[2].value.value, twist, 1e-14, 1e-9);
  close(outputs[3].value.value, slope, 1e-14, 1e-9);
  close(outputs[4].value.value, -1000 * slope / 2, 1e-12, 1e-9);
  const momentVerdicts = outputs[5].markdown.split('\n').filter(line => line.includes('Static moment balance'));
  assert.ok(momentVerdicts.length > 0);
  assert.ok(momentVerdicts.every(line => line.includes('**pass**')), outputs[5].markdown);
}

function numericalParity(actual, expected, where = 'ledger') {
  if (typeof expected === 'number') return close(actual, expected);
  if (Array.isArray(expected)) {
    assert.equal(actual.length, expected.length, where);
    return expected.forEach((value, i) => numericalParity(actual[i], value, `${where}[${i}]`));
  }
  if (expected !== null && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), where);
    return Object.keys(expected).forEach(key => numericalParity(actual[key], expected[key], `${where}.${key}`));
  }
  assert.equal(actual, expected, where);
}

const scratch = mkdtempSync(path.join(tmpdir(), 'femlab-static-equilibrium-'));
try {
  for (const divisions of [2, 4, 8]) {
    const engine = new Engine(1);
    try {
      const commands = benchmark.journal.map(command => ({ ...command,
        ...(command.cmd === 'geometry.addLine' ? { divisions } : {}),
        ...(command.cmd === 'solve.run' ? { solver: 'cpu-direct' } : {}),
      }));
      for (const command of commands) await engine.dispatch(JSON.stringify(command));
      const entries = JSON.parse(engine.export_file()).journal.entries;
      const file = path.join(scratch, `b25-${divisions}.json`);
      writeFileSync(file, JSON.stringify(entries));
      const wasm = queries.map(query => JSON.parse(engine.query(JSON.stringify(query))));
      oracle(wasm);
      const nativeRuns = [];
      for (const threads of [1, 4]) {
        const args = ['run', file, '--cpu', '--threads', String(threads), '--verify'];
        const hashes = execFileSync(native, [...args, '--hashes'], nativeOptions).trim().split(/\r?\n/);
        assert.deepEqual(hashes, entries.map(entry => entry.hashAfter));
        const outputs = JSON.parse(execFileSync(native, [...args, ...queries.flatMap(query => ['--query', JSON.stringify(query)])], nativeOptions));
        oracle(outputs);
        for (let i = 0; i < 2; i++) numericalParity(outputs[i].staticEquilibrium, wasm[i].staticEquilibrium);
        for (let i = 2; i < 5; i++) numericalParity(outputs[i], wasm[i], 'probe');
        nativeRuns.push(outputs);
      }
      for (let i = 0; i < 2; i++) {
        assert.deepEqual(nativeRuns[0][i].staticEquilibrium, nativeRuns[1][i].staticEquilibrium, 'native ledger must be exact at 1/4 threads');
        assert.equal(nativeRuns[0][i].balance, nativeRuns[1][i].balance);
      }
      assert.deepEqual(JSON.parse(await engine.replay_hashes(JSON.stringify(entries), false, true)), entries.map(entry => entry.hashAfter));
      console.log(`B25 ${divisions} divisions: analytical torsion/bending, raw force/moment ledgers, report, exact native 1/4 threads and numerical WASM parity passed.`);
    } finally { engine.free(); }
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
