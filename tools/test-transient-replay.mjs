#!/usr/bin/env node
import { batchModule } from './checked-batch.mjs';
// Full-solve parity through the existing replay tool and native CLI. With a directory argument,
// replay the Journals recorded by Chromium; otherwise record the same fixtures in Node WASM.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const native = process.env.FEMLAB_NATIVE ?? path.join(root, 'target', 'release', 'femlab');
const { Engine } = batchModule(createRequire(import.meta.url)(path.join(root, 'tools/wasm-node/femlab_engine_wasm.js')));
const recorded = process.argv[2];
const scratch = mkdtempSync(path.join(tmpdir(), 'femlab-transient-replay-'));
const query = (engine, q) => JSON.parse(engine.query(JSON.stringify(q)));
const close = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`);
const run = (file, args, threads = 1) => execFileSync(native, ['run', file, '--cpu', '--threads', String(threads), '--verify', ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
try {
  for (const kind of ['heat', 'explicit-2d', 'explicit-3d']) for (const order of [1, 2]) for (const nx of [2, 4]) {
    const name = `${kind}-o${order}-n${nx}`;
    const file = recorded ? path.join(recorded, `${name}.json`) : path.join(scratch, `${name}.json`);
    if (!recorded) {
      const commands = JSON.parse(readFileSync(path.join(root, `tools/fixtures/transient-${kind}.json`)));
      const mesh = commands.find(c => c.cmd === 'mesh.set');
      mesh.order = order;
      if (mesh.mesher.kind === 'mapped') mesh.mesher.blocks[0].n[0] = nx;
      else mesh.mesher.size.nx = nx;
      const recorder = new Engine(1);
      try {
        for (const cmd of commands) await recorder.dispatch(JSON.stringify(cmd));
        writeFileSync(file, JSON.stringify(JSON.parse(recorder.export_file()).journal.entries));
      } finally {
        recorder.free();
      }
    }
    const entries = JSON.parse(readFileSync(file));
    const beforeHashes = entries.map(e => e.hashAfter);
    // Like the native CLI and replay-wasm tool, replay into a fresh engine. Recording has
    // already solved once; retained IDs intentionally are not recycled on a reused engine.
    const engine = new Engine(1);
    assert.deepEqual(JSON.parse(await engine.replay_hashes(JSON.stringify(entries), false, true)), beforeHashes);
    const journalBefore = query(engine, { query: 'query.journal' });
    const catalogue = query(engine, { query: 'query.frames' });
    const heat = kind === 'heat';
    const field = heat ? 'temperature' : 'displacement';
    const component = heat ? 0 : 1;
    const at = ['0.5 m', '0.05 m', kind === 'explicit-2d' ? '0 m' : '0.05 m'];
    assert.equal(catalogue.frames[0].timeSi, 0);
    assert.equal(catalogue.frames.at(-1).timeSi, heat ? 0.35 : 1.3 * 0.001);
    assert.ok(catalogue.frames.length >= 3);
    if (heat) assert.deepEqual(catalogue.frames.map(f => f.timeSi), [0, 0.35 / Math.ceil(0.35 / 0.1) * 2, 0.35]);
    const queries = [{ query: 'query.frames' }];
    for (const frame of catalogue.frames) queries.push(
      { query: 'query.frame', index: frame.index },
      { query: 'query.probe', field, component, at, sample: { kind: 'frame', index: frame.index } },
      { query: 'query.path', field, component, from: ['0.2 m', '0.05 m', at[2]], to: ['0.8 m', '0.05 m', at[2]], n: 3, sample: { kind: 'time', time: `${frame.timeSi} s`, sampling: 'exact' } },
    );
    const expectedResults = queries.map(q => query(engine, q));
    // Exercise the real WASM staging allocator and actual transferable detachment. Caller
    // mutation and transferring a buffer cannot detach or corrupt retained engine frames.
    for (const stamp of catalogue.frames) {
      const q = JSON.stringify({ query: 'query.frame', sample: { kind: 'time', time: `${stamp.timeSi} s`, sampling: 'exact' } });
      const staged = engine.query_transfer(q);
      assert.ok(staged.values instanceof Float64Array);
      const original = Array.from(staged.values);
      const received = structuredClone(staged, { transfer: [staged.values.buffer] });
      assert.equal(staged.values.buffer.byteLength, 0);
      received.values.fill(99);
      assert.deepEqual(Array.from(engine.query_transfer(q).values), original);
    }
    assert.deepEqual(engine.query_transfer('{"query":"query.frames"}'), catalogue);
    for (const q of [
      { query: 'query.frame', index: 999 },
      { query: 'query.frame', index: 0, field: 'stress' },
      { query: 'query.frame', index: 0, sample: { kind: 'frame', index: 0 } },
      { query: 'query.frame', sample: { kind: 'time', time: '1 m', sampling: 'exact' } },
    ]) assert.throws(() => engine.query_transfer(JSON.stringify(q)), error => typeof error.code === 'string');


    const flags = queries.flatMap(q => ['--query', JSON.stringify(q)]);
    for (const threads of [1, 4]) {
      assert.deepEqual(run(file, ['--hashes'], threads).trim().split(/\r?\n/), beforeHashes, `${name}: exact hashes, ${threads} native threads`);
      const actual = JSON.parse(run(file, flags, threads));
      assert.deepEqual(actual[0], catalogue, `${name}: exact catalogue/times`);
      for (let i = 1; i < actual.length; i += 3) {
        const frame = actual[i];
        const t = frame.sample.frame.timeSi;
        const expected = heat ? t : -4.905 * t * t;
        const tolerance = heat ? 1e-10 : 1e-12;
        const { values, ...metadata } = frame;
        const { values: nodeValues, ...nodeMetadata } = expectedResults[i];
        assert.deepEqual(metadata, nodeMetadata);
        assert.equal(frame.unit, heat ? 'K' : 'm');
        assert.equal(values.length, frame.nodeCount * 3);
        for (let j = 0; j < values.length; j++) {
          close(values[j], j % 3 === component ? expected : 0, tolerance, `${name}: native node ${j}`);
          close(nodeValues[j], j % 3 === component ? expected : 0, tolerance, `${name}: wasm node ${j}`);
          close(values[j], nodeValues[j], tolerance, `${name}: parity node ${j}`);
        }
        for (const response of [actual[i + 1], expectedResults[i + 1]]) {
          assert.deepEqual(response.sample, frame.sample);
          assert.equal(response.value.unit, heat ? 'degC' : 'mm');
          close(response.value.value, heat ? expected - 273.15 : expected * 1000, 1e-9, `${name}: probe`);
        }
        for (const response of [actual[i + 2], expectedResults[i + 2]]) {
          assert.deepEqual(response.sample, frame.sample);
          for (const value of response.values) close(value, heat ? expected - 273.15 : expected * 1000, 1e-9, `${name}: path`);
        }
      }
    }
    assert.deepEqual(query(engine, { query: 'query.journal' }), journalBefore);
    // Replay tooling itself, not only the binding, must preserve full-solve semantics.
    const wasmTool = path.join(root, 'tools/replay-wasm.mjs');
    assert.deepEqual(execFileSync(process.execPath, [wasmTool, file], { encoding: 'utf8' }).trim().split(/\r?\n/), beforeHashes);
    assert.deepEqual(JSON.parse(execFileSync(process.execPath, [wasmTool, file, '--query', '{"query":"query.frames"}'], { encoding: 'utf8' }))[0], catalogue);
    const skipped = new Engine(1);
    await skipped.replay_hashes(JSON.stringify(entries), true, true);
    for (const q of [{ query: 'query.frames' }, { query: 'query.frame', index: 0 }, { query: 'query.probe', field, at, sample: { kind: 'frame', index: 0 } }]) {
      assert.throws(() => query(skipped, q), error => error.code === 'not-found');
    }
    assert.throws(() => run(file, ['--skip-solves', '--query', '{"query":"query.frames"}']), error => JSON.parse(String(error.stderr)).code === 'not-found');
    engine.free(); skipped.free();
    console.log(`${name}: full-solve native (1/4 threads), Node WASM, exact hashes/times and analytical fields/probes/paths passed`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
