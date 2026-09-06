// The two ways a Model leaves and re-enters this browser without a file (PLAN.md 5.8, J11.4 and
// J12.2): a share link that carries the Journal in the URL fragment, and an autosave history in
// IndexedDB. Both move a *Command list*, never a Model snapshot — replay rebuilds
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
import { z } from 'zod';
import { openDb, REVISIONS } from './db';
import schema from '../../registry/src/generated/engine.schema.json';

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
/** Cap expansion before decoding JSON, even when a highly repetitive Journal compresses well. */
export const MAX_JOURNAL_BYTES = 1024 * 1024;

// Use the engine's generated schema, never the app's mixed engine/host registry. Journal
// controls are not journal entries, and unsupported stubs cannot be replayed.
const journalCommand = z.fromJSONSchema({
  ...schema.commands,
  oneOf: schema.commands.oneOf.filter((v) => !v.properties.cmd.const.startsWith('journal.') && !('x-status' in v && v['x-status'] === 'stub')),
} as unknown as Parameters<typeof z.fromJSONSchema>[0]);

/** Check the entire list before the first dispatch, including commands after a valid prefix. */
function validateJournal(input: unknown): ShareCommand[] {
  if (!Array.isArray(input)) throw new Error('not a list of engine Commands');
  for (const [index, cmd] of input.entries()) {
    if (!journalCommand.safeParse(cmd).success) throw new Error(`Command ${index + 1} is not a valid replayable engine Command`);
  }
  return input as ShareCommand[];
}

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

