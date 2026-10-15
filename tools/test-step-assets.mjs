import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStepSource, prepareStepAssets } from './prepare-step-assets.mjs';
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
test('owns a fresh source work directory and removes it without deleting the generated kit or caller data', async () => fixture(async f => {
  await rm(join(f.vendor, 'corresponding-source.tar.gz'));
  const retained = join(f.repo, 'caller-work'); await mkdir(retained); await writeFile(join(retained, 'source.txt'), 'preserve');
  let work;
  await prepareStepAssets({ ...f, buildSource: () => buildStepSource(f.repo, f.vendor, (command, args, options) => {
    assert.equal(command, process.env.PYTHON ?? 'python3');
    assert.deepEqual(args.slice(0, 4), [join(f.repo, 'tools/build-step-converter.py'), '--source-kit-only', '--output-dir', f.vendor]);
    assert.equal(args[4], '--work-dir'); work = args[5]; assert.equal(args.length, 6);
    assert.deepEqual(options, { stdio: 'inherit' }); assert.equal(existsSync(work), true);
    mkdirSync(join(work, 'pristine')); writeFileSync(join(work, 'pristine/source.txt'), 'temporary');
    writeFileSync(join(f.vendor, 'corresponding-source.tar.gz'), f.files['corresponding-source.tar.gz']);
    return { status: 0 };
  }) });
  assert.equal(existsSync(work), false);
  assert.equal(await readFile(join(retained, 'source.txt'), 'utf8'), 'preserve');
  assert.equal(await readFile(join(f.output, 'corresponding-source.tar.gz'), 'utf8'), f.files['corresponding-source.tar.gz']);
}));
test('removes owned source work on spawn errors, thrown process errors and failed exit status', async () => fixture(async f => {
  const spawnError = new Error('spawn unavailable');
  for (const failure of ['spawn', 'throw', 'exit']) {
    let work;
    await assert.rejects(buildStepSource(f.repo, f.vendor, (_command, args) => {
      work = args[5]; writeFileSync(join(work, 'partial-source.txt'), 'partial');
      if (failure === 'throw') throw spawnError;
      return failure === 'spawn' ? { error: spawnError, status: null } : { status: 1 };
    }), error => failure === 'exit' ? error instanceof Error && error.message === 'complete STEP corresponding-source assembly failed' : error === spawnError);
    assert.equal(existsSync(work), false);
    await access(join(f.vendor, 'corresponding-source.tar.gz'));
  }
}));
test('preserves the original process failure if cleanup also fails, and reports cleanup failure after success', async () => fixture(async f => {
  const processError = new Error('original process failure'), cleanupError = new Error('cleanup failed');
  for (const failed of [true, false]) {
    let work;
    try {
      await assert.rejects(buildStepSource(f.repo, f.vendor, (_command, args) => {
        work = args[5]; return failed ? { error: processError, status: null } : { status: 0 };
      }, async (directory, options) => {
        assert.equal(directory, work); assert.deepEqual(options, { recursive: true, force: true });
        throw cleanupError;
      }), error => error === (failed ? processError : cleanupError));
      assert.equal(existsSync(work), true);
    } finally { if (work) await rm(work, { recursive: true, force: true }); }
  }
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
