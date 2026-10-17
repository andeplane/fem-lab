import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as ts from 'typescript';

export interface ReusedWasm {
  sourceManifest: string;
  runtimeManifest: string;
  nativeManifests?: string[];
}
export interface HashedFile { path: string; sha256: string; bytes?: number }
export interface RuntimeManifest {
  head: string; producer: string; runId: number; payloads: HashedFile[];
  jobId?: number; artifactId?: number; artifactName?: string; archiveSha256?: string;
  sourceManifest?: string; sourceManifestSha256?: string; producerParents?: string[];
  expectedBindingCount?: 17;
  allBindingGroups?: { portableBrowser: string[]; portableNode: string[]; threadedBrowser: string[] };
}
export interface NativeComponentManifest {
  head: string; producer: string; runId: number; jobId: number; artifactId: number;
  artifactName: string; archiveSha256: string;
  platform: { os: NodeJS.Platform; arch: string; target: string };
  sourceManifest: string;
  payloads: (HashedFile & { bytes: number; archiveEntry: string; stagedPath: string })[];
}
export interface SourceClassification {
  version: 1;
  componentCompilationInputs: string[];
  producerAuditInputs: string[];
  packageLockSelections: { path: string; packageKey: string; version: string; resolved: string; integrity: string }[];
}
export interface SourceManifest {
  head: string;
  productionSourcesIncludingShadersCargoAndToolchain: HashedFile[];
  sourceClassification?: SourceClassification;
}
interface RuntimeHost { platform: NodeJS.Platform; arch: string }
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const filenames = ['femlab_engine_wasm.js', 'femlab_engine_wasm.d.ts', 'femlab_engine_wasm_bg.wasm', 'femlab_engine_wasm_bg.wasm.d.ts'];
const browser = filenames.map(file => `packages/app/src/generated/wasm/${file}`);
const node = filenames.map(file => `tools/wasm-node/${file}`);
const threaded = 'packages/app/src/generated/wasm-threads';
const threadedStatic = [...filenames, 'package.json', 'NOTICE.txt', 'atomic-wait-LICENSE.txt', 'wasm-bindgen-rayon-LICENSE.txt'].map(file => `${threaded}/${file}`);
function safePath(file: string): void {
  if (typeof file !== 'string' || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(file) || file.split('/').some(part => part === '.' || part === '..')) throw new Error('invalid reused runtime path');
}
function samePaths(actual: string[], expected: string[]): boolean { return Array.isArray(actual) && JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort()); }
function inventory(payloads: HashedFile[]): Map<string, HashedFile> {
  if (!Array.isArray(payloads)) throw new Error('reused runtime inventory is missing');
  const result = new Map<string, HashedFile>();
  for (const item of payloads) {
    safePath(item.path);
    if (result.has(item.path)) throw new Error('duplicate reused runtime payload');
    if (!/^[0-9a-f]{64}$/.test(item.sha256)) throw new Error('invalid reused runtime hash');
    result.set(item.path, item);
  }
  return result;
}
async function checked(root: string, file: HashedFile | undefined, name: string, kind: string, requireSize = false): Promise<Buffer> {
  if (!file || (requireSize && (!Number.isSafeInteger(file.bytes) || file.bytes! <= 0))) throw new Error(`reused wasm ${kind} mismatch: ${name}`);
  const bytes = await readFile(path.join(root, name));
  if (sha(bytes) !== file.sha256 || (file.bytes !== undefined && file.bytes !== bytes.length)) throw new Error(`reused wasm ${kind} mismatch: ${name}`);
  return bytes;
}

