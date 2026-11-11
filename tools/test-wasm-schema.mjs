#!/usr/bin/env node
// The actual WASM export and cached native schema must match the committed build input (#844).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const read = relative => JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'));
const committed = read('../packages/registry/src/generated/engine.schema.json');
const wasm = createRequire(import.meta.url)('./wasm-node/femlab_engine_wasm.js');
assert.deepEqual(JSON.parse(wasm.schema()), committed, 'WASM embeds a stale engine schema; rebuild the bundle');
assert.deepEqual(read('../engine.schema.json'), committed, 'native schema is stale; regenerate and rebuild the bundle');
console.log('WASM and native schemas match the committed registry schema');
