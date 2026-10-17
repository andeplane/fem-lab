import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyReusedWasm, type ReusedWasm } from './frozen-reuse';

/** Operational headroom, not a quota on arbitrary model-directed files or host swap.
 * A complete verified engine and staged source kit avoid all compilation/extraction. */
export async function preparationPolicy(root: string, reuse: ReusedWasm | undefined, changedCore: (reference: string) => string): Promise<{ minimumFreeGiB: number; preparationRoute: string; stepSourceKitSha256: string; reuseIdentitySha256?: string }> {
  if (!reuse) return { minimumFreeGiB: 30, preparationRoute: 'fresh-engine-or-unverified', stepSourceKitSha256: 'not-reused' };
  const verified = await verifyReusedWasm(root, reuse, changedCore);
  const vendor = path.join(root, 'vendor/step-converter');
  const manifest = JSON.parse(await readFile(path.join(vendor, 'manifest.json'), 'utf8')) as { artifacts?: { sourceKit?: { path?: string; sha256?: string; bytes?: number } } };
  const kit = manifest.artifacts?.sourceKit;
  if (kit?.path !== 'corresponding-source.tar.gz' || !/^[0-9a-f]{64}$/.test(kit.sha256 ?? '') || !Number.isSafeInteger(kit.bytes) || kit.bytes! <= 0) throw new Error('verified reuse requires a complete STEP source-kit manifest');
  const bytes = await readFile(path.join(vendor, kit.path));
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== kit.bytes || hash !== kit.sha256) throw new Error('verified reuse STEP source kit differs from its sealed manifest');
  return { minimumFreeGiB: 4, preparationRoute: 'verified-wasm-and-staged-step-kit', stepSourceKitSha256: hash, ...(typeof verified.reuseIdentitySha256 === 'string' ? { reuseIdentitySha256: verified.reuseIdentitySha256 } : {}) };
}
