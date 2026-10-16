import { describe, expect, it, vi } from 'vitest';
import { BrowserEngine, type EngineRuntime } from '../src/browser-engine';

function fixture(canThread: boolean) {
  const events: string[] = [];
  let finish!: () => void;
  const pool = new Promise<void>(resolve => { finish = resolve; });
  const module = {
    default: vi.fn(async ({ module_or_path }: { module_or_path: string }) => { events.push(module_or_path); }),
    SessionEngine: { create: vi.fn(async () => { events.push('session'); return 'session'; }) },
    PreparedEngine: { create: vi.fn(async () => { events.push('candidate'); return 'candidate'; }) },
  };
  const runtime: EngineRuntime<string, string> = { module, wasmUrl: 'serial.wasm' };
  const initThreadPool = vi.fn(async () => { events.push('pool'); await pool; });
  const host = {
    canThread,
    portable: vi.fn(async () => runtime),
    threaded: vi.fn(async () => ({ module, wasmUrl: 'atomics.wasm', initThreadPool })),
  };
  return { engine: new BrowserEngine(host), host, module, events, finish, initThreadPool };
}
const options = { gpu: false, threads: 4 };

describe('browser engine initialization', () => {
  it('awaits the actual pool before constructing sessions or replacement candidates, once', async () => {
    const f = fixture(true);
    const session = f.engine.create(options, 'epoch');
    const candidate = f.engine.candidate('ticket', options);
    await vi.waitFor(() => expect(f.events).toEqual(['atomics.wasm', 'pool']));
    expect(f.module.SessionEngine.create).not.toHaveBeenCalled();
    expect(f.module.PreparedEngine.create).not.toHaveBeenCalled();
    f.finish();
    expect(await session).toBe('session');
    expect(await candidate).toBe('candidate');
    expect(f.initThreadPool).toHaveBeenCalledExactlyOnceWith(4);
    expect(f.host.portable).not.toHaveBeenCalled();
    expect(f.module.default).toHaveBeenCalledOnce();
    expect(f.module.SessionEngine.create).toHaveBeenCalledWith(options, 'epoch');
    expect(f.module.PreparedEngine.create).toHaveBeenCalledWith('ticket', options);
  });
  it('selects the portable runtime without touching shared-memory workers when unavailable', async () => {
    const f = fixture(false);
    expect(await f.engine.create(options, 'epoch')).toBe('session');
    expect(f.events).toEqual(['serial.wasm', 'session']);
    expect(f.host.threaded).not.toHaveBeenCalled();
    expect(f.initThreadPool).not.toHaveBeenCalled();
  });
  it('rejects a changed thread count without silently reusing a different pool', async () => {
    const f = fixture(false);
    await f.engine.create(options, 'epoch');
    await expect(f.engine.candidate('ticket', { ...options, threads: 2 })).rejects.toMatchObject({ code: 'schema', where: 'threads' });
    expect(f.module.PreparedEngine.create).not.toHaveBeenCalled();
  });
  it('retains initialization failures and never constructs an engine on a broken pool', async () => {
    const f = fixture(true);
    f.initThreadPool.mockRejectedValue(new Error('worker failed'));
    await expect(f.engine.create(options, 'epoch')).rejects.toThrow('worker failed');
    await expect(f.engine.candidate('ticket', options)).rejects.toThrow('worker failed');
    expect(f.host.threaded).toHaveBeenCalledOnce();
    expect(f.module.SessionEngine.create).not.toHaveBeenCalled();
    expect(f.module.PreparedEngine.create).not.toHaveBeenCalled();
  });
  it('rejects an incomplete threaded artifact instead of claiming requested threads', async () => {
    const f = fixture(true);
    const engine = new BrowserEngine({ ...f.host, threaded: async () => ({ module: f.module, wasmUrl: 'broken.wasm' }) });
    await expect(engine.create(options, 'epoch')).rejects.toMatchObject({ code: 'internal' });
    expect(f.module.SessionEngine.create).not.toHaveBeenCalled();
  });
});
