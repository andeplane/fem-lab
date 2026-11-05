// Run after the normal Node WASM build: node tools/generate-le10-original.mjs
// All geometry is authored through the public registry, then exported and converted.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { batchModule } from './checked-batch.mjs';
import { originalLe10Source } from './le10-original.mjs';

const require = createRequire(import.meta.url);
const { Engine } = batchModule(require('./wasm-node/femlab_engine_wasm.js'));
const root = new URL('../', import.meta.url);
for (const [n, layers] of [[4, 2], [4, 4], [6, 6]]) {
  const { mesh, source, sha256 } = await originalLe10Source(Engine, n, layers);
  const size = `${n}x${n}x${layers}`;
  writeFileSync(new URL(`tools/fixtures/le10-original/${size}.inp`, root), source);
  if (n === 4) {
    writeFileSync(new URL(`packages/app/test/fixtures/le10-original/${size}.mesh.json`, root), JSON.stringify(mesh));
  } else {
    const file = new URL('packages/app/tutorials/le10-original.json', root);
    const tutorial = JSON.parse(readFileSync(file, 'utf8'));
    const step = tutorial.steps.find(step => step.doIt?.cmd === 'mesh.set');
    step.doIt = '__GENERATED_MESH__';
    step.fields.sha256 = sha256;
    // Keep generated connectivity compact, and the teaching text reviewable.
    writeFileSync(file, `${JSON.stringify(tutorial, null, 2).replace('"__GENERATED_MESH__"', JSON.stringify(mesh))}\n`);
  }
  console.log(`${size}: ${sha256} (${fileURLToPath(root)})`);
}
