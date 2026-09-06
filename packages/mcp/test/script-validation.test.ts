import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { nodeScriptValidator } from '../src/script-validation';

class FakeWorker extends EventEmitter {
  postMessage = vi.fn();
  terminate = vi.fn(async () => 0);
}

describe('Node validation worker adapter', () => {
  it('forwards code/results and terminates the worker after completion', async () => {
    const worker = new FakeWorker();
    const validator = nodeScriptValidator(() => worker);
    const pending = validator.validate('return 1;');
    expect(worker.postMessage).toHaveBeenCalledWith('return 1;');
    worker.emit('message', { ok: true, diagnostics: [] });
    expect(await pending).toEqual({ ok: true, diagnostics: [] });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('reports errors and unexpected nonzero exits; ignores normal exits', async () => {
    const worker = new FakeWorker();
    const validator = nodeScriptValidator(() => worker);
    const first = validator.validate('x');
    worker.emit('error', new Error('broken'));
    expect((await first).diagnostics[0]?.cause).toBe('broken');
    const second = validator.validate('x');
    worker.emit('exit', 0);
    expect(validator.running).toBe(true);
    worker.emit('exit', 2);
    expect((await second).diagnostics[0]?.cause).toContain('code 2');
  });
});
