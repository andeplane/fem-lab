import { describe, expect, it, vi } from 'vitest';
import { ScriptValidator, type ValidationWorker, type ValidationClock } from '../src/script-validator-host';
import type { ScriptValidation } from '../src/script-validation-types';
const passed: ScriptValidation = { ok: true, diagnostics: [] };
function fixture() {
  let result!: (value: ScriptValidation) => void;
  let error!: (cause: string) => void;
  let timeout!: () => void;
  const worker: ValidationWorker = {
    postMessage: vi.fn(), onResult: (listener) => { result = listener; },
    onFailure: (listener) => { error = listener; }, terminate: vi.fn(),
  };
  const clock: ValidationClock = { setTimeout: vi.fn((fn) => { timeout = fn; return 'timer'; }), clearTimeout: vi.fn() };
  const spawn = vi.fn(() => worker);
  return { validator: new ScriptValidator(spawn, clock), spawn, worker, clock,
    reply: (value = passed) => result(value), fail: (cause: string) => error(cause), expire: () => timeout() };
}

describe('bounded validation worker host', () => {
  it('runs in its worker, settles once, terminates and permits the next request', async () => {
    const f = fixture();
    const run = f.validator.validate('code');
    expect(f.validator.running).toBe(true);
    expect(f.worker.postMessage).toHaveBeenCalledWith('code');
    expect(f.clock.setTimeout).toHaveBeenCalledWith(expect.any(Function), 10_000);
    f.reply();
    f.fail('late error');
    await expect(run).resolves.toEqual(passed);
    expect(f.validator.running).toBe(false);
    expect(f.worker.terminate).toHaveBeenCalledTimes(1);
    expect(f.clock.clearTimeout).toHaveBeenCalledWith('timer');
    const again = f.validator.validate('next');
    f.reply();
    await expect(again).resolves.toEqual(passed);
  });
  it('refuses overlap without disturbing the active request', async () => {
    const f = fixture();
    const run = f.validator.validate('first');
    expect((await f.validator.validate('second')).diagnostics[0]?.code).toBe('script.busy');
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.worker.terminate).not.toHaveBeenCalled();
    f.reply(); await run;
  });
  it('terminates an expired request and ignores late replies', async () => {
    const f = fixture(); const run = f.validator.validate('loop', 50);
    f.expire(); f.reply();
    expect((await run).diagnostics[0]?.code).toBe('script.timeout');
    expect(f.worker.terminate).toHaveBeenCalledTimes(1);
  });
  it('cancels validation explicitly and allows an idle stop', async () => {
    const f = fixture(); f.validator.stop();
    const run = f.validator.validate('code'); f.validator.stop(); f.validator.stop();
    expect((await run).diagnostics[0]?.code).toBe('script.stopped');
    expect(f.worker.terminate).toHaveBeenCalledTimes(1);
  });
  it('reports worker startup, posting and runtime failures', async () => {
    const f = fixture();
    f.spawn.mockImplementationOnce(() => { throw new Error('startup'); });
    expect((await f.validator.validate('code')).diagnostics[0]?.cause).toContain('startup');
    vi.mocked(f.worker.postMessage).mockImplementationOnce(() => { throw new Error('posting'); });
    expect((await f.validator.validate('code')).diagnostics[0]?.cause).toContain('posting');
    const run = f.validator.validate('code'); f.fail('runtime');
    expect((await run).diagnostics[0]?.cause).toBe('runtime');
    expect(f.validator.running).toBe(false);
  });
  it.each([0, -1, Infinity, NaN, 30_001])('rejects invalid deadline %s before starting a worker', async (timeout) => {
    const f = fixture();
    expect((await f.validator.validate('', timeout)).diagnostics[0]?.code).toBe('script.limit');
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it('rejects oversized input before allocating a worker', async () => {
    const f = fixture();
    expect((await f.validator.validate('x'.repeat(64_001))).diagnostics[0]?.code).toBe('script.limit');
    expect(f.spawn).not.toHaveBeenCalled();
  });
});
