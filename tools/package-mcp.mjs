#!/usr/bin/env node
// npm prepack: ship the same Node engine that the native/WASM parity lane validates.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
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

// Never publish a package that silently falls back to pathname checks. Local packs need
// the current host; release packs require the complete existing four-platform matrix.
const helperSource = path.join(root, 'tools/project-io');
const helperDestination = path.join(root, 'packages/mcp/dist/project-io');
const platforms = process.env.FEMLAB_RELEASE_HELPERS === 'all'
  ? ['linux-x64', 'darwin-arm64', 'darwin-x64', 'win32-x64']
  : [`${process.platform}-${process.arch}`];
const manifest = {};
for (const platform of platforms) {
  const filename = platform === 'win32-x64' ? 'femlab-project-io.exe' : 'femlab-project-io';
  const source = path.join(helperSource, platform, filename);
  const bytes = readFileSync(source);
  if (!statSync(source).isFile() || bytes.length === 0) throw new Error(`Build the project I/O helper for ${platform} before packing`);
  manifest[`${platform}/${filename}`] = createHash('sha256').update(bytes).digest('hex');
}
rmSync(helperDestination, { recursive: true, force: true });
mkdirSync(helperDestination, { recursive: true });
for (const relative of Object.keys(manifest)) {
  const target = path.join(helperDestination, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(path.join(helperSource, relative), target);
}
writeFileSync(path.join(helperDestination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Packaged verified project filesystem helpers: ${Object.keys(manifest).join(', ')}`);
