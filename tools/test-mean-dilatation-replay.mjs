#!/usr/bin/env node
// #343/#8: analytic near-incompressible C3 checks, Step overrides, and native/WASM replay.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { batchModule } from './checked-batch.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const native = process.env.FEMLAB_NATIVE ?? path.join(root, 'target/release/femlab');
const wasmOnly = process.argv.includes('--wasm-only');
const { Engine } = batchModule(createRequire(import.meta.url)(path.join(root, 'tools/wasm-node/femlab_engine_wasm.js')));
const scratch = mkdtempSync(path.join(tmpdir(), 'femlab-bbar-replay-'));
const picked = (answer, pointer) => pointer.split('/').slice(1).reduce((value, key) => value[key], answer);
const passes = (value, check) => typeof check.expect === 'number'
  ? Math.abs(value - check.expect) <= check.tol * (check.rel ? Math.abs(check.expect) : 1)
  : value === check.expect;
try {
  for (const name of ['c3-bbar-axisymmetric-quad4', 'c3-bbar-plane-strain-quad4']) {
    const original = JSON.parse(readFileSync(path.join(root, 'crates/femlab/benches/cases', `${name}.json`), 'utf8'));
    let meshBbar;
    for (const mode of ['mesh-bbar', 'full-control', 'step-bbar']) {
      const input = structuredClone(original);
      input.journal.find(command => command.cmd === 'mesh.set').formulation = mode === 'mesh-bbar' ? 'mean-dilatation' : 'full';
      if (mode === 'step-bbar') input.journal.find(command => command.cmd === 'step.add').formulation = 'mean-dilatation';
      const engine = new Engine(1);
      const query = q => JSON.parse(engine.query(JSON.stringify(q)));
      try {
        for (const command of input.journal) await engine.dispatch(JSON.stringify(command));
        const expected = input.checks.map(check => picked(query(check.query), check.path));
        const checks = expected.map((value, index) => passes(value, input.checks[index]));
        if (mode === 'full-control') assert.ok(checks.slice(0, 3).every(pass => !pass), `${name}: Full must expose locking and spurious bore stresses`);
        else assert.ok(checks.every(Boolean), `${name}/${mode}: independent Lamé displacement, radial/hoop stress and freshness`);
        if (mode === 'mesh-bbar') meshBbar = expected;
        if (mode === 'step-bbar') assert.deepEqual(expected, meshBbar, 'Step override selects exactly the same operator and recovery');
        const entries = JSON.parse(engine.export_file()).journal.entries;
        const hashes = entries.map(entry => entry.hashAfter);
        const file = path.join(scratch, `${name}-${mode}.json`);
        writeFileSync(file, JSON.stringify(entries));
        if (!wasmOnly) for (const threads of [1, 4]) {
          const args = ['run', file, '--cpu', '--threads', String(threads), '--verify'];
          assert.deepEqual(execFileSync(native, [...args, '--hashes'], { encoding: 'utf8' }).trim().split(/\r?\n/), hashes);
          const queries = input.checks.flatMap(check => ['--query', JSON.stringify(check.query)]);
          const actual = JSON.parse(execFileSync(native, [...args, ...queries], { encoding: 'utf8' }));
          actual.forEach((answer, index) => {
            const value = picked(answer, input.checks[index].path);
            assert.equal(passes(value, input.checks[index]), checks[index], `${name}/${mode}: same independent native acceptance`);
            if (typeof value !== 'number') assert.equal(value, expected[index]);
            else {
              // These highly conditioned nu=.4999 solves amplify platform arithmetic. The
              // dimensional host-parity allowance is still far below the physical 2% gate.
              const allowance = index === 0 ? 1e-11 : 1e-3; // displacement m; stresses MPa.
              assert.ok(Math.abs(value - expected[index]) < allowance, `${name}/${mode}: native/WASM probe ${index}`);
            }
          });
        }
        assert.deepEqual(JSON.parse(await engine.replay_hashes(JSON.stringify(entries), false, true)), hashes);
        assert.deepEqual(input.checks.map(check => picked(query(check.query), check.path)), expected);
      } finally { engine.free(); }
    }
  }
  console.log(`C3 B-bar/Full negative controls, exact Step override and ${wasmOnly ? 'WASM-only' : 'native 1/4-thread plus WASM'} Journal/probe replay passed.`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
