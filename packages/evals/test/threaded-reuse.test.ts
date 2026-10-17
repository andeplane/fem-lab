import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { preparationPolicy } from '../src/preparation-policy';
import { verifyReusedWasm, type RuntimeManifest, type NativeComponentManifest, type SourceManifest } from '../src/frozen-reuse';

const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const host = { platform: 'darwin' as const, arch: 'arm64' };
const prefix = 'packages/app/src/generated/wasm-threads';
const snippet = `${prefix}/snippets/wasm-bindgen-rayon-38edf6e439f6d70d/src/workerHelpers.js`;
const bindings = ['femlab_engine_wasm.js', 'femlab_engine_wasm.d.ts', 'femlab_engine_wasm_bg.wasm', 'femlab_engine_wasm_bg.wasm.d.ts'];
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'eval-threaded-reuse-'));
  const head = 'a'.repeat(40), producer = 'b'.repeat(40), sourceManifest = path.join(root, 'source.json'), runtimeManifest = path.join(root, 'runtime.json');
  const groups = { portableBrowser: bindings.map(file => `packages/app/src/generated/wasm/${file}`), portableNode: bindings.map(file => `tools/wasm-node/${file}`), threadedBrowser: [...bindings.map(file => `${prefix}/${file}`), `${prefix}/package.json`, `${prefix}/NOTICE.txt`, `${prefix}/atomic-wait-LICENSE.txt`, `${prefix}/wasm-bindgen-rayon-LICENSE.txt`, snippet] };
  const put = async (file: string, bytes: string) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), bytes); return { path: file, bytes: Buffer.byteLength(bytes), sha256: sha(bytes) }; };
  const contents: Record<string, string> = {
    [`${prefix}/femlab_engine_wasm.js`]: `import { startWorkers } from './snippets/wasm-bindgen-rayon-38edf6e439f6d70d/src/workerHelpers.js'; new URL('femlab_engine_wasm_bg.wasm', import.meta.url);`,
    [snippet]: `const pkg = await import('../../..'); new Worker(new URL('./workerHelpers.js', import.meta.url), {type:'module'}); // import('ignored-comment.js')`,
    [`${prefix}/package.json`]: JSON.stringify({ type: 'module', main: './femlab_engine_wasm.js' }),
  };
  const payloads = [];
  for (const name of [...Object.values(groups).flat(), 'engine.schema.json', 'tools/project-io/linux-x64/femlab-project-io', 'target/release/femlab']) {
    const destination = name === 'engine.schema.json' ? 'packages/registry/src/generated/engine.schema.json' : name;
    const item = await put(destination, contents[name] ?? name); payloads.push({ ...item, path: name });
  }
  await put('Cargo.toml', 'sealed core');
  const source: SourceManifest = { head, productionSourcesIncludingShadersCargoAndToolchain: [{ path: 'Cargo.toml', sha256: sha('sealed core') }], sourceClassification: { version: 1, componentCompilationInputs: ['Cargo.toml'], producerAuditInputs: [], packageLockSelections: [] } };
  await writeFile(sourceManifest, JSON.stringify(source));
  const runtime: RuntimeManifest = { head, producer, runId: 1, jobId: 2, artifactId: 3, artifactName: 'wasm', archiveSha256: sha('actual fixture archive'), sourceManifest, sourceManifestSha256: sha(await readFile(sourceManifest)), allBindingGroups: groups, expectedBindingCount: 17, payloads };
  const nativeManifests = [];
  for (const [artifactName, file] of [['project-io-aarch64-apple-darwin', 'tools/project-io/darwin-arm64/femlab-project-io'], ['release-files-aarch64-apple-darwin', 'native/darwin-arm64/femlab']]) {
    const item = await put(file!, file!);
    const native: NativeComponentManifest = { head, producer, runId: 2, jobId: 3, artifactId: artifactName!.startsWith('project') ? 4 : 5, artifactName: artifactName!, archiveSha256: sha(artifactName!), platform: { os: 'darwin', arch: 'arm64', target: 'aarch64-apple-darwin' }, sourceManifest, payloads: [{ ...item, archiveEntry: `fixture/${path.basename(file!)}`, stagedPath: path.join(root, file!) }] };
    const manifest = path.join(root, `${artifactName}.json`); await writeFile(manifest, JSON.stringify(native)); nativeManifests.push(manifest);
  }
  const save = async () => { runtime.sourceManifestSha256 = sha(await readFile(sourceManifest)); await writeFile(runtimeManifest, JSON.stringify(runtime)); }; await save();
  return { root, runtime, source, sourceManifest, runtimeManifest, nativeManifests, put, save, reuse: { sourceManifest, runtimeManifest, nativeManifests } };
}