/** Parse actual JS imports/URLs, including the real package-main and self-worker cycle. */
function checkThreadClosure(files: Map<string, Buffer>): void {
  const resolve = (from: string, specifier: string, directories = new Set<string>()): string => {
    if (specifier.includes('\\') || path.posix.isAbsolute(specifier) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier)) throw new Error('unsealed threaded runtime closure');
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
    if (target !== threaded && !target.startsWith(`${threaded}/`)) throw new Error('threaded runtime closure escapes its package');
    if (files.has(target)) return target;
    const packageFile = `${target}/package.json`, bytes = files.get(packageFile);
    if (!bytes || directories.has(target)) throw new Error(`unsealed threaded runtime closure: ${target}`);
    directories.add(target);
    const pkg = JSON.parse(bytes.toString()) as { type?: string; main?: string };
    if (pkg.type !== 'module' || typeof pkg.main !== 'string') throw new Error('threaded runtime closure package main is missing');
    return resolve(packageFile, pkg.main, directories);
  };
  const pending = [`${threaded}/femlab_engine_wasm.js`], visited = new Set<string>();
  while (pending.length) {
    const file = pending.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = ts.createSourceFile(file, files.get(file)!.toString(), ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
    const dependency = (literal: ts.Expression | undefined) => {
      if (!literal || !ts.isStringLiteralLike(literal)) throw new Error('nonliteral threaded runtime closure');
      const target = resolve(file, literal.text);
      if (target.endsWith('.js')) pending.push(target);
    };
    const walk = (current: ts.Node): void => {
      if (ts.isImportDeclaration(current)) dependency(current.moduleSpecifier);
      if (ts.isExportDeclaration(current) && current.moduleSpecifier) dependency(current.moduleSpecifier);
      if (ts.isCallExpression(current) && current.expression.kind === ts.SyntaxKind.ImportKeyword) dependency(current.arguments[0]);
      if (ts.isNewExpression(current) && ts.isIdentifier(current.expression) && current.expression.text === 'URL') {
        const base = current.arguments?.[1];
        if (base && ts.isPropertyAccessExpression(base) && base.name.text === 'url' && ts.isMetaProperty(base.expression) && base.expression.keywordToken === ts.SyntaxKind.ImportKeyword) dependency(current.arguments?.[0]);
      }
      ts.forEachChild(current, walk);
    };
    walk(source);
  }
  for (const file of files.keys()) if (file.endsWith('.js') && !visited.has(file)) throw new Error(`unreachable threaded runtime closure: ${file}`);
}

async function verifyNative(root: string, manifests: string[] | undefined, sourceHead: string, sourceHash: string, host: RuntimeHost) {
  if (!Array.isArray(manifests) || manifests.length === 0) throw new Error('17-file reuse requires native component receipts');
  const result = [];
  const staged = new Set<string>();
  for (const manifest of manifests) {
    const bytes = await readFile(manifest), component = JSON.parse(bytes.toString()) as NativeComponentManifest;
    if (component.head !== sourceHead || typeof component.sourceManifest !== 'string' || sha(await readFile(component.sourceManifest)) !== sourceHash) throw new Error('reused native source identity differs');
    if (!/^[0-9a-f]{40}$/.test(component.producer) || ![component.runId, component.jobId, component.artifactId].every(n => Number.isSafeInteger(n) && n > 0) || !/^[0-9a-f]{64}$/.test(component.archiveSha256) || typeof component.artifactName !== 'string' || component.artifactName.length === 0 || !component.platform || typeof component.platform.target !== 'string') throw new Error('reused native producer receipt is missing');
    const payloads = inventory(component.payloads);
    for (const file of component.payloads) {
      if (typeof file.archiveEntry !== 'string' || file.archiveEntry.length === 0 || typeof file.stagedPath !== 'string' || file.stagedPath.length === 0 || staged.has(file.path)) throw new Error('invalid or duplicate native payload provenance');
      staged.add(file.path);
      await checked(root, payloads.get(file.path), file.path, 'native component', true);
    }
    result.push({ ...component, manifestSha256: sha(bytes) });
  }
  const platform = `${host.platform}-${host.arch}`, executable = host.platform === 'win32' ? '.exe' : '';
  const required = [`tools/project-io/${platform}/femlab-project-io${executable}`, `native/${platform}/femlab${executable}`];
  const matching = result.filter(component => component.platform.os === host.platform && component.platform.arch === host.arch);
  for (const file of required) if (!matching.some(component => component.payloads.some(payload => payload.path === file))) throw new Error(`reused native proof is missing for the current host: ${file}`);
  return result;
}

