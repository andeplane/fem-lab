// The share link and the autosave (PLAN.md 5.8). Both are pure enough to test without a browser:
// the fragment is bytes in and Commands out, and the autosave writes to an injected `JournalStore`.
import { describe, expect, it, vi } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { HOST_COMMANDS, Registry, type EngineSchema } from '@femlab/registry';
import schema from '../../registry/src/generated/engine.schema.json';
import { appHostCommands, makeHostContext } from '../src/host';
import { Store } from '../src/store';
import type { WorkerTransport } from '../src/worker-transport';
import {
  MAX_FRAGMENT,
  MAX_JOURNAL_BYTES,
  applyShared,
  makeAutosave,
  indexedDbStore,
  memoryStore,
  openShared,
  readShareFragment,
  shareUrl,
  type ShareCommand,
  type JournalStore,
} from '../src/share';

const CMDS: ShareCommand[] = [
  { cmd: 'model.new', name: 'beam' },
  { cmd: 'geometry.addBox', name: 'beam', size: ['1 m', '100 mm', '100 mm'] },
  { cmd: 'material.add', name: 'stål', E: '210 GPa', nu: 0.3 },
];

const BASE = 'https://andeplane.github.io/fem-lab/';

// Deliberately independent of the production encoder: untrusted links need not use shareUrl.
function fragment(input: unknown, compressed = false): string {
  const json = Buffer.from(JSON.stringify(input));
  const body = compressed ? deflateRawSync(json) : json;
  return `#j=${Buffer.concat([Buffer.from([compressed ? 1 : 0]), body]).toString('base64url')}`;
}

const hostCommands = [
  ...HOST_COMMANDS,
  ...appHostCommands(new Store(), {} as WorkerTransport, { current: null }, async () => undefined),
];
function autosaveRegistry(save: ReturnType<typeof makeAutosave>) {
  const transport = { dispatch: vi.fn(async () => ({ seq: 0, revision: 1, hash: 'h', warnings: [], output: { type: 'none' } })) } as unknown as WorkerTransport;
  const host = makeHostContext(new Store(), transport, { current: null }, {} as never, undefined, undefined, save);
  return { registry: new Registry({ schema: schema as unknown as EngineSchema, host }), transport };
}
const journals = path.resolve(import.meta.dirname, '../../../crates/engine/benches/journals');
const fixtures = readdirSync(journals).filter((name) => name.endsWith('.json') && !name.endsWith('.meta.json'));