it('rejects a missing nested runtime worker before preparation instead of silently checking only eight portable files', async () => {
  const f = await fixture();
  try { await rm(path.join(f.root, snippet)); await expect(verifyReusedWasm(f.root, f.reuse, () => '', host)).rejects.toThrow(); }
  finally { await rm(f.root, { recursive: true, force: true }); }
});

it('checks all17 bindings, raw schema, Linux support and distinct current-host helper/CLI components without executing them', async () => {
  const f = await fixture();
  try {
    const verified = await verifyReusedWasm(f.root, f.reuse, () => '', host);
    expect(verified.bindings).toHaveLength(17); expect(verified.nativeComponents).toHaveLength(2);
    expect(verified.sourceManifestSha256).toBe(sha(await readFile(f.sourceManifest)));
    expect(verified.reuseIdentitySha256).toMatch(/^[a-f0-9]{64}$/);
    await f.put(snippet, 'tampered'); await expect(verifyReusedWasm(f.root, f.reuse, () => '', host)).rejects.toThrow('binding mismatch');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it('follows actual relocated snippet imports and package-main/self-worker cycles; refuses mismatched closure or missing notices', async () => {
  const f = await fixture();
  try {
    const relocated = snippet.replace('38edf6e439f6d70d', '0123456789abcdef');
    const helper = await readFile(path.join(f.root, snippet), 'utf8'); await rm(path.join(f.root, snippet));
    const newItem = await f.put(relocated, helper);
    f.runtime.allBindingGroups!.threadedBrowser = f.runtime.allBindingGroups!.threadedBrowser.map(file => file === snippet ? relocated : file);
    f.runtime.payloads = f.runtime.payloads.map(item => item.path === snippet ? newItem : item);
    const gluePath = `${prefix}/femlab_engine_wasm.js`, glue = (await readFile(path.join(f.root, gluePath), 'utf8')).replace('38edf6e439f6d70d', '0123456789abcdef');
    const updated = await f.put(gluePath, glue); f.runtime.payloads = f.runtime.payloads.map(item => item.path === gluePath ? updated : item); await f.save();
    expect((await verifyReusedWasm(f.root, f.reuse, () => '', host)).bindings).toHaveLength(17);
    const broken = await f.put(gluePath, glue.replace('0123456789abcdef', 'ffffffffffffffff')); f.runtime.payloads = f.runtime.payloads.map(item => item.path === gluePath ? broken : item); await f.save();
    await expect(verifyReusedWasm(f.root, f.reuse, () => '', host)).rejects.toThrow('closure');
    await f.put(gluePath, glue); f.runtime.payloads = f.runtime.payloads.map(item => item.path === gluePath ? updated : item); await f.save();
    await rm(path.join(f.root, `${prefix}/NOTICE.txt`)); await expect(verifyReusedWasm(f.root, f.reuse, () => '', host)).rejects.toThrow();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it('refuses missing or wrong-host native proof, source mismatch, unsafe/duplicate payloads and a partial17 contract', async () => {
  const f = await fixture();
  try {
    await expect(verifyReusedWasm(f.root, { ...f.reuse, nativeManifests: [] }, () => '', host)).rejects.toThrow('native');
    await expect(verifyReusedWasm(f.root, f.reuse, () => '', { platform: 'linux', arch: 'x64' })).rejects.toThrow('current host');
    const native = JSON.parse(await readFile(f.nativeManifests[0]!, 'utf8')) as NativeComponentManifest; native.head = 'c'.repeat(40); await writeFile(f.nativeManifests[0]!, JSON.stringify(native));
    await expect(verifyReusedWasm(f.root, f.reuse, () => '', host)).rejects.toThrow('native source');
    native.head = f.runtime.head; await writeFile(f.nativeManifests[0]!, JSON.stringify(native));
    f.runtime.payloads.push(f.runtime.payloads[0]!); await f.save(); await expect(verifyReusedWasm(f.root, f.reuse, () => '', host)).rejects.toThrow('duplicate'); f.runtime.payloads.pop();
    f.runtime.payloads.push({ path: '../escape', sha256: sha('escape'), bytes: 6 }); await f.save(); await expect(verifyReusedWasm(f.root, f.reuse, () => '', host)).rejects.toThrow('path'); f.runtime.payloads.pop();
    f.runtime.allBindingGroups!.threadedBrowser.pop(); await f.save(); await expect(verifyReusedWasm(f.root, f.reuse, () => '', host)).rejects.toThrow('17');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});


it('retains all producer source provenance while allowing explicit host drift and strictly checking compiler lock selections', async () => {
  const f = await fixture();
  try {
    const selection = { path: 'package-lock.json', packageKey: 'node_modules/binaryen', version: '132.0.0', resolved: 'https://registry.npmjs.org/binaryen/fixture.tgz', integrity: 'sha512-fixture' };
    const oldLock = JSON.stringify({ packages: { [selection.packageKey]: selection } });
    await f.put('package-lock.json', oldLock); await f.put('host.ts', 'old consumer');
    const source = f.source;
    source.productionSourcesIncludingShadersCargoAndToolchain.push({ path: 'package-lock.json', sha256: sha(oldLock) }, { path: 'host.ts', sha256: sha('old consumer') });
    source.sourceClassification!.producerAuditInputs = ['package-lock.json', 'host.ts']; source.sourceClassification!.packageLockSelections = [selection];
    await writeFile(f.sourceManifest, JSON.stringify(source)); await f.save();
    const lock: { packages: Record<string, { version: string; resolved?: string; integrity?: string }> } = { packages: { [selection.packageKey]: { ...selection }, 'packages/evals': { version: '0.1.0' } } };
    await f.put('package-lock.json', JSON.stringify(lock)); await f.put('host.ts', 'fresh frozen consumer');
    const verified = await verifyReusedWasm(f.root, f.reuse, () => 'host.ts', host);
    expect(verified.consumerSourceDrift).toMatchObject([{ path: 'package-lock.json' }, { path: 'host.ts', producerSha256: sha('old consumer'), currentSha256: sha('fresh frozen consumer') }]);
    expect(verified.strictComponentSourceCount).toBe(1); expect(verified.producerSourceCount).toBe(3);
    lock.packages[selection.packageKey]!.integrity = 'changed'; await f.put('package-lock.json', JSON.stringify(lock));
    await expect(verifyReusedWasm(f.root, f.reuse, () => '', host)).rejects.toThrow('compiler dependency');
    lock.packages[selection.packageKey]!.integrity = selection.integrity; await f.put('package-lock.json', JSON.stringify(lock));
    await f.put('Cargo.toml', 'changed compiled core'); await expect(verifyReusedWasm(f.root, f.reuse, () => '', host)).rejects.toThrow('source mismatch'); await f.put('Cargo.toml', 'sealed core');
    await expect(verifyReusedWasm(f.root, f.reuse, () => 'crates/new-compiled-file.rs', host)).rejects.toThrow('source tree');
    source.sourceClassification!.componentCompilationInputs.push('host.ts'); await writeFile(f.sourceManifest, JSON.stringify(source)); await f.save();
    await expect(verifyReusedWasm(f.root, f.reuse, () => '', host)).rejects.toThrow('partition');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});


it('does not downgrade a classified threaded producer to legacy8 or prepare without current-host native evidence', async () => {
  const f = await fixture();
  try {
    const build = vi.fn();
    await expect(preparationPolicy(f.root, { ...f.reuse, nativeManifests: [] }, () => '').then(build)).rejects.toThrow('native');
    expect(build).not.toHaveBeenCalled();
    const native = JSON.parse(await readFile(f.nativeManifests[1]!, 'utf8')) as NativeComponentManifest;
    await f.put(native.payloads[0]!.path, 'tampered native CLI');
    await expect(verifyReusedWasm(f.root, f.reuse, () => '', host)).rejects.toThrow('native component');
    f.runtime.payloads = f.runtime.payloads.filter(file => !file.path.startsWith(`${prefix}/`));
    delete f.runtime.allBindingGroups; delete f.runtime.expectedBindingCount; await f.save();
    await expect(verifyReusedWasm(f.root, f.reuse, () => '', host)).rejects.toThrow('17-file');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
