// The two ways a Model leaves and re-enters this browser without a file (PLAN.md 5.8, J11.4 and
// J12.2): a share link that carries the Journal in the URL fragment, and an autosave that keeps
// the last one in IndexedDB. Both move a *Command list*, never a Model snapshot — replay rebuilds
// the Model, and a Journal is an order of magnitude smaller than the `femlab/1` file.
//
// Nothing leaves the page in either case: a fragment is never sent to a server, and IndexedDB is
// per-origin. Storage is behind `JournalStore` so the units are testable with a fake, as every
// other boundary in this repo is (AGENTS: dependency injection everywhere a boundary exists).
//
// Three lines mount all of it, and they live in files this module does not own:
//
//   main.tsx, at the end of `refresh()` (which already runs after every journaled Command):
//     noteAutosave(store.state.model.name, store.state.journal);
//
//   main.tsx, next to the existing `?example=` line at the end of `boot()`:
//     await primeAutosave();
//     await openShared({ dispatch }, location.hash);
//
//   the start screen (src/ui/Overlays.tsx `Start`), one card when `query.autosave` has a `saved`:
//     <Cmd dispatch={dispatch} cmd="file.restore" class="card">…</Cmd>
//
// `noteAutosave` and `primeAutosave` are in `host.ts`, next to the `HostContext` that shares the
// same autosave instance; `openShared` is here.
import { FemError } from '@femlab/registry';

/** A Command in the app's wire shape — the same thing the Journal holds. */
export type ShareCommand = { cmd: string } & Record<string, unknown>;

/** What a Journal entry looks like coming back from `query.journal`. */
interface JournalEntry {
  cmd: ShareCommand;
}

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

// ---------------------------------------------------------------------------- autosave

/** The last autosave: enough to say what it is before the person decides to reopen it. */
export interface Saved {
  name: string;
  at: number;
  cmds: ShareCommand[];
}

/** Where the autosave lives. One implementation per storage; the app injects the real one. */
export interface JournalStore {
  read(): Promise<Saved | null>;
  write(s: Saved): Promise<void>;
  clear(): Promise<void>;
}

const DB_NAME = 'femlab';
const STORE = 'autosave';
const KEY = 'last';

const done = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });

/** The real one: a single record in a single object store. No library, no schema migration. */
export function indexedDbStore(factory: IDBFactory): JournalStore {
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = factory.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('cannot open IndexedDB'));
    });
  const tx = async <T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await done(run(db.transaction(STORE, mode).objectStore(STORE)));
    } finally {
      db.close();
    }
  };
  return {
    read: () => tx('readonly', (s) => s.get(KEY) as IDBRequest<Saved | undefined>).then((v) => v ?? null),
    write: (saved) => tx('readwrite', (s) => s.put(saved, KEY)).then(() => undefined),
    clear: () => tx('readwrite', (s) => s.delete(KEY)).then(() => undefined),
  };
}

/** For tests, and for a browser that refuses IndexedDB (private mode): autosave then costs nothing. */
export function memoryStore(): JournalStore {
  let saved: Saved | null = null;
  return {
    read: () => Promise.resolve(saved),
    write: (s) => {
      saved = s;
      return Promise.resolve();
    },
    clear: () => {
      saved = null;
      return Promise.resolve();
    },
  };
}

export interface Autosave {
  /** Call after every Command; writes at most once per `delayMs`. */
  note(name: string, journal: JournalEntry[]): void;
  setEnabled(on: boolean): void;
  enabled(): boolean;
  /** The pending write, awaited — for tests and for `beforeunload`. */
  flush(): Promise<void>;
  read(): Promise<Saved | null>;
  clear(): Promise<void>;
}

export interface AutosaveOptions {
  store: JournalStore;
  /** Debounce: a burst of Commands costs one write. */
  delayMs?: number;
  /** Injected so a test does not have to wait in real time. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  /** Autosave is on unless the person turned it off; the choice sticks in this browser. */
  initiallyOn?: boolean;
  /** Told about a write that failed, so the console can say so instead of the tab dying. */
  onError?: (e: unknown) => void;
}

/**
 * Writes the Journal to `store` after every Command, debounced. A failed write is reported and
 * swallowed: losing an autosave must never take the model down with it.
 */
export function makeAutosave({
  store,
  delayMs = 500,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  initiallyOn = true,
  onError,
}: AutosaveOptions): Autosave {
  let on = initiallyOn;
  let timer: unknown = null;
  let pending: Saved | null = null;
  let writing: Promise<void> = Promise.resolve();

  const write = (): void => {
    const saved = pending;
    timer = null;
    pending = null;
    if (!saved) return;
    writing = store.write(saved).catch((e: unknown) => onError?.(e));
  };

  return {
    note(name, journal) {
      if (!on) return;
      pending = { name, at: Date.now(), cmds: journal.map((e) => e.cmd) };
      if (timer === null) timer = setTimer(write, delayMs);
    },
    setEnabled(next) {
      on = next;
      if (on) return;
      if (timer !== null) clearTimer(timer);
      timer = null;
      pending = null;
    },
    enabled: () => on,
    async flush() {
      if (timer !== null) {
        clearTimer(timer);
        write();
      }
      await writing;
    },
    read: () => store.read(),
    clear: () => store.clear(),
  };
}
