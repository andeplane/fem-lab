// #73: exact Journal hashes, native thread determinism and numerical RMS parity with WASM.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { batchModule } from './checked-batch.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const native = process.env.FEMLAB_NATIVE ?? path.join(root, 'target/release/femlab');
const { Engine } = batchModule(createRequire(import.meta.url)(path.join(root, 'tools/wasm-node/femlab_engine_wasm.js')));
const fixture = JSON.parse(readFileSync(path.join(root, 'crates/femlab/benches/cases/random-vibration-sdof.json'), 'utf8'));
const scratch = mkdtempSync(path.join(tmpdir(), 'femlab-random-replay-'));
const engine = new Engine(1);
try {
  for (const command of fixture.journal) await engine.dispatch(JSON.stringify(command));
  for (const check of fixture.checks) {
    const answer = JSON.parse(engine.query(JSON.stringify(check.query))).value.value;
    assert.ok(Math.abs(answer / check.expect - 1) < check.tol, `${check.query.field}: ${answer} vs ${check.expect}`);
  }
  const queries = ['displacement', 'stress', 'stressUnaveraged'].map(field => ({ query: 'query.field', step: 'random', field }));
  const expected = queries.map(q => JSON.parse(engine.query(JSON.stringify(q))));
  const entries = JSON.parse(engine.export_file()).journal.entries;
  const file = path.join(scratch, 'random.json');
  writeFileSync(file, JSON.stringify(entries));
  let nativeFields;
  for (const threads of [1, 4]) {
    const args = ['run', file, '--cpu', '--threads', String(threads), '--verify'];
    const hashes = execFileSync(native, [...args, '--hashes'], { encoding: 'utf8' }).trim().split(/\r?\n/);
    assert.deepEqual(hashes, entries.map(e => e.hashAfter));
    const actual = JSON.parse(execFileSync(native, [...args, ...queries.flatMap(q => ['--query', JSON.stringify(q)])], { encoding: 'utf8' }));
    if (nativeFields) assert.deepEqual(actual, nativeFields, 'native fields are bit-identical at 1/4 threads');
    nativeFields = actual;
    for (let field = 0; field < actual.length; field++) {
      const { values: got, ...metadata } = actual[field];
      const { values: want, ...expectedMetadata } = expected[field];
      assert.deepEqual(metadata, expectedMetadata);
      assert.equal(got.length, want.length);
      // Native and WASM floating arithmetic can differ by rounding (observed: one ULP).
      // Model hashes remain exact; field parity uses a relative norm tolerance of 1e-12.
      const scale = Math.max(...want.map(Math.abs), Number.MIN_VALUE);
      for (let i = 0; i < got.length; i++) assert.ok(Math.abs(got[i] - want[i]) <= 1e-12 * scale, `${metadata.field}[${i}]`);
    }
  }
  console.log('Random-vibration Journal hashes and RMS fields agree in WASM and native at 1/4 threads.');
} finally {
  engine.free();
  rmSync(scratch, { recursive: true, force: true });
}
