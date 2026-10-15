#!/usr/bin/env node
// #716: run the same real wasm32 import boundary in debug and optimized CI builds.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { batchModule } from './checked-batch.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = process.argv[2];
assert.ok(['debug', 'optimized'].includes(profile), 'identify the just-built WASM profile');
const binaryPath = path.join(root, 'tools/wasm-node/femlab_engine_wasm_bg.wasm');
const { Engine } = batchModule(createRequire(import.meta.url)(path.join(root, 'tools/wasm-node/femlab_engine_wasm.js')));
const ascii = readFileSync(path.join(root, 'crates/engine/tests/fixtures/stl/tetra-ascii-count-overflow.stl'));
assert.equal(ascii.readUInt32LE(80), 0x73737373, 'ordinary solid-name bytes overflow the old wasm32 detector');

// Independently authored outward tetrahedron: V=1/6, A=3/2+sqrt(3)/2, unit bounds.
const positions = [[0, 0, 0], [0, 1, 0], [1, 0, 0], [0, 0, 1]];
const triangles = [[0, 1, 2], [0, 3, 1], [0, 2, 3], [2, 1, 3]];
const binary = Buffer.alloc(284);
binary.writeUInt32LE(4, 80);
triangles.forEach((triangle, index) => triangle.forEach((vertex, corner) => positions[vertex].forEach((value, component) => {
  binary.writeFloatLE(value, 84 + 50 * index + 12 + 12 * corner + 4 * component);
})));
const query = (engine, input) => JSON.parse(engine.query(JSON.stringify(input)));
const imported = (bytes, encoding, name = 'part') => ({ cmd: 'geometry.import', name, format: 'stl', encoding, unitLength: '1 m', data: bytes.toString(encoding === 'base64' ? 'base64' : 'utf8') });
function oracle(body) {
  assert.equal(body.measure.unit, 'm^3');
  assert.ok(Math.abs(body.measure.value - 1 / 6) < 1e-14);
  assert.deepEqual(body.bbox.map(quantity => quantity.value), [0, 0, 0, 1, 1, 1]);
  assert.ok(Math.abs(body.patches.reduce((sum, patch) => sum + patch.area.value, 0) - (1.5 + Math.sqrt(3) / 2)) < 1e-12);
}
for (const [bytes, encoding] of [[ascii, 'utf8'], [binary, 'base64']]) {
  const engine = new Engine(1);
  try {
    await engine.dispatch(JSON.stringify(imported(bytes, encoding)));
    oracle(query(engine, { query: 'query.model' }).bodies[0]);
    const before = engine.export_file();
    for (const count of [85899345, 85899346, 0x80000004, 0xffffffff]) {
      const malformed = Buffer.from(binary);
      malformed.writeUInt32LE(count, 80);
      if (count === 0x80000004) assert.equal(Number((84n + 50n * BigInt(count)) & 0xffffffffn), binary.length);
      await assert.rejects(engine.dispatch(JSON.stringify(imported(malformed, 'base64'))), error => {
        assert.equal(error.code, 'schema');
        assert.equal(error.where, 'data');
        assert.ok(error.cause.includes('neither a binary STL'));
        assert.equal(typeof error.suggestion, 'string');
        return true;
      });
      assert.equal(engine.export_file(), before, 'malformed lengths must preserve the model and Journal');
    }
    await engine.dispatch(JSON.stringify(imported(ascii, 'utf8', 'after')));
    const bodies = query(engine, { query: 'query.model' }).bodies;
    assert.equal(bodies.length, 2);
    oracle(bodies.find(body => body.name === 'after'));
  } finally { engine.free(); }
}
console.log(JSON.stringify({ profile, wasmSha256: createHash('sha256').update(readFileSync(binaryPath)).digest('hex'), checks: 'ASCII and binary analytic tetra; four oversized count boundaries; structured atomic rejection and continued use', status: 'PASS' }));
