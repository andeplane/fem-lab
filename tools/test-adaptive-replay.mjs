#!/usr/bin/env node
// #83: replay recorded adaptive choices across native thread counts and WASM.
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
const commands = JSON.parse(readFileSync(path.join(root, 'crates/engine/tests/fixtures/adaptive-heat.json'), 'utf8'));
const engine = new Engine(1);
const scratch = mkdtempSync(path.join(tmpdir(), 'femlab-adaptive-replay-'));
try {
  for (const command of commands) await engine.dispatch(JSON.stringify(command));
  const entries = JSON.parse(engine.export_file()).journal.entries;
  assert.ok(entries.at(-1).cmd.refinements.length > 0);
  const file = path.join(scratch, 'journal.json');
  writeFileSync(file, JSON.stringify(entries));
  const queries = [
    { query: 'query.surface', step: 'heat' },
    { query: 'query.field', step: 'heat', field: 'temperature' },
    { query: 'query.field', step: 'heat', field: 'errorEstimate' },
  ];
  const expected = queries.map(q => JSON.parse(engine.query(JSON.stringify(q))));
  assert.equal(expected[2].per, 'element');
  for (const threads of [1, 4]) {
    const args = ['run', file, '--cpu', '--threads', String(threads), '--verify'];
    for (const skip of [false, true]) {
      const hashes = execFileSync(native, [...args, '--hashes', ...(skip ? ['--skip-solves'] : [])], { encoding: 'utf8' }).trim().split(/\r?\n/);
      assert.deepEqual(hashes, entries.map(e => e.hashAfter));
    }
    const actual = JSON.parse(execFileSync(native, [...args, ...queries.flatMap(q => ['--query', JSON.stringify(q)])], { encoding: 'utf8' }));
    assert.deepEqual(actual[0], expected[0]);
    for (let i = 1; i < actual.length; i++) {
      const { values, ...metadata } = actual[i];
      const { values: wasmValues, ...wasmMetadata } = expected[i];
      assert.deepEqual(metadata, wasmMetadata);
      assert.equal(values.length, wasmValues.length);
      values.forEach((v, j) => assert.ok(Math.abs(v - wasmValues[j]) < 1e-9, `${queries[i].field}[${j}]`));
    }
  }
  for (const skip of [false, true]) {
    const hashes = JSON.parse(await engine.replay_hashes(JSON.stringify(entries), skip, true));
    assert.deepEqual(hashes, entries.map(e => e.hashAfter));
  }
  console.log('Adaptive Journal hashes and retained fields agree across native (1/4 threads) and WASM; skipped solves preserve the Model.');
} finally {
  engine.free();
  rmSync(scratch, { recursive: true, force: true });
}
