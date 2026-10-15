import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { preparationPolicy } from '../src/preparation-policy';
import { requireFreeDisk } from '../src/budget';
import { verifyReusedWasm } from '../src/frozen-reuse';

it('requires sealed production source, schema and every browser/Node binding before runtime reuse', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'femlab-reuse-test-'));
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  const head = 'a'.repeat(40), sourceManifest = path.join(root, 'source.json'), runtimeManifest = path.join(root, 'runtime.json');
  const payloads: { path: string; sha256: string }[] = [];
  try {
    for (const directory of ['packages/app/src/generated/wasm', 'tools/wasm-node']) {
      await mkdir(path.join(root, directory), { recursive: true });
      for (const filename of ['femlab_engine_wasm.js', 'femlab_engine_wasm.d.ts', 'femlab_engine_wasm_bg.wasm', 'femlab_engine_wasm_bg.wasm.d.ts']) {
        const name = `${directory}/${filename}`;
        await writeFile(path.join(root, name), name);
        payloads.push({ path: name, sha256: sha(name) });
      }
    }
    await mkdir(path.join(root, 'packages/registry/src/generated'), { recursive: true });
    await writeFile(path.join(root, 'packages/registry/src/generated/engine.schema.json'), 'schema');
    payloads.push({ path: 'engine.schema.json', sha256: sha('schema') });
    await writeFile(path.join(root, 'Cargo.toml'), 'source');
    await writeFile(sourceManifest, JSON.stringify({ head, productionSourcesIncludingShadersCargoAndToolchain: [{ path: 'Cargo.toml', sha256: sha('source') }] }));
    const runtime = { head, producer: 'b'.repeat(40), runId: 1, payloads };
    await writeFile(runtimeManifest, JSON.stringify(runtime));
    const changes = vi.fn(() => '');
    const reuse = { sourceManifest, runtimeManifest };
    expect(await verifyReusedWasm(root, reuse, changes)).toMatchObject({ engineSourceCommit: head, producerCommit: 'b'.repeat(40), bindings: expect.arrayContaining(payloads.slice(0, 8)) });
    expect(changes).toHaveBeenCalledWith(head);
    const fresh = await preparationPolicy(root, undefined, changes);
    expect(fresh.minimumFreeGiB).toBe(30);
    expect(() => requireFreeDisk(29.9 * 2 ** 30, fresh.minimumFreeGiB * 2 ** 30)).toThrow('30 GiB');
    const build = vi.fn();
    await expect(preparationPolicy(root, reuse, changes).then(build)).rejects.toThrow();
    expect(build).not.toHaveBeenCalled();
    const vendor = path.join(root, 'vendor/step-converter');
    await mkdir(vendor, { recursive: true });
    const kit = 'exact source-kit fixture';
    await writeFile(path.join(vendor, 'manifest.json'), JSON.stringify({ artifacts: { sourceKit: { path: 'corresponding-source.tar.gz', sha256: sha(kit), bytes: Buffer.byteLength(kit) } } }));
    await writeFile(path.join(vendor, 'corresponding-source.tar.gz'), kit);
    const verified = await preparationPolicy(root, reuse, changes);
    expect(verified).toEqual({ minimumFreeGiB: 24, preparationRoute: 'verified-wasm-and-staged-step-kit', stepSourceKitSha256: sha(kit) });
    expect(() => requireFreeDisk(23.9 * 2 ** 30, verified.minimumFreeGiB * 2 ** 30)).toThrow('24 GiB');
    expect(() => requireFreeDisk(24 * 2 ** 30, verified.minimumFreeGiB * 2 ** 30)).not.toThrow();
    await writeFile(path.join(vendor, 'corresponding-source.tar.gz'), 'mismatch');
    await expect(preparationPolicy(root, reuse, changes).then(build)).rejects.toThrow('differs');
    expect(build).not.toHaveBeenCalled();
    await writeFile(runtimeManifest, JSON.stringify({ ...runtime, producer: '' }));
    await expect(preparationPolicy(root, reuse, changes).then(build)).rejects.toThrow('producer');
    expect(build).not.toHaveBeenCalled();
    await writeFile(runtimeManifest, JSON.stringify(runtime));

    await expect(verifyReusedWasm(root, reuse, () => 'crates/engine/src/lib.rs')).rejects.toThrow('source tree');
    await writeFile(path.join(root, 'Cargo.toml'), 'changed source');
    await expect(verifyReusedWasm(root, reuse, changes)).rejects.toThrow('source mismatch');
    await writeFile(path.join(root, 'Cargo.toml'), 'source');
    await writeFile(path.join(root, payloads[0]!.path), 'wrong binding');
    await expect(verifyReusedWasm(root, reuse, changes)).rejects.toThrow('binding mismatch');
    await writeFile(path.join(root, payloads[0]!.path), payloads[0]!.path);
    await writeFile(runtimeManifest, JSON.stringify({ ...runtime, payloads: payloads.slice(1) }));
    await expect(verifyReusedWasm(root, reuse, changes)).rejects.toThrow('binding mismatch');
    await writeFile(runtimeManifest, JSON.stringify(runtime));
    await writeFile(path.join(root, 'packages/registry/src/generated/engine.schema.json'), 'wrong schema');
    await expect(verifyReusedWasm(root, reuse, changes)).rejects.toThrow('schema mismatch');
    await writeFile(runtimeManifest, JSON.stringify({ ...runtime, head: 'b'.repeat(40) }));
    await expect(verifyReusedWasm(root, reuse, changes)).rejects.toThrow('source identities');
    expect(await readFile(path.join(root, 'Cargo.toml'), 'utf8')).toBe('source');
  } finally { await rm(root, { recursive: true, force: true }); }
});
