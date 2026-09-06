#!/usr/bin/env node
// The bundle budget of plan C row 37, gated in CI (`npm run size`). Two numbers matter:
//
//   landing JS   the entry chunk and its *static* import closure — what must be parsed and run
//                before the start screen can paint. Everything else (three.js, the two AI SDKs,
//                the tutorial runner, sucrase) is behind an `import()` and does not count.
//   cold boot    landing + the chunks `index.html` preloads + the engine Worker and the wasm
//                module it fetches at once. The whole download before anyone clicks anything.
//
// The static/dynamic split comes from Vite's `dist/.vite/manifest.json` (`build.manifest`), not
// from guessing at filenames, so a static import sneaking back into the entry moves the number.
import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LANDING_JS_GZ = 1024 * 1024; // 1 MB
const COLD_BOOT_GZ = 3 * 1024 * 1024; // 3 MB
/** Fetched at boot without being a static import: the engine Worker and its wasm module. */
const BOOT = /(^|\/)engine\.worker-[^/]*\.js$|\.wasm$/;

const dist = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'packages', 'app', 'dist');
const manifest = JSON.parse(readFileSync(path.join(dist, '.vite', 'manifest.json'), 'utf8'));

const landing = new Set();
const walk = (c) => {
  if (!c || landing.has(c.file)) return;
  landing.add(c.file);
  for (const css of c.css ?? []) landing.add(css);
  for (const k of c.imports ?? []) walk(manifest[k]);
};
walk(Object.values(manifest).find((c) => c.isEntry));

// `index.html` starts these itself (vite.config.ts injects the links), so they are boot traffic.
const preloaded = new Set([...readFileSync(path.join(dist, 'index.html'), 'utf8').matchAll(/rel="modulepreload"[^>]*href="[^"]*\/([^"/]+)"/g)].map((m) => `assets/${m[1]}`));

const files = readdirSync(path.join(dist, 'assets')).map((f) => `assets/${f}`).concat('index.html');
const gz = (f) => gzipSync(readFileSync(path.join(dist, f)), { level: 9 }).length;
const kb = (n) => `${(n / 1024).toFixed(1)} kB`.padStart(11);

let landingJs = 0;
let boot = 0;
const rows = [];
for (const f of files.sort()) {
  const raw = statSync(path.join(dist, f)).size;
  const z = gz(f);
  const isLanding = landing.has(f) || f === 'index.html';
  const when = isLanding ? 'landing' : preloaded.has(f) || BOOT.test(f) ? 'boot' : 'on demand';
  if (isLanding && f.endsWith('.js')) landingJs += z;
  if (when !== 'on demand') boot += z;
  rows.push([f, raw, z, when]);
}

console.log('  raw          gzip       when       file');
for (const [f, raw, z, when] of rows) console.log(`${kb(raw)}${kb(z)}  ${when.padEnd(10)} ${f}`);
console.log(`\n  landing JS   ${kb(landingJs).trim()} gz   budget ${kb(LANDING_JS_GZ).trim()}`);
console.log(`  cold boot    ${kb(boot).trim()} gz   budget ${kb(COLD_BOOT_GZ).trim()}`);

const over = [
  landingJs > LANDING_JS_GZ ? `landing JS is ${kb(landingJs).trim()} gz, over the ${kb(LANDING_JS_GZ).trim()} budget` : null,
  boot > COLD_BOOT_GZ ? `cold boot is ${kb(boot).trim()} gz, over the ${kb(COLD_BOOT_GZ).trim()} budget` : null,
].filter(Boolean);
if (over.length > 0) {
  console.error(`\n${over.join('\n')}`);
  process.exit(1);
}
console.log('\nwithin budget');
