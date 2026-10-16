#!/usr/bin/env node
// The bundle budget of plan C row 37, gated in CI (`npm run size`). Two numbers matter:
//
//   landing JS   the isolation bootstrap plus main/viewer static import closures — everything that
//                must run before the usable start screen. Main's dynamic bootstrap import is
//                still charged here. User-requested modules such as the tutorial runner do not.
//   cold boot    landing + the chunks `index.html` preloads + the largest actual engine runtime
//                closure (portable or threaded, including nested pool Workers). The browser
//                selects one runtime. Pages additionally pays for its initial bootstrap page
//                before the controlled reload; main itself starts only after that decision.
//
// The static/dynamic split comes from Vite's `dist/.vite/manifest.json` (`build.manifest`), not
// from guessing at filenames, so a static import sneaking back into the entry moves the number.
import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeClosures } from './size-runtime.mjs';

const LANDING_JS_GZ = 1024 * 1024; // 1 MB
const COLD_BOOT_GZ = 3 * 1024 * 1024; // 3 MB

const dist = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'packages', 'app', 'dist');
const manifest = JSON.parse(readFileSync(path.join(dist, '.vite', 'manifest.json'), 'utf8'));

const landing = new Set();
const walk = (c, into = landing) => {
  if (!c || into.has(c.file)) return;
  into.add(c.file);
  for (const css of c.css ?? []) into.add(css);
  for (const k of c.imports ?? []) walk(manifest[k], into);
};
// Other documents (e.g. the auth host) are separate entries, not part of the engine landing.
if (!manifest['index.html']?.isEntry) throw new Error('Engine landing entry is missing.');
walk(manifest['index.html']);
const application = new Set();
const main = Object.values(manifest).find(c => c.src === 'src/main.tsx');
if (!main?.isDynamicEntry) throw new Error('The application must load dynamically after the isolation bootstrap');
walk(main, application);
// Bootstrap warms the renderer after isolation and before exposing view Commands.
const viewer = Object.values(manifest).find(c => c.src === 'src/viewer/viewer.ts');
if (!viewer?.isDynamicEntry) throw new Error('The startup Viewer must remain a separate dynamic entry');
walk(viewer, application);

// Any static module preloads are boot traffic, including future additions to the HTML.
const preloaded = new Set([...readFileSync(path.join(dist, 'index.html'), 'utf8').matchAll(/rel="modulepreload"[^>]*href="[^"]*\/([^"/]+)"/g)].map((m) => `assets/${m[1]}`));

const files = readdirSync(path.join(dist, 'assets')).map((f) => `assets/${f}`).concat('index.html');
const runtimes = runtimeClosures(files, file => readFileSync(path.join(dist, file), 'utf8'));
const runtimeFiles = new Set(runtimes.flatMap(runtime => [...runtime.files]));
const gz = (f) => gzipSync(readFileSync(path.join(dist, f)), { level: 9 }).length;
const kb = (n) => `${(n / 1024).toFixed(1)} kB`.padStart(11);

let landingJs = 0;
const initialPage = new Set([...landing, ...preloaded, 'index.html']);
const common = new Set([...initialPage, ...application]);
const bootSizes = runtimes.map(runtime => ({ ...runtime, gzip: [...new Set([...common, ...runtime.files])].reduce((total, file) => total + gz(file), 0) }));
const sessionBoot = Math.max(...bootSizes.map(runtime => runtime.gzip));
// Pages first loads an uncontrolled document and then reloads under COI. Main and engine startup
// wait for that decision. Charge initial bootstrap/preloads twice even if HTTP caching reuses
// them, main once, and the service-worker script as extra boot traffic.
const repeatedPage = [...initialPage].reduce((total, file) => total + gz(file), 0);
const boot = sessionBoot + repeatedPage + gz('coi-serviceworker.min.js');
const rows = [];
for (const f of files.sort()) {
  const raw = statSync(path.join(dist, f)).size;
  const z = gz(f);
  const isLanding = landing.has(f) || application.has(f) || f === 'index.html';
  const when = isLanding ? 'landing' : preloaded.has(f) || application.has(f) ? 'boot' : runtimeFiles.has(f) ? 'runtime' : 'on demand';
  if (isLanding && f.endsWith('.js')) landingJs += z;
  rows.push([f, raw, z, when]);
}

console.log('  raw          gzip       when       file');
for (const [f, raw, z, when] of rows) console.log(`${kb(raw)}${kb(z)}  ${when.padEnd(10)} ${f}`);
console.log(`\n  landing JS   ${kb(landingJs).trim()} gz   budget ${kb(LANDING_JS_GZ).trim()}`);
console.log(`  cold boot    ${kb(boot).trim()} gz   budget ${kb(COLD_BOOT_GZ).trim()}`);
console.log(`  one session  ${kb(sessionBoot).trim()} gz; Pages additionally charges ${kb(repeatedPage).trim()} for the initial document plus its isolation worker`);
for (const runtime of bootSizes) console.log(`    ${kb(runtime.gzip).trim()} gz with ${runtime.binary}`);

const over = [
  landingJs > LANDING_JS_GZ ? `landing JS is ${kb(landingJs).trim()} gz, over the ${kb(LANDING_JS_GZ).trim()} budget` : null,
  boot > COLD_BOOT_GZ ? `cold boot is ${kb(boot).trim()} gz, over the ${kb(COLD_BOOT_GZ).trim()} budget` : null,
].filter(Boolean);
if (over.length > 0) {
  console.error(`\n${over.join('\n')}`);
  process.exit(1);
}
console.log('\nwithin budget');
