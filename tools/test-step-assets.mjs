import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareStepAssets } from './prepare-step-assets.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'femlab-step-assets-')); const vendor = join(root, 'vendor'); const output = join(root, 'public');
  await mkdir(join(vendor, 'dist'), { recursive: true }); await mkdir(join(vendor, 'patches')); await mkdir(join(vendor, 'licenses')); await mkdir(join(root, 'tools'));
  const files = { 'dist/occt-import-js.js': 'export default () => {}', 'dist/occt-import-js.wasm': 'wasm fixture', 'corresponding-source.tar.gz': 'complete source fixture', 'patches/1.patch': 'first patch', 'patches/2.patch': 'second patch' };
  for (const [name, value] of Object.entries(files)) await writeFile(join(vendor, name), value);
  const noticeNames = ['NOTICE.txt', 'README.md', 'licenses/wrapper-LGPL-2.1.txt', 'licenses/OCCT-LGPL-2.1.txt', 'licenses/OCCT_LGPL_EXCEPTION.txt', 'licenses/Emscripten-LICENSE.txt', 'licenses/libcxx-LICENSE.txt', 'licenses/libcxxabi-LICENSE.txt', 'licenses/libunwind-LICENSE.txt', 'licenses/compiler-rt-LICENSE.txt', 'licenses/musl-COPYRIGHT.txt', 'licenses/FEM-Lab-MIT.txt'];
  for (const name of noticeNames) await writeFile(join(vendor, name), `notice ${name}`);
  const recipes = ['tools/build-step-converter.py', 'tools/build-step-converter.sh'];
  for (const name of recipes) await writeFile(join(root, name), `recipe ${name}`);
  const spec = path => ({ path, sha256: hash(files[path]), bytes: Buffer.byteLength(files[path]) });
  const manifest = { version: 'occt-import-js-0.0.23+femlab.1', patches: [spec('patches/1.patch'), spec('patches/2.patch')], notices: noticeNames.map(path => ({ path, sha256: hash(`notice ${path}`), bytes: Buffer.byteLength(`notice ${path}`) })), recipes: recipes.map(path => ({ path, sha256: hash(`recipe ${path}`) })), artifacts: { javascript: spec('dist/occt-import-js.js'), wasm: spec('dist/occt-import-js.wasm'), sourceKit: spec('corresponding-source.tar.gz') } };
  const save = () => writeFile(join(vendor, 'manifest.json'), JSON.stringify(manifest)); await save();
  try { await run({ repo: root, vendor, output, manifest, save, files }); } finally { await rm(root, { recursive: true, force: true }); }
}
test('prepares the checked complete executable/source/license pair with preserved manifest', async () => fixture(async f => {
  assert.deepEqual(await prepareStepAssets(f), f.manifest);
  assert.equal(await readFile(join(f.output, 'occt-import-js.js'), 'utf8'), f.files['dist/occt-import-js.js']);
  assert.equal(await readFile(join(f.output, 'corresponding-source.tar.gz'), 'utf8'), f.files['corresponding-source.tar.gz']);
  assert.match(await readFile(join(f.output, 'licenses/OCCT_LGPL_EXCEPTION.txt'), 'utf8'), /notice/);
}));
test('assembles missing preferred source before accepting assets, and propagates missing-source failures', async () => fixture(async f => {
  await rm(join(f.vendor, 'corresponding-source.tar.gz')); let builds = 0;
  await assert.rejects(prepareStepAssets({ ...f, buildSource: () => { throw new Error('source unavailable'); } }), /source unavailable/);
  await prepareStepAssets({ ...f, buildSource: async () => { builds++; await writeFile(join(f.vendor, 'corresponding-source.tar.gz'), f.files['corresponding-source.tar.gz']); } });
  assert.equal(builds, 1);
}));
test('fails closed on stale bytes, source, paths, omitted patches and notices', async () => {
  for (const edit of [
    async f => { f.manifest.version = 'unpatched'; await f.save(); },
    async f => { delete f.manifest.artifacts.sourceKit; await f.save(); },
    async f => { delete f.manifest.artifacts.wasm; await f.save(); },
    async f => { f.manifest.artifacts.wasm.path = '../escape.wasm'; await f.save(); },
    async f => { f.manifest.artifacts.wasm.path = 'dist/./occt-import-js.wasm'; await f.save(); },
    async f => { f.manifest.artifacts.javascript = f.manifest.artifacts.wasm; await f.save(); },
    async f => { f.manifest.patches = []; await f.save(); },
    async f => { f.manifest.notices = []; await f.save(); },
    async f => { f.manifest.recipes = []; await f.save(); },
    async f => { await writeFile(join(f.repo, 'tools/build-step-converter.py'), 'stale'); },
    async f => { f.manifest.artifacts.wasm.bytes++; await f.save(); },
    async f => { await writeFile(join(f.vendor, 'dist/occt-import-js.wasm'), 'stale'); },
    async f => { await writeFile(join(f.vendor, 'corresponding-source.tar.gz'), 'stale'); },
    async f => { await writeFile(join(f.vendor, 'patches/1.patch'), 'stale'); },
    async f => { await rm(join(f.vendor, 'licenses/OCCT_LGPL_EXCEPTION.txt')); },
    async f => { await writeFile(join(f.vendor, 'NOTICE.txt'), ''); },
  ]) await fixture(async f => { await edit(f); await assert.rejects(prepareStepAssets(f)); });
});

test('reuse-only preparation refuses missing source before invoking any reconstruction', async () => fixture(async f => {
  await rm(join(f.vendor, 'corresponding-source.tar.gz')); let builds = 0;
  await assert.rejects(prepareStepAssets({ ...f, requireSourceKit: true, buildSource: () => { builds++; } }), /reconstruction is disabled/);
  assert.equal(builds, 0);
}));