describe('share link', () => {
  it('round-trips a Journal through the URL fragment', async () => {
    const url = await shareUrl(CMDS, BASE);
    expect(url.startsWith(`${BASE}#j=`)).toBe(true);
    expect(await readShareFragment(new URL(url).hash)).toEqual(CMDS);
  });

  it('deflates, and a browser without CompressionStream still reads the link (and writes one back)', async () => {
    const deflated = await shareUrl(CMDS, BASE);

    const real = globalThis.CompressionStream;
    // @ts-expect-error deleting a global is the point of the test
    delete globalThis.CompressionStream;
    try {
      // the plain-base64url fallback still round-trips …
      const raw = await shareUrl(CMDS, BASE);
      expect(raw.length).toBeGreaterThan(deflated.length);
      expect(await readShareFragment(new URL(raw).hash)).toEqual(CMDS);
      // … and the flag byte means the deflated link a colleague sent still opens here,
      // because DecompressionStream is what reads it and that is still present
      expect(await readShareFragment(new URL(deflated).hash)).toEqual(CMDS);
    } finally {
      globalThis.CompressionStream = real;
    }
  });

  it('keeps the fragment URL-safe and replaces an existing one instead of appending', async () => {
    const url = await shareUrl(CMDS, `${BASE}#j=stale`);
    expect(url.slice(BASE.length)).toMatch(/^#j=[A-Za-z0-9\-_]+$/);
    expect(url).not.toContain('stale');
  });

  it('refuses a Journal too big for a URL, and says what to do instead', async () => {
    const huge: ShareCommand[] = Array.from({ length: 6_000 }, (_, i) => ({
      cmd: 'geometry.nameRegion',
      // random-ish text so it does not simply deflate away
      name: `r${i}${Math.random().toString(36)}`,
    }));
    await expect(shareUrl(huge, BASE)).rejects.toMatchObject({
      code: 'unsupported',
      where: 'file.shareLink',
      suggestion: expect.stringContaining('file.save'),
    });
    expect(MAX_FRAGMENT).toBe(32 * 1024);
  });

  it('returns null when the URL carries no share link', async () => {
    expect(await readShareFragment('')).toBeNull();
    expect(await readShareFragment('#')).toBeNull();
    expect(await readShareFragment('#tutorial=cantilever')).toBeNull();
  });

  it('reports a damaged link as a structured error rather than throwing garbage', async () => {
    // not base64, not deflate, not JSON, and not a Command list
    await expect(readShareFragment('#j=zzzz')).rejects.toMatchObject({ code: 'schema', where: 'the #j= fragment' });
    const notCommands = await shareUrl([{ cmd: 'model.new' }], BASE);
    // corrupt the payload in the middle: the deflate stream no longer checks out
    const broken = `${notCommands.slice(0, -6)}AAAAAA`;
    await expect(readShareFragment(new URL(broken).hash)).rejects.toMatchObject({ code: 'schema' });
  });

  it('rejects a fragment that decodes to something that is not a list of Commands', async () => {
    const real = globalThis.CompressionStream;
    // @ts-expect-error the raw path is the one that can be hand-forged
    delete globalThis.CompressionStream;
    try {
      const bytes = new Uint8Array([0x00, ...new TextEncoder().encode('{"not":"an array"}')]);
      const payload = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      await expect(readShareFragment(`#j=${payload}`)).rejects.toMatchObject({ code: 'schema' });
      const notCmds = new Uint8Array([0x00, ...new TextEncoder().encode('[{"nope":1}]')]);
      const p2 = btoa(String.fromCharCode(...notCmds)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      await expect(readShareFragment(`#j=${p2}`)).rejects.toMatchObject({ code: 'schema' });
      // an unknown encoding flag from a future version
      const future = new Uint8Array([0x7f, 1, 2, 3]);
      const p3 = btoa(String.fromCharCode(...future)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      await expect(readShareFragment(`#j=${p3}`)).rejects.toMatchObject({ code: 'schema' });
    } finally {
      globalThis.CompressionStream = real;
    }
  });

  it('applies a shared Journal one Command at a time, in order', async () => {
    const seen: ShareCommand[] = [];
    const registry = { dispatch: async (cmd: ShareCommand) => void seen.push(cmd) };
    const url = await shareUrl(CMDS, BASE);
    await expect(openShared(registry, new URL(url).hash)).resolves.toBe(3);
    expect(seen).toEqual(CMDS);
    // no fragment: the boot hook does nothing and says so
    await expect(openShared(registry, '#')).resolves.toBe(0);
    expect(seen).toHaveLength(3);
    await expect(applyShared(registry, [])).resolves.toBe(0);
  });

  it.each(hostCommands.map((d) => d.name))('rejects host Command %s before dispatching even a valid prefix', async (cmd) => {
    const registry = { dispatch: vi.fn() };
    await expect(openShared(registry, fragment([CMDS[0], { cmd, code: 'return 123' }]))).rejects.toMatchObject({ code: 'schema' });
    expect(registry.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    { cmd: 'unknown.command' },
    { cmd: 'journal.undo' },
    { cmd: 'journal.redo' },
    { cmd: 'plugin.load', name: 'code', kind: 'material', language: 'typescript', source: { inline: 'return 123' } },
    { cmd: 'model.new' },
    { cmd: 'model.new', name: 123 },
    { cmd: 'geometry.addBox', name: 'beam', size: ['1 m', '1 m'] },
    { cmd: 'geometry.addBox', name: 'beam', size: ['1 m', '1 m', { value: 'bad', unit: 'm' }] },
    { cmd: 'material.add', name: 'steel', E: '210 GPa', nu: '0.3' },
    { cmd: 'model.setIdealisation', idealisation: { type: 'invented' } },
    { query: 'query.model' },
    { cmd: null },
    null,
    [],
    'model.new',
  ])('rejects invalid engine entry %j before dispatching', async (invalid) => {
    const registry = { dispatch: vi.fn() };
    for (const compressed of [false, true]) {
      await expect(openShared(registry, fragment([...CMDS, invalid], compressed))).rejects.toMatchObject({ code: 'schema' });
    }
    expect(registry.dispatch).not.toHaveBeenCalled();
  });

  it('validates directly restored Journals before any dispatch too', async () => {
    const registry = { dispatch: vi.fn() };
    await expect(applyShared(registry, [...CMDS, { cmd: 'script.run', code: 'return 123' }])).rejects.toMatchObject({ code: 'schema' });
    expect(registry.dispatch).not.toHaveBeenCalled();
  });

  it('accepts independently encoded engine Journals with nested quantity parts in either encoding', async () => {
    const cmds = [...CMDS, { cmd: 'geometry.addBox', name: 'second', size: [{ value: 2, unit: 'm' }, '1 m', '1 m'] }];
    for (const compressed of [false, true]) {
      const registry = { dispatch: vi.fn().mockResolvedValue(undefined) };
      await expect(openShared(registry, fragment(cmds, compressed))).resolves.toBe(cmds.length);
      expect(registry.dispatch.mock.calls.map(([cmd]) => cmd)).toEqual(cmds);
    }
  });

  it.each(fixtures)('shares and restores the complete benchmark Journal %s', async (name) => {
    const entries = JSON.parse(readFileSync(path.join(journals, name), 'utf8')) as { cmd: ShareCommand }[];
    const cmds = entries.map((entry) => entry.cmd);
    const registry = { dispatch: vi.fn().mockResolvedValue(undefined) };
    await expect(openShared(registry, fragment(cmds, true))).resolves.toBe(cmds.length);
    expect(registry.dispatch.mock.calls.map(([cmd]) => cmd)).toEqual(cmds);
    registry.dispatch.mockClear();
    await expect(applyShared(registry, cmds)).resolves.toBe(cmds.length);
    expect(registry.dispatch.mock.calls.map(([cmd]) => cmd)).toEqual(cmds);
  });

  it('refuses oversized encoded input before base64 decoding', async () => {
    const decode = vi.spyOn(globalThis, 'atob');
    const registry = { dispatch: vi.fn() };
    try {
      await expect(openShared(registry, `#j=${'A'.repeat(MAX_FRAGMENT + 1)}`)).rejects.toMatchObject({ code: 'schema' });
      expect(decode).not.toHaveBeenCalled();
      expect(registry.dispatch).not.toHaveBeenCalled();
    } finally {
      decode.mockRestore();
    }
  });

  it.each(['#j=', '#j=AA!!', '#j=AA%20', '#j=AA='])('rejects malformed payload %s instead of ignoring or truncating it', async (hash) => {
    await expect(readShareFragment(hash)).rejects.toMatchObject({ code: 'schema' });
  });

  it('accepts exactly the decompressed byte limit and rejects one byte more', async () => {
    const overhead = Buffer.byteLength(JSON.stringify([{ cmd: 'model.new', name: '' }]));
    const cmds = [{ cmd: 'model.new', name: 'x'.repeat(MAX_JOURNAL_BYTES - overhead) }];
    expect(Buffer.byteLength(JSON.stringify(cmds))).toBe(MAX_JOURNAL_BYTES);
    await expect(readShareFragment(fragment(cmds, true))).resolves.toEqual(cmds);
    cmds[0]!.name += 'x';
    const bomb = fragment(cmds, true);
    expect(bomb.length).toBeLessThan(MAX_FRAGMENT);
    const registry = { dispatch: vi.fn() };
    await expect(openShared(registry, bomb)).rejects.toMatchObject({ code: 'schema', message: expect.stringContaining('uncompressed') });
    expect(registry.dispatch).not.toHaveBeenCalled();
    await expect(shareUrl(cmds, BASE)).rejects.toMatchObject({ code: 'unsupported', suggestion: expect.stringContaining('file.save') });
  });

  it('cancels decompression as soon as streamed output exceeds the limit', async () => {
    const cancel = vi.fn();
    class OversizedDecompression {
      readable = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_JOURNAL_BYTES));
          controller.enqueue(new Uint8Array(1));
          // Deliberately never close: reading the whole stream would hang.
        },
        cancel,
      });
      writable = new WritableStream();
    }
    vi.stubGlobal('DecompressionStream', OversizedDecompression);
    try {
      await expect(readShareFragment(fragment(CMDS, true))).rejects.toMatchObject({ code: 'schema', message: expect.stringContaining('uncompressed') });
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('IndexedDB autosave transactions', () => {
  // Drive the browser transaction boundary independently: request success can precede abort.
  function transactionHarness() {
    const request = { result: undefined, error: null } as IDBRequest<undefined>;
    const transaction = { objectStore: () => ({ delete: () => request }), error: null } as unknown as IDBTransaction;
    const close = vi.fn();
    const database = { transaction: () => transaction, close, objectStoreNames: { contains: () => false } } as unknown as IDBDatabase;
    const open = { result: database, error: null } as IDBOpenDBRequest;
    const factory = { open: () => { queueMicrotask(() => open.onsuccess!.call(open, new Event('success'))); return open; }, cmp: () => 0, databases: async () => [], deleteDatabase: () => open } satisfies IDBFactory;
    const store = indexedDbStore(factory);
    return { request, transaction, close, open, store };
  }

  it('waits for clear transaction commit after the delete request succeeds', async () => {
    const { store, request, transaction, close } = transactionHarness();
    let completed = false;
    const clearing = store.clear().then(() => { completed = true; });
    await vi.waitFor(() => expect(request.onsuccess).toBeTypeOf('function'));
    request.onsuccess!.call(request, new Event('success'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const completedBeforeCommit = completed;
    transaction.oncomplete!.call(transaction, new Event('complete'));
    await clearing;
    expect(completedBeforeCommit).toBe(false);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('rejects an aborted clear even when its delete request already succeeded', async () => {
    const { store, request, transaction, close } = transactionHarness();
    const clearing = store.clear();
    await vi.waitFor(() => expect(request.onsuccess).toBeTypeOf('function'));
    request.onsuccess!.call(request, new Event('success'));
    Object.assign(transaction, { error: new DOMException('commit aborted', 'AbortError') });
    transaction.onabort!.call(transaction, new Event('abort'));
    await expect(clearing).rejects.toThrow('commit aborted');
    expect(close).toHaveBeenCalledTimes(2);
  });
});

describe('autosave', () => {
  /** A fake clock: the debounce fires when the test says so, not when the wall clock says so. */
  function fakeTimers() {
    let pending: (() => void) | null = null;
    return {
      setTimer: (fn: () => void) => {
        pending = fn;
        return 1;
      },
      clearTimer: () => {
        pending = null;
      },
      tick: () => {
        const fn = pending;
        pending = null;
        fn?.();
      },
      armed: () => pending !== null,
    };
  }

  const journal = (n: number) => Array.from({ length: n }, (_, i) => ({ cmd: { cmd: 'model.new', name: `m${i}` } }));

  it('writes the Journal once per burst, not once per Command', async () => {
    const store = memoryStore();
    const write = vi.spyOn(store, 'write');
    const timers = fakeTimers();
    const a = makeAutosave({ store, ...timers });

    a.note('beam', journal(1));
    a.note('beam', journal(2));
    a.note('beam', journal(3));
    expect(write).not.toHaveBeenCalled(); // still inside the debounce
    timers.tick();
    await a.flush();
    expect(write).toHaveBeenCalledTimes(1);
    expect(await a.read()).toMatchObject({ name: 'beam', cmds: expect.any(Array) });
    expect((await a.read())?.cmds).toHaveLength(3); // the newest state, not the first
  });

  it('flush writes a pending burst immediately, and is safe with nothing pending', async () => {
    const store = memoryStore();
    const timers = fakeTimers();
    const a = makeAutosave({ store, ...timers });
    await a.flush(); // nothing armed
    expect(await a.read()).toBeNull();
    a.note('beam', journal(2));
    await a.flush();
    expect((await a.read())?.cmds).toHaveLength(2);
    expect(timers.armed()).toBe(false);
  });

  it('is on by default, can be turned off, and turning it off drops what was pending', async () => {
    const store = memoryStore();
    const timers = fakeTimers();
    const a = makeAutosave({ store, ...timers });
    expect(a.enabled()).toBe(true);

    a.note('beam', journal(1));
    a.setEnabled(false);
    expect(a.enabled()).toBe(false);
    await a.flush();
    expect(await a.read()).toBeNull();

    a.note('beam', journal(1)); // ignored while off
    timers.tick();
    await a.flush();
    expect(await a.read()).toBeNull();

    a.setEnabled(true);
    a.setEnabled(true); // idempotent, and does not arm a timer on its own
    expect(timers.armed()).toBe(false);
    a.note('beam', journal(4));
    await a.flush();
    expect((await a.read())?.cmds).toHaveLength(4);

    await a.clear();
    expect(await a.read()).toBeNull();
  });

  it('starts off when the browser remembered that choice', () => {
    expect(makeAutosave({ store: memoryStore(), initiallyOn: false }).enabled()).toBe(false);
  });

  it('reports a failed write instead of taking the model down with it', async () => {
    const store = memoryStore();
    store.write = () => Promise.reject(new Error('QuotaExceededError'));
    const onError = vi.fn();
    const timers = fakeTimers();
    const a = makeAutosave({ store, onError, ...timers });
    a.note('beam', journal(1));
    await a.flush(); // must not reject
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'QuotaExceededError' }));
  });

  it('uses a real timer by default, so the app needs no wiring', async () => {
    const store = memoryStore();
    const a = makeAutosave({ store, delayMs: 1 });
    a.note('beam', journal(1));
    await new Promise((r) => setTimeout(r, 10));
    await a.flush();
    expect(await a.read()).not.toBeNull();
  });

  it('keeps bounded, addressable revisions and preserves same-name prefixes', async () => {
    const store = memoryStore();
    const timers = fakeTimers();
    let now = 100;
    const a = makeAutosave({ store, ...timers, now: () => now++, delayMs: 0 });
    for (let count = 1; count <= 25; count++) {
      a.note('beam', journal(count));
      timers.tick();
      await a.flush();
    }
    const revisions = await a.readAll();
    expect(revisions).toHaveLength(20);
    expect(revisions[0]?.cmds).toHaveLength(25);
    expect(new Set(revisions.map((revision) => revision.id)).size).toBe(20);
    const prefix = revisions.find((revision) => revision.cmds.length === 20);
    expect(prefix?.name).toBe('beam');
  });

  it('keeps an unchanged revision id targetable after a refresh and flush', async () => {
    const store = memoryStore();
    const timers = fakeTimers();
    const a = makeAutosave({ store, ...timers, now: () => 100 });
    a.note('beam', journal(1));
    await a.flush();
    const saved = (await a.readAll())[0]!;
    a.note('beam', journal(1));
    const shown = a.history()[0]!;
    await a.flush();
    expect((await a.readAll()).find((revision) => revision.id === shown.id)).toEqual(saved);
  });

  it('keeps a refreshed History id targetable through the Registry restore Command', async () => {
    const store = memoryStore();
    const timers = fakeTimers();
    const a = makeAutosave({ store, ...timers, now: () => 100 });
    const { registry, transport } = autosaveRegistry(a);
    a.note('beam', journal(1));
    await a.flush();
    a.note('beam', journal(1));
    const shown = (await registry.query({ query: 'query.autosaveHistory' }) as { revisions: { id: string }[] }).revisions[0]!;
    await a.flush();
    await expect(registry.dispatch({ cmd: 'file.restore', id: shown.id })).resolves.toMatchObject({ name: 'beam' });
    expect(transport.dispatch).toHaveBeenCalled();
  });

  it('restores an older Journal when undo returns to its content', async () => {
    const a = makeAutosave({ store: memoryStore(), ...fakeTimers(), now: () => 100 });
    const { registry } = autosaveRegistry(a);
    a.note('a', journal(1));
    await a.flush();
    a.note('b', journal(2));
    await a.flush();
    a.note('a', journal(1));
    const shown = a.history()[0]!;
    await a.flush();
    await expect(registry.dispatch({ cmd: 'file.restore', id: shown.id })).resolves.toMatchObject({ name: 'a' });
  });

  it('merges revisions from two already-open sessions', async () => {
    const store = memoryStore();
    const a = makeAutosave({ store, now: () => 100 });
    const b = makeAutosave({ store, now: () => 200 });
    await a.readAll();
    await b.readAll();
    a.note('a', journal(1));
    await a.flush();
    b.note('b', journal(2));
    await b.flush();
    const { registry } = autosaveRegistry(b);
    await expect(registry.query({ query: 'query.autosaveHistory' })).resolves.toMatchObject({ revisions: [{ name: 'b' }, { name: 'a' }] });
  });

  it('keeps the newest revision when an older full batch commits after it', async () => {
    const store = memoryStore();
    let oldTime = 100;
    const old = makeAutosave({ store, now: () => oldTime++, id: () => `old-${oldTime}` });
    const newer = makeAutosave({ store, now: () => 1_000, id: () => 'newer' });
    await old.readAll();
    await newer.readAll();
    for (let count = 1; count <= 20; count++) old.note(`old-${count}`, journal(count));
    newer.note('newer', journal(1));
    await newer.flush();
    await old.flush();
    expect((await old.readAll()).map((revision) => revision.name)).toEqual([
      'newer',
      ...Array.from({ length: 19 }, (_, i) => `old-${20 - i}`),
    ]);
  });

  it('keeps same-clock revisions distinct and restores either through the Registry', async () => {
    const store = memoryStore();
    const a = makeAutosave({ store, now: () => 100 });
    const b = makeAutosave({ store, now: () => 100 });
    await a.readAll();
    await b.readAll();
    a.note('a', journal(1));
    await a.flush();
    b.note('b', journal(2));
    await b.flush();
    const { registry } = autosaveRegistry(b);
    const rows = (await registry.query({ query: 'query.autosaveHistory' }) as { revisions: { id: string; name: string }[] }).revisions;
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    for (const row of rows) await expect(registry.dispatch({ cmd: 'file.restore', id: row.id })).resolves.toMatchObject({ name: row.name });
  });

  it('preserves distinct IDs when two open sessions save identical content', async () => {
    const store = memoryStore();
    const a = makeAutosave({ store, now: () => 100 });
    const b = makeAutosave({ store, now: () => 200 });
    await a.readAll();
    await b.readAll();
    a.note('a', journal(1));
    const first = a.history()[0]!.id!;
    await a.flush();
    b.note('a', journal(1));
    const second = b.history()[0]!.id!;
    await b.flush();
    const { registry } = autosaveRegistry(b);
    const rows = (await registry.query({ query: 'query.autosaveHistory' }) as { revisions: { id: string; name: string }[] }).revisions;
    expect(second).not.toBe(first);
    expect(rows.map((row) => row.id)).toEqual(expect.arrayContaining([first, second]));
    for (const row of rows.filter((row) => row.id === first || row.id === second)) {
      await expect(registry.dispatch({ cmd: 'file.restore', id: row.id })).resolves.toMatchObject({ name: 'a' });
    }
  });

  it('keeps a failed revision visible and retryable after a quota error', async () => {
    const store = memoryStore();
    const onError = vi.fn();
    const a = makeAutosave({ store, onError, now: () => 100 });
    a.note('a', journal(1));
    await a.flush();
    store.write = async () => {
      throw new Error('QuotaExceededError');
    };
    a.note('b', journal(2));
    const shown = a.history()[0]!;
    await a.flush();
    expect(onError).toHaveBeenCalledOnce();
    const { registry } = autosaveRegistry(a);
    await expect(registry.query({ query: 'query.autosaveHistory' })).resolves.toMatchObject({ revisions: expect.arrayContaining([expect.objectContaining({ id: shown.id })]) });
    await expect(registry.dispatch({ cmd: 'file.restore', id: shown.id })).resolves.toMatchObject({ name: 'b' });
  });

  function latch() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
  }

  function delayedStore(fail = false) {
    const storage = memoryStore();
    const entered = latch();
    const gate = latch();
    let calls = 0;
    const write: JournalStore['write'] = vi.fn(async (saved, merge) => {
      if (++calls === 1) {
        entered.release();
        await gate.promise;
        if (fail) throw new Error('QuotaExceededError');
      }
      await storage.write(saved, merge);
    });
    return { storage, store: { ...storage, write }, entered, gate };
  }

  it('serializes overlapping flushes and keeps each advertised id restorable', async () => {
    const { store, entered, gate } = delayedStore();
    const a = makeAutosave({ store, ...fakeTimers() });
    const { registry } = autosaveRegistry(a);
    a.note('a', journal(1));
    const firstId = a.history()[0]!.id!;
    const first = a.flush();
    await entered.promise;
    a.note('b', journal(2));
    const secondId = a.history()[0]!.id!;
    let completed = false;
    const second = a.flush().then(() => { completed = true; });
    const restore = registry.dispatch({ cmd: 'file.restore', id: firstId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const overtook = completed;
    const visibleIds = a.history().map((revision) => revision.id);
    gate.release();
    await Promise.all([first, second]);
    expect(overtook).toBe(false);
    expect(visibleIds).toEqual([secondId, firstId]);
    await expect(restore).resolves.toMatchObject({ name: 'a' });
    await expect(registry.dispatch({ cmd: 'file.restore', id: secondId })).resolves.toMatchObject({ name: 'b' });
  });

  it('clears all earlier writes without resurrecting their revisions', async () => {
    const { storage, store, entered, gate } = delayedStore();
    const a = makeAutosave({ store, ...fakeTimers() });
    a.note('a', journal(1));
    const first = a.flush();
    await entered.promise;
    a.note('b', journal(2));
    const second = a.flush();
    let cleared = false;
    const clearing = a.clear().then(() => { cleared = true; });
    expect(a.history()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const clearedEarly = cleared;
    gate.release();
    await Promise.all([first, second, clearing]);
    expect(clearedEarly).toBe(false);
    expect(await storage.read()).toEqual([]);
    expect(await a.readAll()).toEqual([]);
  });

  it.each([false, true])('keeps newest-first order after quota failure with a newer flush queued=%s', async (queueNewer) => {
    const { storage, store, entered, gate } = delayedStore(true);
    const onError = vi.fn();
    const a = makeAutosave({ store, onError, ...fakeTimers() });
    a.note('a', journal(1));
    const first = a.flush();
    await entered.promise;
    a.note('b', journal(2));
    const newer = queueNewer ? a.flush() : Promise.resolve();
    gate.release();
    await Promise.all([first, newer]);
    expect(onError).toHaveBeenCalledOnce();
    expect(a.history().map((revision) => revision.name)).toEqual(['b', 'a']);
    await a.flush();
    expect((await storage.read()).map((revision) => revision.name)).toEqual(['b', 'a']);
    const { registry } = autosaveRegistry(a);
    await expect(registry.dispatch({ cmd: 'file.restore' })).resolves.toMatchObject({ name: 'b' });
  });

  it('keeps saved revisions and accepts a new revision after Registry autosave off/on', async () => {
    const { storage, store, entered, gate } = delayedStore();
    const a = makeAutosave({ store, ...fakeTimers() });
    const { registry } = autosaveRegistry(a);
    a.note('old', journal(1));
    const first = a.flush();
    await entered.promise;
    await registry.dispatch({ cmd: 'file.autosave', on: false });
    await registry.dispatch({ cmd: 'file.autosave', on: true });
    a.note('new', journal(2));
    const shown = a.history()[0]!.id!;
    const second = a.flush();
    gate.release();
    await Promise.all([first, second]);
    expect((await storage.read()).map((revision) => revision.name)).toEqual(['new', 'old']);
    await expect(registry.dispatch({ cmd: 'file.restore', id: shown })).resolves.toMatchObject({ name: 'new' });
  });

  it('cancels a queued pre-clear batch and keeps the next generation of notes', async () => {
    const store = memoryStore();
    const write = vi.spyOn(store, 'write');
    const timers = fakeTimers();
    const a = makeAutosave({ store, ...timers });
    a.note('old', journal(1));
    const old = a.flush();
    const clearing = a.clear();
    expect(timers.armed()).toBe(false);
    a.note('new', journal(2));
    const current = a.flush();
    await Promise.all([old, clearing, current]);
    expect(write).toHaveBeenCalledTimes(1);
    expect((await a.readAll()).map((revision) => revision.name)).toEqual(['new']);
  });

  it('coalesces backpressure into one bounded pending batch', async () => {
    const { storage, store, entered, gate } = delayedStore();
    const a = makeAutosave({ store, ...fakeTimers() });
    a.note('old', journal(1));
    const pending = [a.flush()];
    await entered.promise;
    for (let i = 1; i <= 100; i++) {
      a.note(`new-${i}`, journal(i + 1));
      pending.push(a.flush());
    }
    expect(a.history()).toHaveLength(20);
    gate.release();
    await Promise.all(pending);
    expect(store.write).toHaveBeenCalledTimes(2);
    const saved = await storage.read();
    expect(saved.map((revision) => revision.name)).toEqual(Array.from({ length: 20 }, (_, i) => `new-${100 - i}`));
    expect(new Set(saved.map((revision) => revision.id)).size).toBe(20);
  });

  it('recovers after a rejected read without poisoning the storage queue', async () => {
    const store = memoryStore();
    vi.spyOn(store, 'read').mockRejectedValueOnce(new Error('temporary read failure'));
    const a = makeAutosave({ store, ...fakeTimers() });
    await expect(a.readAll()).rejects.toThrow('temporary read failure');
    a.note('retry', journal(1));
    await a.flush();
    await expect(a.read()).resolves.toMatchObject({ name: 'retry' });
  });

  it('reports a failed clear and still permits later storage operations', async () => {
    const store = memoryStore();
    vi.spyOn(store, 'clear').mockRejectedValueOnce(new Error('temporary clear failure'));
    const onError = vi.fn();
    const a = makeAutosave({ store, onError, ...fakeTimers() });
    await a.clear();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'temporary clear failure' }));
    a.note('later', journal(1));
    await a.flush();
    await expect(a.read()).resolves.toMatchObject({ name: 'later' });
  });

  it('migrates a pre-versioning single record and uses the injected clock', async () => {
    const legacy = { name: 'old', at: 42, cmds: journal(2) };
    let stored: unknown = legacy;
    const store = {
      read: vi.fn(async () => stored),
      write: vi.fn(async (saved: unknown) => {
        stored = saved;
      }),
      clear: vi.fn(async () => undefined),
    } as JournalStore;
    const a = makeAutosave({ store, now: () => 99 });
    await expect(a.readAll()).resolves.toEqual([{ ...legacy, id: 'legacy-42' }]);
    a.note('new', journal(3));
    await a.flush();
    expect(await a.readAll()).toMatchObject([{ name: 'new', at: 99 }, { name: 'old', at: 42 }]);
    expect(store.write).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'legacy-42' })]),
      expect.any(Function),
    );
  });
});
