#!/usr/bin/env node
// #523: original bilinear query measurements and Journal parity across hosts.
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
const a = 0.25;
const r = Math.sqrt(1 + 2 * a * a);
const exact = (r + (a * a + 3) / a * Math.asinh(a / Math.sqrt(1 + a * a)) - Math.atan(a * a / r) / (a * a)) / 3;
const scratch = mkdtempSync(path.join(tmpdir(), 'femlab-original-measures-'));
const queries = [{ query: 'query.set', name: 'warped.top' }, { query: 'query.set', name: 'warped.bottom' }, { query: 'query.model' }];
let previousError;
try {
  for (const n of [1, 2, 4, 8]) {
    const engine = new Engine(1);
    try {
      for (const command of [
        { cmd: 'model.new', name: 'original-bilinear-measure' },
        { cmd: 'model.setUnits', units: { length: 'm' } },
        { cmd: 'mesh.set', mesher: { kind: 'surface', body: 'warped', patches: [{
          corners: [['1 m', '0 m', '0 m'], ['1 m', '1 m', '0 m'], ['1.25 m', '1 m', '1 m'], ['1 m', '0 m', '1 m']],
          n: [n, n],
        }] } },
      ]) await engine.dispatch(JSON.stringify(command));
      const expected = queries.map(query => JSON.parse(engine.query(JSON.stringify(query))));
      const measure = expected[0].measure.value;
      assert.ok(Math.abs(measure - expected[1].measure.value) < 2e-14, `owner area at n=${n}`);
      assert.ok(Math.abs(measure - expected[2].bodies[0].measure.value) < 2e-14, `Body area at n=${n}`);
      const error = Math.abs(measure - exact);
      assert.ok(error < 5e-6, `analytic area at n=${n}`);
      if (previousError !== undefined) {
        const order = Math.log2(previousError / error);
        assert.ok(order > 3.8 && order < 4.2, `area refinement order ${order}`);
      }
      previousError = error;
      const entries = JSON.parse(engine.export_file()).journal.entries;
      const file = path.join(scratch, `journal-${n}.json`);
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
    } finally {
      engine.free();
    }
  }
  console.log('Original bilinear areas converge at order4; native1/4-thread and WASM query values and Journal hashes agree.');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
