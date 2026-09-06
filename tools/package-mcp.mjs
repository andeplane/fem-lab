#!/usr/bin/env node
// npm prepack: ship the same Node engine that the native/WASM parity lane validates.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'tools/wasm-node');
const destination = path.join(root, 'packages/mcp/dist/wasm-node');
// Fail before changing the packaged engine when the build is absent or invalid.
readFileSync(path.join(source, 'femlab_engine_wasm.js'));
const binary = readFileSync(path.join(source, 'femlab_engine_wasm_bg.wasm'));
if (!WebAssembly.validate(binary)) throw new Error('Build the Node engine with node tools/build-wasm.mjs before packing');
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
cpSync(source, destination, { recursive: true });
// wasm-bindgen's Node output uses require/module.exports inside an ESM npm package.
writeFileSync(path.join(destination, 'package.json'), JSON.stringify({ type: 'commonjs' }) + '\n');
cpSync(path.join(root, 'LICENSE'), path.join(root, 'packages/mcp/dist/LICENSE'));
console.log('Packaged the Node WASM engine in dist/wasm-node');
