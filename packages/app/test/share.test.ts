// The share link and the autosave (PLAN.md 5.8). Both are pure enough to test without a browser:
// the fragment is bytes in and Commands out, and the autosave writes to an injected `JournalStore`.
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_FRAGMENT,
  applyShared,
  makeAutosave,
  memoryStore,
  openShared,
  readShareFragment,
  shareUrl,
  type ShareCommand,
} from '../src/share';

const CMDS: ShareCommand[] = [
  { cmd: 'model.new', name: 'beam' },
  { cmd: 'geometry.addBox', name: 'beam', size: ['1 m', '100 mm', '100 mm'] },
  { cmd: 'material.add', name: 'stål', E: '210 GPa', nu: 0.3 },
];

const BASE = 'https://andeplane.github.io/fem-lab/';

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
    const huge: ShareCommand[] = Array.from({ length: 40_000 }, (_, i) => ({
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
});