async function pipe(bytes: Uint8Array, transform: ByteTransform, limit = Infinity): Promise<Uint8Array> {
  const source = new Blob([bytes as BlobPart]).stream() as unknown as ReadableStream<Uint8Array>;
  const chunks: Uint8Array[] = [];
  const reader = source.pipeThrough(transform).getReader();
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) {
        await reader.cancel();
        throw new Error(`Journal exceeds ${limit} bytes uncompressed`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(new ArrayBuffer(length));
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
  if (json.length > MAX_JOURNAL_BYTES) {
    throw new FemError('unsupported', `this Journal exceeds ${MAX_JOURNAL_BYTES} bytes uncompressed`, 'file.shareLink', 'file.save writes the whole Model to a file you can send instead');
  }
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
  else if (flag === DEFLATE) json = await pipe(body, inflate(), MAX_JOURNAL_BYTES);
  else throw new Error(`unknown share encoding ${String(flag)}`);
  if (json.length > MAX_JOURNAL_BYTES) throw new Error(`Journal exceeds ${MAX_JOURNAL_BYTES} bytes uncompressed`);
  const parsed: unknown = JSON.parse(new TextDecoder().decode(json));
  return validateJournal(parsed);
}

/**
 * A URL that reopens this Journal: `<page>#j=<base64url>`, deflated where the browser has
 * `CompressionStream`. Refuses over `MAX_FRAGMENT` encoded or `MAX_JOURNAL_BYTES` uncompressed
 * with the Command to use instead.
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
  const payload = /(?:^|[#&])j=([^&]*)/.exec(hash)?.[1];
  if (payload === undefined) return null;
  try {
    if (payload.length > MAX_FRAGMENT) throw new Error(`fragment exceeds ${MAX_FRAGMENT} characters`);
    if (!/^[A-Za-z0-9\-_]+$/.test(payload)) throw new Error('invalid base64url payload');
    return await decode(payload);
  } catch (e) {
    throw new FemError('schema', `this share link is damaged: ${(e as Error).message}`, 'the #j= fragment', 'ask for the link again, or open the model file');
  }
}

/** Validate a shared or restored engine Journal in full, then replay one Command at a time. */
export async function applyShared(registry: Dispatcher, cmds: ShareCommand[]): Promise<number> {
  try {
    validateJournal(cmds);
  } catch (e) {
    throw new FemError('schema', (e as Error).message, 'the shared Journal', 'open a model file or share a valid engine Journal');
  }
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
  /** Stable within this browser, so a history row can target one revision even when times tie. */
  id?: string;
  name: string;
  at: number;
  cmds: ShareCommand[];
}

/** The newest revisions are kept first; old records are migrated to this list on read. */
export const MAX_AUTOSAVES = 20;

type MergeSaved = (current: Saved[]) => Saved[];

/** Where the autosave lives. One implementation per storage; the app injects the real one. */
export interface JournalStore {
  read(): Promise<Saved[]>;
  /** Stores may merge atomically inside the write transaction when given a callback. */
  write(saved: Saved[], merge?: MergeSaved): Promise<void>;
  clear(): Promise<void>;
}

const STORE = REVISIONS;
const KEY = 'last';

function storedList(value: unknown): Saved[] {
  if (value === null || value === undefined) return [];
  // Version 1 stored one Saved object at `last`; accept it as the newest revision.
  const list = Array.isArray(value) ? value : [value];
  return list.filter((item): item is Saved => {
    if (typeof item !== 'object' || item === null) return false;
    const candidate = item as Partial<Saved>;
    return typeof candidate.name === 'string' && typeof candidate.at === 'number' && Array.isArray(candidate.cmds);
  }).slice(0, MAX_AUTOSAVES);
}

/** The real one: the existing `last` record is read as the first entry and migrated on write. */
export function indexedDbStore(factory: IDBFactory): JournalStore {
  const open = (): Promise<IDBDatabase> => openDb(factory);
  const tx = async <T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      const transaction = db.transaction(STORE, mode);
      return await new Promise<T>((resolve, reject) => {
        let value: T;
        const request = run(transaction.objectStore(STORE));
        request.onsuccess = () => { value = request.result; };
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
        transaction.oncomplete = () => resolve(value);
        transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
        transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
      });
    } finally {
      db.close();
    }
  };
  const atomicWrite = async (saved: Saved[], merge?: MergeSaved): Promise<void> => {
    if (!merge) {
      await tx('readwrite', (s) => s.put(saved.slice(0, MAX_AUTOSAVES), KEY));
      return;
    }
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      const objectStore = transaction.objectStore(STORE);
      let settled = false;
      const close = () => {
        if (!settled) {
          settled = true;
          db.close();
        }
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        db.close();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      transaction.oncomplete = () => {
        close();
        resolve();
      };
      transaction.onerror = () => fail(transaction.error ?? new Error('IndexedDB write failed'));
      transaction.onabort = () => fail(transaction.error ?? new Error('IndexedDB write aborted'));
      const request = objectStore.get(KEY);
      request.onerror = () => transaction.abort();
      request.onsuccess = () => {
        try {
          objectStore.put(merge(storedList(request.result)).slice(0, MAX_AUTOSAVES), KEY);
        } catch (error) {
          transaction.abort();
          fail(error);
        }
      };
    });
  };
  return {
    read: () => tx('readonly', (s) => s.get(KEY) as IDBRequest<unknown>).then(storedList),
    write: atomicWrite,
    clear: () => tx('readwrite', (s) => s.delete(KEY)).then(() => undefined),
  };
}

/** For tests, and for a browser that refuses IndexedDB (private mode): autosave then costs nothing. */
export function memoryStore(): JournalStore {
  let saved: Saved[] = [];
  return {
    read: () => Promise.resolve(saved),
    write: (s, merge) => {
      saved = (merge ? merge(saved) : s).slice(0, MAX_AUTOSAVES);
      return Promise.resolve();
    },
    clear: () => {
      saved = [];
      return Promise.resolve();
    },
  };
}

export interface Autosave {
  /** Call after every Command; writes at most once per `delayMs`. */
  note(name: string, journal: JournalEntry[]): void;
  setEnabled(on: boolean): void;
  enabled(): boolean;
  /** Queue unsaved revisions and await earlier storage operations, including an in-flight write. */
  flush(): Promise<void>;
  /** The newest saved revision, or null when there is no autosave. */
  read(): Promise<Saved | null>;
  /** All saved revisions, newest first. */
  readAll(): Promise<Saved[]>;
  /** Current in-memory revisions, including a debounced snapshot not written yet. */
  history(): Saved[];
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
  /** Injected clock for deterministic revision names and storage tests. */
  now?: () => number;
  /** Injected stable id source for deterministic tests; defaults to a UUID when available. */
  id?: () => string;
}

