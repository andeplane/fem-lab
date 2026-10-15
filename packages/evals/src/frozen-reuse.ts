import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface ReusedWasm {
  sourceManifest: string;
  runtimeManifest: string;
}
interface HashedFile { path: string; sha256: string }
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Verify the complete sealed engine source set, tracked core diff, schema and all eight
 * bindings before reusing an independently built engine. No native build is implied. */
export async function verifyReusedWasm(root: string, reuse: ReusedWasm, changedCore: (reference: string) => string): Promise<Record<string, unknown>> {
  const sourceBytes = await readFile(reuse.sourceManifest);
  const runtimeBytes = await readFile(reuse.runtimeManifest);
  const source = JSON.parse(sourceBytes.toString()) as { head: string; productionSourcesIncludingShadersCargoAndToolchain: HashedFile[] };
  const runtime = JSON.parse(runtimeBytes.toString()) as { head: string; producer: string; runId: number; payloads: HashedFile[] };
  if (!/^[0-9a-f]{40}$/.test(source.head) || runtime.head !== source.head) throw new Error('reused wasm source identities differ');
  if (changedCore(source.head).trim() !== '') throw new Error('reused wasm does not match the current engine source tree');
  if (source.productionSourcesIncludingShadersCargoAndToolchain.length === 0) throw new Error('reused wasm source manifest is empty');
  for (const file of source.productionSourcesIncludingShadersCargoAndToolchain) {
    if (sha(await readFile(path.join(root, file.path))) !== file.sha256) throw new Error(`reused wasm source mismatch: ${file.path}`);
  }
  const checked: HashedFile[] = [];
  for (const directory of ['packages/app/src/generated/wasm', 'tools/wasm-node']) {
    for (const filename of ['femlab_engine_wasm.js', 'femlab_engine_wasm.d.ts', 'femlab_engine_wasm_bg.wasm', 'femlab_engine_wasm_bg.wasm.d.ts']) {
      const name = `${directory}/${filename}`;
      const entries = runtime.payloads.filter(file => file.path === name);
      if (entries.length !== 1 || sha(await readFile(path.join(root, name))) !== entries[0]!.sha256) throw new Error(`reused wasm binding mismatch: ${name}`);
      checked.push(entries[0]!);
    }
  }
  const schema = runtime.payloads.find(file => file.path === 'engine.schema.json');
  if (!schema || sha(await readFile(path.join(root, 'packages/registry/src/generated/engine.schema.json'))) !== schema.sha256) throw new Error('reused wasm schema mismatch');
  return { engineSourceCommit: source.head, producerCommit: runtime.producer, producerRun: runtime.runId, sourceManifestSha256: sha(sourceBytes), runtimeManifestSha256: sha(runtimeBytes), schemaSha256: schema.sha256, bindings: checked };
}
