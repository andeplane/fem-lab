// A share link: the Journal in the URL fragment, so a Model moves between browsers without a
// file and without a server (PLAN.md 5.8, J11.4). It carries a *Command list*, never a Model
// snapshot — replay rebuilds the Model, and a Journal is an order of magnitude smaller.
//
// Nothing leaves the page: a fragment is never sent to a server. Two lines mount it, in files
// this module does not own:
//
//   main.tsx, next to the existing `?example=` line at the end of `boot()`:
//     await openShared({ dispatch }, location.hash);
//
//   the top bar's Share button, which is `file.shareLink`.
//
// The background save that used to live in the other half of this file is now `projects.ts`:
// there is one record per project rather than one autosave slot (issue #41).
import { FemError } from '@femlab/registry';

/** A Command in the app's wire shape — the same thing the Journal holds. */
export type ShareCommand = { cmd: string } & Record<string, unknown>;

/** Anything that dispatches: the real `Registry`, or a fake in a test. */
export interface Dispatcher {
  dispatch(cmd: ShareCommand): Promise<unknown>;
}

// ---------------------------------------------------------------------------- share link

/** Fragments longer than this are refused: browsers and chat clients both start truncating. */
export const MAX_FRAGMENT = 32 * 1024;

const RAW = 0x00;
const DEFLATE = 0x01;

function toBase64Url(bytes: Uint8Array): string {
  // btoa wants a binary string; chunk it, because String.fromCharCode(...) blows the stack
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

// `CompressionStream`'s DOM typing declares its input as BufferSource, which does not line up
// with a Uint8Array stream; one cast at construction beats one at every call site.
type ByteTransform = ReadableWritablePair<Uint8Array, Uint8Array>;
const deflate = (): ByteTransform => new CompressionStream('deflate-raw') as unknown as ByteTransform;
const inflate = (): ByteTransform => new DecompressionStream('deflate-raw') as unknown as ByteTransform;

async function pipe(bytes: Uint8Array, transform: ByteTransform): Promise<Uint8Array> {
  const source = new Blob([bytes as BlobPart]).stream() as unknown as ReadableStream<Uint8Array>;
  const chunks: Uint8Array[] = [];
  const reader = source.pipeThrough(transform).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(new ArrayBuffer(chunks.reduce((n, c) => n + c.length, 0)));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * `<flag byte><payload>` as base64url. The flag says how the payload was written, so a link made
 * in a browser with `CompressionStream` still opens in one without it (and the other way round).
 */
async function encode(cmds: ShareCommand[]): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(cmds));
  let flag = RAW;
  let body: Uint8Array = json;
  if (typeof CompressionStream === 'function') {
    body = await pipe(json, deflate());
    flag = DEFLATE;
  }
  const out = new Uint8Array(body.length + 1);
  out[0] = flag;
  out.set(body, 1);
  return toBase64Url(out);
}

async function decode(payload: string): Promise<ShareCommand[]> {
  const bytes = fromBase64Url(payload);
  const flag = bytes[0];
  const body = bytes.subarray(1);
  let json: Uint8Array;
  if (flag === RAW) json = body;
  else if (flag === DEFLATE) json = await pipe(body, inflate());
  else throw new Error(`unknown share encoding ${String(flag)}`);
  const parsed: unknown = JSON.parse(new TextDecoder().decode(json));
  if (!Array.isArray(parsed) || parsed.some((c) => typeof (c as ShareCommand | null)?.cmd !== 'string')) {
    throw new Error('not a list of Commands');
  }
  return parsed as ShareCommand[];
}

/**
 * A URL that reopens this Journal: `<page>#j=<base64url>`, deflated where the browser has
 * `CompressionStream`. Refuses over `MAX_FRAGMENT` with the Command to use instead.
 */
export async function shareUrl(cmds: ShareCommand[], base: string): Promise<string> {
  const payload = await encode(cmds);
  const url = `${base.split('#')[0]}#j=${payload}`;
  if (payload.length > MAX_FRAGMENT) {
    throw new FemError(
      'unsupported',
      `this Journal is ${Math.round(payload.length / 1024)} kB compressed, over the ${MAX_FRAGMENT / 1024} kB a URL can carry`,
      'file.shareLink',
      'file.save writes the whole Model to a file you can send instead',
    );
  }
  return url;
}

/** The Journal a `#j=…` fragment carries, or `null` when there is no share link in the URL. */
export async function readShareFragment(hash: string): Promise<ShareCommand[] | null> {
  const payload = /(?:^|[#&])j=([A-Za-z0-9\-_]+)/.exec(hash)?.[1];
  if (!payload) return null;
  try {
    return await decode(payload);
  } catch (e) {
    throw new FemError('schema', `this share link is damaged: ${(e as Error).message}`, 'the #j= fragment', 'ask for the link again, or open the model file');
  }
}

/** Replay a shared or restored Journal onto the current Model, one Command at a time. */
export async function applyShared(registry: Dispatcher, cmds: ShareCommand[]): Promise<number> {
  for (const cmd of cmds) await registry.dispatch(cmd);
  return cmds.length;
}

/**
 * The whole boot hook, so `main.tsx` needs one line:
 * `await openShared(dispatchable, location.hash);`
 * Returns the number of Commands replayed, or 0 when the URL carries no share link.
 */
export async function openShared(registry: Dispatcher, hash: string): Promise<number> {
  const cmds = await readShareFragment(hash);
  return cmds ? applyShared(registry, cmds) : 0;
}
