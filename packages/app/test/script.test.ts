// The script Worker of plan B §7.5, from both ends: the main-thread half against a fake Worker
// (so the protocol is checked without a browser), and the Worker half against a real
// MessageChannel (so sucrase, the `fem` proxy and the console capture are really exercised).
import { describe, expect, it, vi } from 'vitest';
import { ScriptHost } from '../src/script-host';
import { describe as describeError, runScript, type ScriptCall, type ScriptDone, type ScriptRequest } from '../src/script.worker';

/** A Worker that records what it was posted and replies when the test tells it to. */
class FakeWorker implements Partial<Worker> {
  static last: FakeWorker | null = null;
  onmessage: ((e: MessageEvent<ScriptDone>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  posted: ScriptRequest[] = [];
  terminated = 0;
  port: MessagePort | null = null;

  constructor() {
    FakeWorker.last = this;
  }
  postMessage(m: ScriptRequest): void {
    this.posted.push(m);
    this.port = m.port;
  }
  terminate(): void {
    this.terminated++;
  }
  /** Stand in for the Worker's `fem` proxy: one call over the port, then the result. */
  call(kind: 'dispatch' | 'query', payload: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.port!.onmessage = (e: MessageEvent<{ ok: boolean; value?: unknown; error?: { cause: string } }>) => (e.data.ok ? resolve(e.data.value) : reject(new Error(e.data.error!.cause)));
      this.port!.postMessage({ id: 1, kind, payload } satisfies ScriptCall);
    });
  }
  finish(done: ScriptDone): void {
    this.onmessage?.({ data: done } as MessageEvent<ScriptDone>);
  }
}

const host = (dispatch = vi.fn(async () => 'ack'), query = vi.fn(async () => ({ bodies: [] }))) => ({
  scripts: new ScriptHost(() => new FakeWorker() as unknown as Worker, dispatch, query),
  dispatch,
  query,
});

describe('ScriptHost', () => {
  it('hands the Worker the code and one end of a channel, and returns what it posts back', async () => {
    const { scripts } = host();
    const run = scripts.run('fem.view.fit()');
    expect(scripts.running).toBe(true);
    expect(FakeWorker.last!.posted[0]!.code).toBe('fem.view.fit()');
    FakeWorker.last!.finish({ result: 3, console: ['hello'] });
    await expect(run).resolves.toEqual({ result: 3, console: ['hello'] });
    expect(FakeWorker.last!.terminated).toBe(1);
    expect(scripts.running).toBe(false);
  });

  it('routes the script\'s Commands and Queries through the Registry, and its failures back', async () => {
    const { scripts, dispatch, query } = host();
    const run = scripts.run('x');
    const worker = FakeWorker.last!;
    await expect(worker.call('dispatch', { cmd: 'view.fit' })).resolves.toBe('ack');
    expect(dispatch).toHaveBeenCalledWith({ cmd: 'view.fit' });
    await expect(worker.call('query', { query: 'query.model' })).resolves.toEqual({ bodies: [] });
    expect(query).toHaveBeenCalledOnce();
    worker.finish({ console: [] });
    await run;
  });

  it('sends a structured failure back over the port rather than hanging the script', async () => {
    const boom = vi.fn(async () => {
      throw Object.assign(new Error('nope'), { code: 'not-found', cause: 'no such Set' });
    });
    const { scripts } = host(boom as never);
    const run = scripts.run('x');
    const worker = FakeWorker.last!;
    await expect(worker.call('dispatch', { cmd: 'x' })).rejects.toThrow('no such Set');
    // A plain JS error still crosses as `internal`.
    const plain = host(vi.fn(async () => {
      throw new Error('plain');
    }) as never);
    const run2 = plain.scripts.run('y');
    await expect(FakeWorker.last!.call('dispatch', { cmd: 'x' })).rejects.toThrow('plain');
    FakeWorker.last!.finish({ console: [] });
    await run2;
    worker.finish({ console: [] });
    await run;
  });

  it('refuses a second script while one is running, and stops the one that is', async () => {
    const { scripts } = host();
    const run = scripts.run('x');
    expect(() => scripts.run('y')).toThrow(/already running/);
    scripts.stop();
    await expect(run).resolves.toMatchObject({ error: 'stopped' });
    expect(scripts.running).toBe(false);
    // Stopping when nothing runs is a no-op, not a crash.
    expect(() => scripts.stop()).not.toThrow();
  });

  it('gives up after the timeout and kills the Worker', async () => {
    vi.useFakeTimers();
    const { scripts } = host();
    const run = scripts.run('while (true) {}', 50);
    vi.advanceTimersByTime(60);
    await expect(run).resolves.toMatchObject({ error: 'the script did not finish within 50 ms' });
    vi.useRealTimers();
  });

  it('turns a Worker that fails to load into a message, not an unhandled error', async () => {
    const { scripts } = host();
    const run = scripts.run('x');
    FakeWorker.last!.onerror!({ message: 'boom' } as ErrorEvent);
    await expect(run).resolves.toMatchObject({ error: 'the script Worker failed: boom' });
  });
});

describe('the Worker half', () => {
  const run = (code: string, handle: (c: ScriptCall) => unknown = () => 'ack'): Promise<ScriptDone> => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = (e: MessageEvent<ScriptCall>) => port1.postMessage({ id: e.data.id, ok: true, value: handle(e.data) });
    return new Promise((resolve) => runScript(code, port2, resolve));
  };

  it('strips the TypeScript, runs the code and captures its console and result', async () => {
    const done = await run('const n: number = 2;\nconsole.log("n is", n);\nreturn n * 3;');
    expect(done).toEqual({ result: 6, console: ['n is 2'] });
  });

  it('gives the script a `fem` whose every call crosses the port', async () => {
    const seen: ScriptCall[] = [];
    const done = await run('await fem.model.new({ name: "x" });\nreturn (await fem.query.model()) as unknown;', (c) => (seen.push(c), c.kind === 'query' ? { bodies: 1 } : 'ack'));
    expect(seen.map((c) => c.payload)).toEqual([{ cmd: 'model.new', name: 'x' }, { query: 'query.model' }]);
    expect(done.result).toEqual({ bodies: 1 });
  });

  it('reports a syntax error and a thrown error with the line the person wrote', async () => {
    expect((await run('const = ;')).error).toMatch(/Unexpected token|error/i);
    const thrown = await run('console.log("before");\nthrow new Error("bang");');
    expect(thrown.console).toEqual(['before']);
    expect(thrown.error).toContain('bang');
    expect(thrown.error).toContain('line 2');
  });

  it('answers a reply for a call that is no longer waiting by ignoring it', async () => {
    const { port1, port2 } = new MessageChannel();
    const done = await new Promise<ScriptDone>((resolve) => {
      port1.onmessage = () => {
        port1.postMessage({ id: 99, ok: true, value: 1 });
        port1.postMessage({ id: 1, ok: false, error: { code: 'not-found', cause: 'gone' } });
      };
      runScript('await fem.view.fit();', port2, resolve);
    });
    expect(done.error).toContain('gone');
  });

  it('returns something structuredClone cannot carry as its text', async () => {
    expect((await run('return () => 1;')).result).toContain('=>');
  });

  it('describes an error without a usable stack as just its message', () => {
    expect(describeError({ message: 'plain' })).toBe('plain');
    expect(describeError('a string')).toBe('a string');
    expect(describeError({ code: 'schema', cause: 'bad', stack: 'at <anonymous>:1:1' })).toBe('schema: bad');
  });
});
