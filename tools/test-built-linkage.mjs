// Evaluate the real emitted registry/Zod graph, without a UI, engine, providers or browser
// globals. Source tests transform modules separately and miss cross-chunk helper-init cycles.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'packages/app/dist');
const manifest = JSON.parse(readFileSync(path.join(dist, '.vite/manifest.json'), 'utf8'));
const assistant = manifest['src/ai/index.ts'];
assert.ok(assistant?.isDynamicEntry, 'the real lazy assistant entry must be present');
// Vite records the chunk containing the actual Registry implementation. Chunk names change
// when another host starts using a shared export; a guessed name is not source identity.
const linkage = JSON.parse(readFileSync(path.join(dist, '.vite/registry-linkage.json'), 'utf8'));
const registry = Object.values(manifest).find(chunk => chunk.file === linkage.file);
assert.ok(registry, 'the real shared registry package entry must be present');
const closure = new Set();
const visit = chunk => {
  if (closure.has(chunk.file)) return;
  closure.add(chunk.file);
  for (const key of chunk.imports ?? []) visit(manifest[key]);
};
visit(assistant);
assert.ok(closure.has(registry.file), 'the assistant must import the real shared registry');
const shared = await import(pathToFileURL(path.join(dist, registry.file)).href);
const registries = Object.values(shared).filter(value => typeof value === 'function'
  && typeof value.prototype?.list === 'function' && typeof value.prototype?.describe === 'function'
  && typeof value.prototype?.dispatch === 'function');
assert.equal(registries.length, 1, 'the linked module must expose the real headless Registry API');
console.log(`built headless registry/Zod graph initializes: ${registry.file}`);