async function verifySource(root: string, source: SourceManifest, threadedRuntime: boolean, changed: string) {
  const records = inventory(source.productionSourcesIncludingShadersCargoAndToolchain);
  if (records.size === 0) throw new Error('reused wasm source manifest is empty');
  const classification = source.sourceClassification;
  let strict = [...records.keys()], audit: string[] = [];
  if (threadedRuntime) {
    if (!classification || classification.version !== 1 || !Array.isArray(classification.componentCompilationInputs) || classification.componentCompilationInputs.length === 0 || !Array.isArray(classification.producerAuditInputs) || !Array.isArray(classification.packageLockSelections)) throw new Error('threaded source classification is missing');
    strict = classification.componentCompilationInputs; audit = classification.producerAuditInputs;
    const partition = [...strict, ...audit];
    if (new Set(partition).size !== partition.length || !samePaths(partition, [...records.keys()])) throw new Error('source classification must partition the complete producer inventory');
  }
  const audited = new Set(audit);
  if (changed.trim().split('\n').filter(Boolean).some(file => !audited.has(file))) throw new Error('reused wasm does not match the current engine source tree');
  for (const file of strict) if (sha(await readFile(path.join(root, file))) !== records.get(file)!.sha256) throw new Error(`reused wasm source mismatch: ${file}`);
  const auditSnapshot = [];
  for (const file of audit) {
    let currentSha256: string | null;
    try { currentSha256 = sha(await readFile(path.join(root, file))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; currentSha256 = null; }
    auditSnapshot.push({ path: file, producerSha256: records.get(file)!.sha256, currentSha256 });
  }
  if (threadedRuntime) for (const selection of classification!.packageLockSelections) {
    safePath(selection.path);
    if (!audited.has(selection.path) || typeof selection.packageKey !== 'string' || !selection.packageKey.startsWith('node_modules/')) throw new Error('invalid strict package-lock selection');
    const lock = JSON.parse((await readFile(path.join(root, selection.path))).toString()) as { packages?: Record<string, { version?: string; resolved?: string; integrity?: string }> };
    const actual = lock.packages?.[selection.packageKey];
    if (![selection.version, selection.resolved, selection.integrity].every(value => typeof value === 'string' && value.length > 0) || !actual || actual.version !== selection.version || actual.resolved !== selection.resolved || actual.integrity !== selection.integrity) throw new Error(`reused wasm compiler dependency differs: ${selection.packageKey}`);
  }
  return { auditSnapshot, consumerSourceDrift: auditSnapshot.filter(file => file.currentSha256 !== file.producerSha256), producerSourceCount: records.size, strictComponentSourceCount: strict.length };
}

/** Legacy receipts retain their original eight-binding/full-source checks. A declared
 * threaded receipt seals every binding, real nested import and native component first. */
export async function verifyReusedWasm(root: string, reuse: ReusedWasm, changedCore: (reference: string) => string, host: RuntimeHost = { platform: process.platform, arch: process.arch }): Promise<Record<string, unknown>> {
  const sourceBytes = await readFile(reuse.sourceManifest), runtimeBytes = await readFile(reuse.runtimeManifest);
  const source = JSON.parse(sourceBytes.toString()) as SourceManifest;
  const runtime = JSON.parse(runtimeBytes.toString()) as RuntimeManifest;
  if (!/^[0-9a-f]{40}$/.test(source.head) || runtime.head !== source.head) throw new Error('reused wasm source identities differ');
  if (!/^[0-9a-f]{40}$/.test(runtime.producer) || !Number.isSafeInteger(runtime.runId) || runtime.runId <= 0) throw new Error('reused wasm producer receipt is missing');
  const payloads = inventory(runtime.payloads);
  const declaredThreaded = source.sourceClassification !== undefined || runtime.allBindingGroups !== undefined || runtime.expectedBindingCount !== undefined || runtime.payloads.some(file => file.path.startsWith(`${threaded}/`));
  const sourceProof = await verifySource(root, source, declaredThreaded, changedCore(source.head));
  let paths = [...browser, ...node];
  if (declaredThreaded) {
    if (![runtime.jobId, runtime.artifactId].every(n => Number.isSafeInteger(n) && n! > 0) || typeof runtime.artifactName !== 'string' || runtime.artifactName.length === 0 || !/^[0-9a-f]{64}$/.test(runtime.archiveSha256 ?? '') || runtime.sourceManifestSha256 !== sha(sourceBytes) || typeof runtime.sourceManifest !== 'string' || sha(await readFile(runtime.sourceManifest)) !== sha(sourceBytes)) throw new Error('threaded runtime producer/source receipt is incomplete');
    const groups = runtime.allBindingGroups;
    if (runtime.expectedBindingCount !== 17 || !groups || !samePaths(groups.portableBrowser, browser) || !samePaths(groups.portableNode, node) || !Array.isArray(groups.threadedBrowser) || groups.threadedBrowser.length !== 9) throw new Error('reused wasm 17-file binding contract is incomplete');
    const snippets = groups.threadedBrowser.filter(file => !threadedStatic.includes(file));
    if (snippets.length !== 1 || !/^packages\/app\/src\/generated\/wasm-threads\/snippets\/wasm-bindgen-rayon-[0-9a-f]{16}\/src\/workerHelpers\.js$/.test(snippets[0]!) || !samePaths(groups.threadedBrowser, [...threadedStatic, snippets[0]!])) throw new Error('reused wasm 17-file threaded closure differs');
    paths = [...groups.portableBrowser, ...groups.portableNode, ...groups.threadedBrowser];
    if (!samePaths([...payloads.keys()], [...paths, 'engine.schema.json', 'tools/project-io/linux-x64/femlab-project-io', 'target/release/femlab'])) throw new Error('threaded producer inventory differs from its complete payload contract');
  }
  const checkedFiles = new Map<string, Buffer>(), bindings: HashedFile[] = [];
  for (const name of paths) { checkedFiles.set(name, await checked(root, payloads.get(name), name, 'binding', declaredThreaded)); bindings.push(payloads.get(name)!); }
  const schema = payloads.get('engine.schema.json');
  await checked(root, schema, 'packages/registry/src/generated/engine.schema.json', 'schema', declaredThreaded);
  const nativeComponents = declaredThreaded ? await verifyNative(root, reuse.nativeManifests, source.head, sha(sourceBytes), host) : [];
  if (declaredThreaded) {
    checkThreadClosure(new Map([...checkedFiles].filter(([file]) => file.startsWith(`${threaded}/`))));
    for (const name of ['tools/project-io/linux-x64/femlab-project-io', 'target/release/femlab']) await checked(root, payloads.get(name), name, 'producer support', true);
  }
  return { engineSourceCommit: source.head, producerCommit: runtime.producer, producerRun: runtime.runId, ...(declaredThreaded ? { producerArtifact: { jobId: runtime.jobId, artifactId: runtime.artifactId, artifactName: runtime.artifactName, archiveSha256: runtime.archiveSha256, producerParents: runtime.producerParents ?? [] } } : {}), sourceManifestSha256: sha(sourceBytes), runtimeManifestSha256: sha(runtimeBytes), schemaSha256: schema!.sha256, bindings, ...(declaredThreaded ? { nativeComponents, producerSupport: ['tools/project-io/linux-x64/femlab-project-io', 'target/release/femlab'].map(file => payloads.get(file)!), ...sourceProof, reuseIdentitySha256: sha(JSON.stringify([sha(sourceBytes), sha(runtimeBytes), nativeComponents.map(component => component.manifestSha256), sourceProof.auditSnapshot])) } : {}) };
}
