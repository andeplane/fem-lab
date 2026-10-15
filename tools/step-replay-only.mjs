// Copied with only the checked FEM module pair, native executable and portable documents into
// a disposable directory. Neither this process nor native replay has a converter or STEP file.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { batchModule } from './checked-batch.mjs';
const require = createRequire(import.meta.url);
const { Engine } = batchModule(require('./wasm-node/femlab_engine_wasm.js'));
const cases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));
// Expected queries cross JSON.stringify in cases.json, which writes -0 as 0. Native
// serde preserves -0 in derived face normals. Compare that one JSON semantic equivalence
// explicitly; every other scalar, complete query structure and Journal hash stays exact.
const jsonZero = value => typeof value === 'number' && Object.is(value, -0) ? 0
  : Array.isArray(value) ? value.map(jsonZero)
  : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonZero(item)]))
  : value;
for (const item of cases) {
  const file = JSON.parse(readFileSync(item.file, 'utf8'));
  const hashes = file.journal.entries.map(entry => entry.hashAfter);
  const engine = new Engine(1);
  try {
    await engine.import_file(JSON.stringify(file));
    const query = input => JSON.parse(engine.query(JSON.stringify(input)));
    const got = item.queries.map(query);
    assert.deepEqual(got, item.expected, `${item.name}: converter-free WASM import`);
    assert.deepEqual(JSON.parse(await engine.replay_hashes(JSON.stringify(file.journal.entries), false, true)), hashes);
    assert.deepEqual(item.queries.map(query), item.expected, `${item.name}: converter-free WASM Journal replay`);
    for (const source of [item.file, item.journal]) for (const threads of [1, 4]) {
      const args = ['run', source, '--cpu', '--threads', String(threads), '--verify'];
      const nativeHashes = execFileSync('./femlab', [...args, '--hashes'], { encoding: 'utf8' }).trim().split(/\r?\n/);
      assert.deepEqual(nativeHashes, hashes, `${item.name}: native ${threads} thread hashes`);
      const result = JSON.parse(execFileSync('./femlab', [...args, ...item.queries.flatMap(input => ['--query', JSON.stringify(input)])], { encoding: 'utf8' }));
      assert.deepEqual(jsonZero(result), item.expected, `${item.name}: native ${threads} thread geometry/Mesh/Set`);
    }
  } finally { engine.free(); }
}
console.log(`Converter-free native 1/4 and Node WASM full geometry/hash replay: ${cases.length} cases passed.`);