let autosaveInstanceId = 0;

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
  now = () => Date.now(),
  id,
}: AutosaveOptions): Autosave {
  let on = initiallyOn;
  let timer: unknown = null;
  // Keep snapshots visible until committed; queued writes never own the only copy of an id.
  let unwritten: Saved[] = [];
  const active = new Set<Saved>();
  // At most one writer waits behind the active operation, regardless of note/flush bursts.
  let queuedGeneration: number | null = null;
  let revisions: Saved[] = [];
  let generation = 0;
  let nextId = 0;
  const instanceId = autosaveInstanceId++;
  let writing: Promise<void> = Promise.resolve();

  const normalize = (saved: Saved[]): Saved[] =>
    storedList(saved).map((entry) => entry.id === undefined ? { ...entry, id: `legacy-${entry.at}` } : entry);
  const same = (a: Saved, b: Saved): boolean => a.name === b.name && JSON.stringify(a.cmds) === JSON.stringify(b.cmds);
  const merge = (current: Saved[], incoming: Saved[]): Saved[] => {
    const ids = new Set(incoming.map((revision) => revision.id));
    return [...incoming, ...normalize(current).filter((revision) => !ids.has(revision.id))]
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_AUTOSAVES);
  };
  // Reads, writes and clears share one queue. A rejected read must not poison later writes.
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = writing.then(operation);
    writing = result.then(() => undefined, () => undefined);
    return result;
  };
  const visible = (): Saved[] => merge(revisions, unwritten);

  const write = (): void => {
    timer = null;
    if (queuedGeneration === generation || !unwritten.some((revision) => !active.has(revision))) return;
    const epoch = generation;
    queuedGeneration = epoch;
    void enqueue(async () => {
      let saved: Saved[] = [];
      try {
        if (epoch !== generation) return;
        queuedGeneration = null;
        // Coalesce work queued behind a slow write, including any older quota-failed batch.
        // Taking the entire unsaved list preserves note order when a newer flush was queued
        // before the older write failed. Later notes remain visible while this batch commits.
        saved = unwritten.slice();
        if (saved.length === 0) return;
        for (const revision of saved) active.add(revision);
        const latest = normalize(await store.read());
        let committed = merge(latest, saved);
        await store.write(committed, (current) => (committed = merge(current, saved)));
        if (epoch === generation) {
          revisions = committed;
          unwritten = unwritten.filter((revision) => !saved.includes(revision));
        }
      } catch (error) {
        // Uncommitted snapshots retain their ids and newest-first order for a later retry.
        onError?.(error);
      } finally {
        active.clear();
      }
    });
  };

  const readAll = (): Promise<Saved[]> => {
    const epoch = generation;
    return enqueue(async () => {
      const saved = await store.read();
      if (epoch === generation) revisions = normalize(saved);
      return visible();
    });
  };

  return {
    note(name, journal) {
      if (!on) return;
      const at = now();
      const candidate = { id: id?.() ?? globalThis.crypto?.randomUUID?.() ?? `${at}-${instanceId}-${nextId++}`, name, at, cmds: journal.map((e) => e.cmd) };
      const current = visible().find((revision) => same(revision, candidate));
      const revision = current ? { ...candidate, id: current.id } : candidate;
      unwritten = merge(unwritten, [revision]);
      if (timer === null) timer = setTimer(write, delayMs);
    },
    setEnabled(next) {
      on = next;
      if (on) return;
      if (timer !== null) clearTimer(timer);
      timer = null;
      unwritten = [];
    },
    enabled: () => on,
    async flush() {
      if (timer !== null) {
        clearTimer(timer);
        write();
      } else if (unwritten.length > 0) {
        write();
      }
      await writing;
    },
    read: async () => (await readAll())[0] ?? null,
    readAll,
    history: () => visible(),
    clear: () => {
      // Clear only the revisions known when requested. Notes after a quick off/on toggle
      // belong after this storage barrier and must survive completion of the older clear.
      if (timer !== null) clearTimer(timer);
      timer = null;
      unwritten = [];
      revisions = [];
      generation++;
      queuedGeneration = null;
      return enqueue(async () => {
        try {
          await store.clear();
        } catch (error) {
          onError?.(error);
        }
      });
    },
  };
}
