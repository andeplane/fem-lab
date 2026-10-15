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
  // #286: two immutable solves, unequal retained schedules/meshes and explicit sampled
  // differences cross the same checked batch, portable Journal and native CLI routes.
  for (const kind of ['heat', 'explicit-2d', 'explicit-3d']) for (const order of [1, 2]) for (const nx of [2, 4]) {
    const name = `comparison-${kind}-o${order}-n${nx}`, heat = kind === 'heat';
    const recorder = new Engine(1), replay = new Engine(1), skipped = new Engine(1);
    try {
      const commands = JSON.parse(readFileSync(path.join(root, `tools/fixtures/transient-${kind}.json`)));
      const mesh = commands.find(c => c.cmd === 'mesh.set'), step = commands.find(c => c.cmd === 'step.add');
      mesh.order = order;
      if (mesh.mesher.kind === 'mapped') mesh.mesher.blocks[0].n[0] = nx;
      else mesh.mesher.size.nx = nx;
      if (heat) Object.assign(step, { dt: '0.2 s', tEnd: '1 s', amplitude: { kind: 'table', t: ['0 s', '1 s'], value: [0, 1] } });
      commands.find(c => c.cmd === 'solve.run').solver = 'cpu-direct';
      for (const command of commands) await recorder.dispatch(JSON.stringify(command));
      const left = query(recorder, { query: 'query.result' }).resultId;
      await recorder.dispatch(JSON.stringify({ cmd: 'model.setUnits', units: { temperature: 'K', time: 's' } }));
      if (heat) {
        // Half overlap makes unavailable coverage observable, without changing the uniform oracle.
        await recorder.dispatch(JSON.stringify({ cmd: 'geometry.addBox', name: 'bar', size: ['1 m', '0.1 m', '0.1 m'], at: ['0.5 m', '0 m', '0 m'] }));
        await recorder.dispatch(JSON.stringify({ cmd: 'load.heatSource', name: 'source', bodies: ['bar'], q: '12 W/m^3' }));
      }
      const nextMesh = structuredClone(mesh);
      if (nextMesh.mesher.kind === 'mapped') nextMesh.mesher.blocks[0].n[0] = 2 * nx;
      else nextMesh.mesher.size.nx = 2 * nx;
      await recorder.dispatch(JSON.stringify(nextMesh));
      const nextStep = { ...step, ...(heat ? { dt: '0.4 s', tEnd: '0.9 s', outputEvery: 1, amplitude: { kind: 'table', t: ['0 s', '0.9 s'], value: [0, 1.8] } }
        : { tEnd: '1.7 ms', dtFactor: 0.9, outputEvery: 2 }) };
      await recorder.dispatch(JSON.stringify(nextStep));
      await recorder.dispatch(JSON.stringify({ cmd: 'solve.run', step: step.name, solver: 'cpu-direct' }));
      const right = query(recorder, { query: 'query.result' }).resultId;
      const fileBefore = JSON.parse(recorder.export_file()), entries = fileBefore.journal.entries, hashes = entries.map(e => e.hashAfter);
      const file = path.join(scratch, `${name}.json`); writeFileSync(file, JSON.stringify(entries));
      assert.deepEqual(JSON.parse(await replay.replay_hashes(JSON.stringify(entries), false, true)), hashes);
      const field = heat ? 'temperature' : 'displacement', component = heat ? 0 : 1;
      const ids = [left, right], histories = ids.map(resultId => query(recorder, { query: 'query.frames', resultId }));
      const operand = (resultId, sample) => ({ resultId, field, component, ...(sample ? { sample } : {}) });
      const samples = [
        [operand(left, { kind: 'frame', index: 1 }), operand(right, { kind: 'frame', index: 1 })],
        [operand(left, { kind: 'frame', index: histories[0].frames.length - 1 }), operand(right, { kind: 'frame', index: histories[1].frames.length - 1 })],
        [operand(left), operand(right)],
        [operand(left, { kind: 'frame', index: 1 }), operand(right)],
        [operand(left, { kind: 'frame', index: 1 }), operand(left, { kind: 'frame', index: histories[0].frames.length - 1 })],
        ...(heat ? [[operand(left, { kind: 'time', time: '400 ms', sampling: 'exact' }), operand(right, { kind: 'time', time: '450 ms', sampling: 'nearest' })]] : []),
      ];
      const queries = ids.flatMap(resultId => [{ query: 'query.frames', resultId }, { query: 'query.surface', resultId }]);
      for (let side = 0; side < ids.length; side++) for (const stamp of histories[side].frames) queries.push({ query: 'query.frame', resultId: ids[side], field, sample: { kind: 'frame', index: stamp.index } });
      for (const [a, b] of samples) for (const onto of ['left', 'right']) for (const reverse of [false, true]) queries.push({ query: 'query.difference', left: reverse ? b : a, right: reverse ? a : b, onto });
      const expected = queries.map(q => query(recorder, q));
      const exact = (id, time) => heat ? (id === left ? 1 : 2) * time : -4.905 * time * time;
      const tolerance = heat ? 1e-10 : 1e-12;
      const oracle = response => {
        if (response.sample) {
          const value = exact(response.sample.resultId, response.sample.frame.timeSi);
          response.values.forEach((v, i) => close(v, i % 3 === component ? value : 0, tolerance, `${name}: primary closed form ${i}`));
        } else if (response.left) {
          const actualTime = side => side.sample?.frame.timeSi ?? histories[ids.indexOf(side.resultId)].frames.at(-1).timeSi;
          const value = exact(response.left.resultId, actualTime(response.left)) - exact(response.right.resultId, actualTime(response.right));
          response.values.forEach((v, i) => { if (v !== null) close(v, value, tolerance, `${name}: sampled difference closed form ${i}`); });
          assert.equal(response.coverage.outsideNodes.length, response.values.filter(v => v === null).length);
          if (heat && response.left.resultId !== response.right.resultId) assert.ok(response.coverage.outsideNodes.length > 0);
        }
      };
      expected.forEach(oracle);
      for (const q of queries) {
        const actual = query(replay, q), wanted = query(recorder, q);
        const { values, ...metadata } = actual, { values: recordedValues, ...recordedMetadata } = wanted;
        assert.deepEqual(metadata, recordedMetadata);
        if (values) values.forEach((value, i) => value === null ? assert.equal(recordedValues[i], null) : close(value, recordedValues[i], tolerance, `${name}: WASM replay ${i}`));
        oracle(actual);
      }
      for (const threads of [1, 4]) {
        assert.deepEqual(run(file, ['--hashes'], threads).trim().split(/\r?\n/), hashes);
        const results = JSON.parse(run(file, queries.flatMap(q => ['--query', JSON.stringify(q)]), threads));
        for (let i = 0; i < results.length; i++) {
          const { values, ...metadata } = results[i], { values: wasmValues, ...wasmMetadata } = expected[i];
          assert.deepEqual(metadata, wasmMetadata, `${name}: native${threads} metadata${i}`);
          if (values) values.forEach((value, j) => value === null ? assert.equal(wasmValues[j], null) : close(value, wasmValues[j], tolerance, `${name}: native${threads} values${i}:${j}`));
          oracle(results[i]);
        }
      }
      const transferQuery = queries.find(q => q.query === 'query.difference');
      for (let i = 0; i < 2; i++) {
        const staged = recorder.query_transfer(JSON.stringify(transferQuery)), original = Array.from(staged.values), validity = Array.from(staged.valid);
        assert.ok(staged.values instanceof Float64Array); assert.ok(staged.valid instanceof Uint8Array);
        const received = structuredClone(staged, { transfer: [staged.values.buffer, staged.valid.buffer] });
        assert.equal(staged.values.buffer.byteLength, 0); assert.equal(staged.valid.buffer.byteLength, 0);
        received.values.fill(99); received.valid.fill(0);
        const fresh = recorder.query_transfer(JSON.stringify(transferQuery)); assert.deepEqual(Array.from(fresh.values), original); assert.deepEqual(Array.from(fresh.valid), validity);
      }
      assert.deepEqual(JSON.parse(recorder.export_file()), fileBefore);
      await skipped.replay_hashes(JSON.stringify(entries), true, true);
      const unavailable = { query: 'query.difference', left: samples[0][0], right: samples[0][1], onto: 'left' };
      assert.throws(() => query(skipped, unavailable), error => error.code === 'not-found');
      assert.throws(() => run(file, ['--skip-solves', '--query', JSON.stringify(unavailable)]), error => JSON.parse(String(error.stderr)).code === 'not-found');
      console.log(`${name}: immutable sampled identities/times, analytical null coverage, transfer ownership and full-solve native1/4/WASM replay passed`);
    } finally { recorder.free(); replay.free(); skipped.free(); }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
