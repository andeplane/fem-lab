import { createHash } from 'node:crypto';
import { mkdtemp, open, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_CAPTURES = 800;
export interface CountBodySink { save(bytes: Uint8Array): Promise<void> }
export interface CountRuntime { source: string; node: string; sdk: string }
export interface CountBodyReceipt extends CountRuntime {
  index: number;
  classification: 'serialized-count-input';
  bytes: number;
  sha256: string;
}

/** Observe the SDK's final JSON string without reconstructing or changing the request.
 * Other requests pass through untouched. The sink receives no URL, headers or client. */
export function countEvidenceFetch(forward: typeof fetch, sink: CountBodySink): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (url.pathname.endsWith('/responses/input_tokens')) {
      if (url.origin !== 'https://api.openai.com' || url.pathname !== '/v1/responses/input_tokens' || url.search !== '' || method !== 'POST') throw new Error('count evidence endpoint is unsupported');
      if (typeof init?.body !== 'string' || init.body.length > MAX_BODY_BYTES) throw new Error('count evidence requires a bounded serialized JSON string');
      const bytes = new TextEncoder().encode(init.body);
      if (bytes.byteLength > MAX_BODY_BYTES) throw new Error('count evidence body exceeds its byte limit');
      await sink.save(bytes);
    }
    return forward(input, init);
  };
}

async function privateFile(file: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${file}.pending`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, file);
}

/** Host-owned adapter. Each run gets a new 0700 directory outside the checkout.
 * Raw count inputs stay local; numbered receipts contain only bounded public metadata.
 * Capture failure is fatal before fetch, never a reason to forward without evidence. */
export async function localCountEvidence(root: string, parent: string, runtime: CountRuntime): Promise<CountBodySink & { directory: string }> {
  if (!path.isAbsolute(parent)) throw new Error('count evidence parent must be absolute');
  const [repository, destination] = await Promise.all([realpath(root), realpath(parent)]);
  const relative = path.relative(repository, destination);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('count evidence must remain outside the repository');
  // Also refuse a different checkout or a symlink into one, not just this worktree.
  for (let ancestor = destination; ; ancestor = path.dirname(ancestor)) {
    try { await stat(path.join(ancestor, '.git')); throw new Error('count evidence must remain outside repositories'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (path.dirname(ancestor) === ancestor) break;
  }
  if (!/^[a-f0-9]{40}$/.test(runtime.source) || !/^v\d+\.\d+\.\d+$/.test(runtime.node) || !/^openai@\d+\.\d+\.\d+$/.test(runtime.sdk)) throw new Error('count evidence runtime identity is invalid');
  const directory = await mkdtemp(path.join(destination, 'femlab-count-evidence-'));
  let index = 0, total = 0;
  let saving = false;
  return { directory, async save(bytes) {
    if (saving || index >= MAX_CAPTURES || bytes.byteLength > MAX_BODY_BYTES || total + bytes.byteLength > MAX_TOTAL_BYTES) throw new Error('count evidence storage limit reached');
    saving = true;
    const current = index++;
    total += bytes.byteLength;
    const stem = path.join(directory, String(current).padStart(3, '0'));
    const receipt: CountBodyReceipt = { index: current, classification: 'serialized-count-input', bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), source: runtime.source, node: runtime.node, sdk: runtime.sdk };
    try {
      await privateFile(`${stem}.body.json`, bytes);
      await privateFile(`${stem}.receipt.json`, new TextEncoder().encode(`${JSON.stringify(receipt)}\n`));
    } catch {
      // Do not copy filesystem errors: paths can contain private material.
      await Promise.allSettled(['.body.json', '.receipt.json', '.body.json.pending', '.receipt.json.pending'].map(suffix => rm(`${stem}${suffix}`, { force: true })));
      throw new Error('count evidence could not be persisted');
    } finally { saving = false; }
  } };
}
