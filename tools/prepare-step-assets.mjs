// The web build must distribute the preferred converter source with its executable.
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const safe = path => {
  if (typeof path !== 'string' || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(path) || path.split('/').some(p => p === '..' || p === '.')) throw new Error('invalid converter manifest path');
  return path;
};
/**
 * @param {string} repo
 * @param {string} vendor
 * @param {(command: string, args: string[], options: {stdio: 'inherit'}) => {error?: Error, status: number | null}} run
 * @param {(directory: string, options: {recursive: true, force: true}) => Promise<void>} cleanup
 */
export async function buildStepSource(repo, vendor, run = spawnSync, cleanup = rm) {
  // The packaging host owns this directory; caller-managed recipe directories are untouched.
  const work = await mkdtemp(join(tmpdir(), 'femlab-step-assets-build-'));
  let failed = false;
  try {
    const result = run(process.env.PYTHON ?? 'python3', [join(repo, 'tools/build-step-converter.py'), '--source-kit-only', '--output-dir', vendor, '--work-dir', work], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('complete STEP corresponding-source assembly failed');
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try { await cleanup(work, { recursive: true, force: true }); }
    catch (error) { if (!failed) throw error; }
  }
}
export async function prepareStepAssets({ repo = root, vendor = join(repo, 'vendor/step-converter'), output = join(repo, 'packages/app/public/third-party/step-converter'), requireSourceKit = false, buildSource = () => buildStepSource(repo, vendor) } = {}) {
  const manifest = JSON.parse(await readFile(join(vendor, 'manifest.json'), 'utf8'));
  if (manifest.version !== 'occt-import-js-0.0.23+femlab.1') throw new Error('unsupported STEP converter manifest');
  const source = manifest.artifacts?.sourceKit;
  if (!source || source.path !== 'corresponding-source.tar.gz') throw new Error('complete STEP corresponding-source kit is missing from manifest');
  try { await access(join(vendor, safe(source.path))); } catch { if (requireSourceKit) throw new Error('verified reuse requires a staged STEP source kit; reconstruction is disabled'); await buildSource(); }
  const checked = async (spec, withSize = true) => {
    const path = safe(spec.path); const bytes = await readFile(join(vendor, path));
    if (sha256(bytes) !== spec.sha256 || (withSize && bytes.length !== spec.bytes)) throw new Error(`STEP converter integrity mismatch: ${path}`);
    return path;
  };
  const files = [];
  for (const key of ['javascript', 'wasm', 'sourceKit']) {
    const spec = manifest.artifacts[key];
    if (!spec) throw new Error(`STEP converter artifact is missing: ${key}`);
    files.push(await checked(spec));
  }
  if (manifest.artifacts.javascript.path !== 'dist/occt-import-js.js' || manifest.artifacts.wasm.path !== 'dist/occt-import-js.wasm') throw new Error('STEP converter executable paths are incompatible');
  if (!Array.isArray(manifest.patches) || manifest.patches.length < 2) throw new Error('STEP converter patches are missing');
  for (const patch of manifest.patches) await checked(patch, false);
  // No network links are substituted for local notices or the actual distributed source kit.
  const required = ['wrapper-LGPL-2.1.txt', 'OCCT-LGPL-2.1.txt', 'OCCT_LGPL_EXCEPTION.txt', 'Emscripten-LICENSE.txt', 'libcxx-LICENSE.txt', 'libcxxabi-LICENSE.txt', 'libunwind-LICENSE.txt', 'compiler-rt-LICENSE.txt', 'musl-COPYRIGHT.txt', 'FEM-Lab-MIT.txt'];
  const licenses = await readdir(join(vendor, 'licenses'));
  for (const name of required) if (!licenses.includes(name)) throw new Error(`STEP converter license is missing: ${name}`);
  const notices = ['NOTICE.txt', 'README.md', ...licenses.map(name => safe(`licenses/${name}`))];
  if (!Array.isArray(manifest.notices)) throw new Error('STEP converter notice hashes are missing');
  for (const name of ['NOTICE.txt', ...licenses.map(name => `licenses/${name}`)]) {
    const spec = manifest.notices.find(spec => spec.path === name);
    if (!spec) throw new Error(`STEP converter notice hash is missing: ${name}`);
    await checked(spec);
  }
  if (!Array.isArray(manifest.recipes) || manifest.recipes.length !== 2) throw new Error('STEP converter build recipes are missing');
  for (const name of ['tools/build-step-converter.py', 'tools/build-step-converter.sh']) {
    const spec = manifest.recipes.find(spec => spec.path === name);
    if (!spec || sha256(await readFile(join(repo, name))) !== spec.sha256) throw new Error(`STEP converter build recipe mismatch: ${name}`);
  }
  for (const name of notices) {
    if ((await stat(join(vendor, name))).size < 1) throw new Error(`STEP converter notice is empty: ${name}`);
  }
  await mkdir(output, { recursive: true });
  for (const path of [...files, ...notices, 'manifest.json']) {
    const destination = path.startsWith('dist/') ? path.slice(5) : path;
    await mkdir(dirname(join(output, destination)), { recursive: true });
    await cp(join(vendor, path), join(output, destination));
  }
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await prepareStepAssets({ requireSourceKit: process.env.FEMLAB_REQUIRE_STEP_SOURCE_KIT === '1' });
  console.log(`STEP converter/source kit checked and prepared: ${manifest.version}`);
}
