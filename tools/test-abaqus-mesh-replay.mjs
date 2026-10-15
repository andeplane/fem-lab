#!/usr/bin/env node
// #502: independent input conversion and ordinary Journal replay agree natively and in WASM.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { batchModule } from './checked-batch.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const native = process.env.FEMLAB_NATIVE ?? path.join(root, 'target/release/femlab');
const { Engine } = batchModule(createRequire(import.meta.url)(path.join(root, 'tools/wasm-node/femlab_engine_wasm.js')));
const scratch = mkdtempSync(path.join(tmpdir(), 'femlab-abaqus-replay-'));
const empty = path.join(scratch, 'empty.json');
writeFileSync(empty, '[]');

function request(text, unitLength) {
  return { query: 'query.convertAbaqus', text, name: 'Abaqus parity', body: 'part', mode: 'mesh', unitLength, sha256: createHash('sha256').update(text).digest('hex') };
}
function query(engine, value) { return JSON.parse(engine.query(JSON.stringify(value))); }
function nativeQueries(file, threads, queries) {
  return JSON.parse(execFileSync(native, ['run', file, '--cpu', '--threads', String(threads), '--verify', ...queries.flatMap(value => ['--query', JSON.stringify(value)])], { encoding: 'utf8' }));
}

try {
  for (const [fixture, unitLength, authored, active, unused, bounds, formulation] of [
    ['sparse-label-tet.inp', '1 m', 5, 4, [99], [0, 0, 0, 1, 1, 1], 'full'],
    ['brick-sets.inp', '1 mm', 8, 8, [], [0, 0, 0, 1, 2, 3], 'mean-dilatation'],
    ['far-unused-tet.inp', '1 m', 5, 4, [99], [0, 0, 0, 1, 1, 1], 'full'],
    ['signed-zero-tet.inp', '1 m', 5, 4, [99], [0, 0, 0, 1, 1, 1], 'full'],
    ['signed-zero-hex.inp', '1 mm', 8, 8, [], [0, 0, 0, 1, 2, 3], 'mean-dilatation'],
  ]) {
    const text = readFileSync(path.join(root, 'crates/engine/tests/fixtures/abaqus', fixture), 'utf8');
    const conversionQuery = request(text, unitLength);
    const engine = new Engine(1);
    try {
      const before = engine.export_file();
      const converted = query(engine, conversionQuery);
      assert.equal(engine.export_file(), before);
      assert.equal(converted.report.sourceNodes, authored);
      assert.equal(converted.report.activeNodes, active);
      assert.deepEqual(converted.report.sourceLabels.unusedNodes ?? [], unused);
      assert.deepEqual(converted.report.bbox.map(value => value.value), bounds);
      assert.equal(converted.report.analysisConfigured, false);
      assert.deepEqual(converted.commands.map(command => command.cmd), ['model.new', 'model.setIdealisation', 'mesh.set']);
      assert.equal(converted.commands[2].formulation, formulation);
      assert.equal(converted.commands[2].order, 1);
      assert.equal(converted.commands[2].mesher.provenance.sha256, conversionQuery.sha256);
      for (const threads of [1, 4]) assert.deepEqual(nativeQueries(empty, threads, [conversionQuery]), [converted]);

      // The actual native host constructs the ModelFile; neither test nor browser synthesizes
      // a Model snapshot. Exercise its raw text and the browser's JSON parse/stringify route.
      const commandsPath = path.join(scratch, 'commands.json');
      writeFileSync(commandsPath, JSON.stringify(converted.commands));
      const nativeFileText = execFileSync(native, ['export', commandsPath, '--cpu', '--format', 'journal'], { encoding: 'utf8' });
      const nativeFile = JSON.parse(nativeFileText);
      const nativeHashes = nativeFile.journal.entries.map(entry => entry.hashAfter);
      for (const text of [nativeFileText, JSON.stringify(nativeFile)]) {
        await engine.import_file(text);
        assert.deepEqual(JSON.parse(engine.export_file()).journal.entries.map(entry => entry.hashAfter), nativeHashes);
      }

      for (const command of converted.commands) await engine.dispatch(JSON.stringify(command));
      const file = JSON.parse(engine.export_file());
      const entriesPath = path.join(scratch, 'journal.json');
      const modelPath = path.join(scratch, 'model.json');
      writeFileSync(entriesPath, JSON.stringify(file.journal.entries));
      writeFileSync(modelPath, JSON.stringify(file));
      // Both persisted formats contain all source data. Replay never receives the original text.
      const queries = [{ query: 'query.mesh' }, { query: 'query.model' }];
      const expected = queries.map(value => query(engine, value));
      const hashes = file.journal.entries.map(entry => entry.hashAfter);
      for (const threads of [1, 4]) {
        for (const source of [entriesPath, modelPath]) {
          const actual = execFileSync(native, ['run', source, '--cpu', '--threads', String(threads), '--verify', '--skip-solves', '--hashes'], { encoding: 'utf8' }).trim().split(/\r?\n/);
          assert.deepEqual(actual, hashes);
          assert.deepEqual(nativeQueries(source, threads, queries), expected);
        }
      }
      assert.deepEqual(JSON.parse(await engine.replay_hashes(JSON.stringify(file.journal.entries), true, true)), hashes);
      assert.deepEqual(queries.map(value => query(engine, value)), expected);

      const bad = request('*MATERIAL,NAME=STEEL\n', unitLength);
      let wasmError;
      try { query(engine, bad); } catch (error) { wasmError = error; }
      assert.equal(wasmError?.code, 'unsupported');
      const nativeError = spawnSync(native, ['run', entriesPath, '--cpu', '--query', JSON.stringify(bad)], { encoding: 'utf8' });
      assert.equal(nativeError.status, 1);
      const parsedError = JSON.parse(nativeError.stderr.trim());
      assert.equal(parsedError.code, wasmError.code);
      assert.equal(parsedError.cause, wasmError.cause);
      assert.equal(parsedError.where, wasmError.where);
      assert.equal(parsedError.suggestion, wasmError.suggestion);
      assert.deepEqual(queries.map(value => query(engine, value)), expected);
      console.log(`${fixture}: exact conversion report/Commands, read-only failures and persisted native1/4-thread/WASM replay passed.`);
    } finally { engine.free(); }
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
