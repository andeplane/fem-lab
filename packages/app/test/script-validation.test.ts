import { describe, expect, it, vi } from 'vitest';
import { browserScriptValidator } from '../src/script-validation-host';
import { ScriptHost } from '../src/script-host';
import { makeHostContext } from '../src/host';
import { Store } from '../src/store';
import { readHostCaps } from '../src/capabilities';
import { Registry, type EngineSchema } from '@femlab/registry';
import schema from '../../registry/src/generated/engine.schema.json';
import type { WorkerTransport } from '../src/worker-transport';

class FakeWorker extends EventTarget implements Worker {
  onmessageerror: Worker['onmessageerror'] = null;
  onmessage: Worker['onmessage'] = null;
  onerror: Worker['onerror'] = null;
  postMessage = vi.fn();
  terminate = vi.fn();
}

describe('browser script validation', () => {
  it('returns worker diagnostics without starting execution or touching the engine', async () => {
    const worker = new FakeWorker();
    const validator = browserScriptValidator(() => worker);
    const execution = vi.fn(() => new FakeWorker());
    const dispatch = vi.fn(async () => null);
    const query = vi.fn(async () => null);
    const scripts = new ScriptHost(execution, dispatch, query, validator);
    const transport = { dispatch, query } as unknown as WorkerTransport;
    const host = makeHostContext(new Store(), transport, { current: null }, readHostCaps({}), scripts);
    const registry = new Registry({ schema: schema as unknown as EngineSchema, host });
    const run = registry.dispatch({ cmd: 'script.run', code: 'await fem.geometry.notReal({});' });
    expect(scripts.running).toBe(true);
    const invalid = { ok: false, diagnostics: [{ code: 'TS2339', cause: 'unknown API', where: { line: 1, column: 20 }, hint: 'fix the call' }] };
    worker.onmessage?.call(worker, { data: invalid } as MessageEvent);
    await expect(run).resolves.toMatchObject({ error: expect.stringContaining('script.validation'), diagnostics: invalid.diagnostics });
    expect(execution).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('rejects overlapping execution before changing the active script UI state', async () => {
    const worker = new FakeWorker();
    const scripts = new ScriptHost(() => worker, async () => null, async () => null);
    const store = new Store();
    const host = makeHostContext(store, {} as WorkerTransport, { current: null }, readHostCaps({}), scripts);
    const first = host.script.run('return 1;');
    expect(store.state.scriptRunning).toBe(true);
    await expect(host.script.run('return 2;')).rejects.toMatchObject({ code: 'unsupported' });
    expect(store.state.scriptRunning).toBe(true);
    expect(store.state.source).toBe('ai');
    scripts.stop(); await first;
    expect(store.state.scriptRunning).toBe(false);
  });

  it('reports native worker errors and script.stop cancels active validation', async () => {
    const worker = new FakeWorker();
    const validator = browserScriptValidator(() => worker);
    const first = validator.validate('x');
    worker.onerror?.call(worker, { message: 'broken' } as ErrorEvent);
    expect((await first).diagnostics[0]?.cause).toBe('broken');
    const scripts = new ScriptHost(() => worker, async () => null, async () => null, validator);
    const second = scripts.validate('x'); scripts.stop();
    expect((await second).diagnostics[0]?.code).toBe('script.stopped');
    expect(scripts.running).toBe(false);
  });
});
