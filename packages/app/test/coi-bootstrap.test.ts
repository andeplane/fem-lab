import { describe, expect, it, vi } from 'vitest';
import { prepareIsolation, type IsolationHost, type IsolationWorker } from '../src/isolation-bootstrap';

function fixture() {
  let control: IsolationWorker['controller'] = null;
  let changed: (() => void) | undefined;
  let timeout: (() => void) | undefined;
  let registered!: (value: { unregister(): Promise<boolean> }) => void;
  let rejected!: (error: Error) => void;
  const registration = { unregister: vi.fn(async () => true) };
  const worker: IsolationWorker = {
    get controller() { return control; },
    register: vi.fn(() => new Promise<{ unregister(): Promise<boolean> }>((resolve, reject) => { registered = resolve; rejected = reject; })),
    addEventListener: vi.fn((_type, listener) => { changed = listener; }),
    removeEventListener: vi.fn(),
  };
  const clock = { setTimeout: vi.fn((callback: () => void) => { timeout = callback; return 17; }), clearTimeout: vi.fn() };
  const storage = { getItem: vi.fn(() => null as string | null), setItem: vi.fn() };
  const host: IsolationHost = {
    isolated: false, secure: true, worker, clock, script: '/fem-lab/coi-serviceworker.min.js',
    storage: () => storage, reload: vi.fn(),
  };
  return { host, worker, clock, registration, storage, register: () => registered(registration), reject: () => rejected(new Error('registration denied')),
    timeout: () => timeout!(), control: () => { control = { postMessage: vi.fn() }; changed!(); } };
}

describe('isolation before engine startup', () => {
  it('lets header-isolated, unavailable, insecure and reload-guarded hosts proceed without registration', async () => {
    for (const changes of [{ isolated: true }, { worker: undefined }, { secure: false }, { storage: () => ({ getItem: () => '1', setItem: vi.fn() }) }]) {
      const f = fixture(); await prepareIsolation({ ...f.host, ...changes });
      expect(f.worker.register).not.toHaveBeenCalled(); expect(f.clock.setTimeout).not.toHaveBeenCalled();
    }
  });
  it('waits through registration and control, reloads once, and never releases the old document engine', async () => {
    const f = fixture(); const engine = vi.fn(); void prepareIsolation(f.host).then(engine);
    expect(f.worker.register).toHaveBeenCalledWith('/fem-lab/coi-serviceworker.min.js');
    f.register(); await Promise.resolve(); expect(engine).not.toHaveBeenCalled(); expect(f.host.reload).not.toHaveBeenCalled();
    f.control(); f.control(); f.timeout(); await Promise.resolve();
    expect(f.storage.setItem).toHaveBeenCalledWith('coi-reset', '1'); expect(f.host.reload).toHaveBeenCalledOnce();
    expect(f.clock.clearTimeout).toHaveBeenCalledWith(17); expect(engine).not.toHaveBeenCalled();
  });
  it('reloads an already controlled unisolated document before any engine startup', async () => {
    const f = fixture(); const engine = vi.fn();
    Object.defineProperty(f.worker, 'controller', { value: { postMessage: vi.fn() } });
    void prepareIsolation(f.host).then(engine); await Promise.resolve();
    expect(f.host.reload).toHaveBeenCalledOnce(); expect(f.worker.register).not.toHaveBeenCalled(); expect(engine).not.toHaveBeenCalled();
  });
  it('preserves a successful registration whose control event arrives before its registration promise', async () => {
    const f = fixture(); const engine = vi.fn(); void prepareIsolation(f.host).then(engine);
    f.control(); f.register(); await Promise.resolve();
    expect(f.host.reload).toHaveBeenCalledOnce(); expect(f.registration.unregister).not.toHaveBeenCalled(); expect(engine).not.toHaveBeenCalled();
  });
  it('releases portable startup after registration rejection and ignores late control', async () => {
    const f = fixture(); const engine = vi.fn(); const ready = prepareIsolation(f.host).then(engine);
    f.reject(); await ready; f.control();
    expect(engine).toHaveBeenCalledOnce(); expect(f.host.reload).not.toHaveBeenCalled(); expect(f.worker.removeEventListener).toHaveBeenCalledOnce();
  });
  it('releases portable startup after a synchronous registration failure', async () => {
    const f = fixture();
    f.worker.register = () => { throw new DOMException('denied', 'SecurityError'); };
    await prepareIsolation(f.host);
    expect(f.clock.clearTimeout).toHaveBeenCalledWith(17); expect(f.host.reload).not.toHaveBeenCalled();
  });
  it('bounds a stalled registration, unregisters its late result and never reloads a running fallback', async () => {
    const f = fixture(); const engine = vi.fn(); const ready = prepareIsolation(f.host).then(engine);
    expect(f.clock.setTimeout).toHaveBeenCalledWith(expect.any(Function), 10_000);
    f.timeout(); await ready; f.register(); await Promise.resolve(); f.control();
    expect(engine).toHaveBeenCalledOnce(); expect(f.registration.unregister).toHaveBeenCalledOnce(); expect(f.host.reload).not.toHaveBeenCalled();
  });
  it('unregisters a registered worker that never claims the document before the deadline', async () => {
    const f = fixture(); const ready = prepareIsolation(f.host);
    f.register(); await Promise.resolve(); f.timeout(); await ready;
    expect(f.registration.unregister).toHaveBeenCalledOnce(); expect(f.host.reload).not.toHaveBeenCalled();
  });
  it('starts portable without registering when session storage acquisition or reading throws', async () => {
    for (const failure of ['acquire', 'read'] as const) {
      const f = fixture();
      if (failure === 'acquire') f.host.storage = () => { throw new DOMException('denied', 'SecurityError'); };
      else f.storage.getItem.mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
      await prepareIsolation(f.host);
      expect(f.worker.register).not.toHaveBeenCalled(); expect(f.host.reload).not.toHaveBeenCalled();
    }
  });
  it('releases portable startup without a reload when writing the reload guard fails', async () => {
    const f = fixture(); const engine = vi.fn(); const ready = prepareIsolation(f.host).then(engine);
    f.storage.setItem.mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    f.register(); await Promise.resolve(); f.control(); await ready; f.control();
    expect(engine).toHaveBeenCalledOnce(); expect(f.host.reload).not.toHaveBeenCalled();
    expect(f.registration.unregister).toHaveBeenCalledOnce(); expect(f.clock.clearTimeout).toHaveBeenCalledWith(17);
  });
});
