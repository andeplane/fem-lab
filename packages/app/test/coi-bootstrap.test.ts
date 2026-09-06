// Exercise the exact classic script shipped before coi-serviceworker. Reading and evaluating it
// keeps this fake lifecycle test tied to the GitHub Pages bootstrap rather than a second copy.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

interface FakeServiceWorker {
  controller: object | null;
  ready: Promise<unknown>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}

type MakeReload = (serviceWorker: FakeServiceWorker | null, storage: Pick<Storage, 'getItem' | 'setItem'>, reload: () => void) => () => void;

const source = readFileSync(resolve('public/coi-bootstrap.js'), 'utf8');
const make = new Function('window', 'navigator', 'sessionStorage', 'location', `${source}; return createControlledReload;`) as (
  window: Record<string, unknown>,
  navigator: { serviceWorker: null },
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  location: { reload(): void },
) => MakeReload;

const storage = (initial: string | null = null) => {
  let value = initial;
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, next: string) => {
      value = next;
    }),
  };
};

describe('COI bootstrap', () => {
  it('waits through ready for controllerchange, then guards exactly one controlled reload', async () => {
    let resolveReady!: () => void;
    let changed: (() => void) | null = null;
    const worker: FakeServiceWorker = {
      controller: null,
      ready: new Promise((resolve) => {
        resolveReady = () => resolve(undefined);
      }),
      addEventListener: vi.fn((_name: string, listener: () => void) => {
        changed = listener;
      }),
      removeEventListener: vi.fn(),
    };
    const saved = storage();
    const reload = vi.fn();
    const run = make({}, { serviceWorker: null }, saved, { reload })!(worker, saved, reload);

    run();
    run();
    expect(worker.addEventListener).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    resolveReady();
    await Promise.resolve();
    expect(reload).not.toHaveBeenCalled();

    worker.controller = {};
    changed!();
    expect(saved.setItem).toHaveBeenCalledWith('coi-reset', '1');
    expect(reload).toHaveBeenCalledOnce();
    run();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('reloads an already controlled page immediately and ignores absent or guarded workers', () => {
    const worker: FakeServiceWorker = { controller: {}, ready: Promise.resolve(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const saved = storage();
    const reload = vi.fn();
    const factory = make({}, { serviceWorker: null }, saved, { reload });
    factory(worker, saved, reload)();
    expect(reload).toHaveBeenCalledOnce();
    expect(worker.removeEventListener).toHaveBeenCalledOnce();

    factory(null, storage(), reload)();
    factory(worker, storage('1'), reload)();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('can retry after service-worker readiness rejects', async () => {
    let changed: (() => void) | null = null;
    const worker: FakeServiceWorker = {
      controller: null,
      ready: Promise.reject(new Error('registration failed')),
      addEventListener: vi.fn((_name: string, listener: () => void) => {
        changed = listener;
      }),
      removeEventListener: vi.fn(),
    };
    const saved = storage();
    const reload = vi.fn();
    const run = make({}, { serviceWorker: null }, saved, { reload })(worker, saved, reload);
    run();
    await Promise.resolve();
    expect(worker.removeEventListener).toHaveBeenCalledOnce();
    worker.ready = Promise.resolve();
    worker.controller = {};
    run();
    changed!();
    expect(reload).toHaveBeenCalledOnce();
  });
});
