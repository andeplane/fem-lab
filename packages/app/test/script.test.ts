import { describe, expect, it, vi } from 'vitest';
import {
  SCRIPT_MAX_MESSAGES,
  SCRIPT_MESSAGE_BYTES,
  SCRIPT_SOURCE_CHARACTERS,
  SCRIPT_TIMEOUT_MS,
  ScriptHost,
} from '../src/script-host';
import { describe as describeError, runScript, type ScriptCall, type ScriptDone, type ScriptRequest } from '../src/script.worker';

/** A Worker that records startup and speaks the real JSON MessagePort protocol. */
class FakeWorker implements Partial<Worker> {
  static last: FakeWorker | null = null;
  onmessage: Worker['onmessage'] = null;
  onerror: Worker['onerror'] = null;
  posted: ScriptRequest[] = [];
  terminated = 0;
  port: MessagePort | null = null;

  constructor() {
    FakeWorker.last = this;
  }
  postMessage(message: ScriptRequest): void {
    this.posted.push(message);
    this.port = message.port;
  }
  terminate(): void {
    this.terminated++;
  }
  emit(message: unknown): void {
    this.port!.postMessage(typeof message === 'string' ? message : JSON.stringify(message));
  }
  call(kind: 'dispatch' | 'query', value: Record<string, unknown>, id = 1): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.port!.onmessage = (event: MessageEvent<string>) => {
        const reply = JSON.parse(event.data) as { value?: unknown; error?: string };
        if (reply.error === undefined) resolve(reply.value);
        else reject(new Error(reply.error));
      };
      this.emit({ kind, id, value } satisfies ScriptCall);
    });
  }
  finish(done: ScriptDone): void {
    for (const value of done.console) this.emit({ kind: 'log', value });
    this.emit(done.error === undefined
      ? { kind: 'done', value: done.result ?? null }
      : { kind: 'failed', value: { message: done.error } });
  }
}

const host = (dispatch = vi.fn(async () => 'ack'), query = vi.fn(async () => ({ bodies: [] }))) => ({
  scripts: new ScriptHost(() => new FakeWorker() as unknown as Worker, dispatch, query),
  dispatch,
  query,
});

describe('ScriptHost', () => {
  it('hands the Worker code and a channel, then returns bounded output', async () => {
    const { scripts } = host();
    const run = scripts.run('fem.view.fit()');
    expect(scripts.running).toBe(true);
    expect(FakeWorker.last!.posted[0]!.code).toBe('fem.view.fit()');
    FakeWorker.last!.finish({ result: 3, console: ['hello'] });
    await expect(run).resolves.toEqual({ result: 3, console: ['hello'] });
    expect(FakeWorker.last!.terminated).toBe(1);
    expect(scripts.running).toBe(false);
  });

  it('routes Commands and Queries through the Registry and returns failures', async () => {
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

  it('reports only acknowledged engine Commands from this script', async () => {
    const command = { cmd: 'geometry.addBox', name: 'script-body', size: ['1 m', '1 m', '1 m'] };
    const dispatch = vi.fn(async () => ({ seq: 3, revision: 4, hash: 'script-hash' }));
    const { scripts } = host(dispatch as never);
    const run = scripts.run('build()');
    const worker = FakeWorker.last!;
    await worker.call('dispatch', command);
    await worker.call('query', { query: 'query.model' });
    await worker.call('dispatch', { cmd: 'journal.undo' });
    worker.finish({ result: null, console: [] });
    await expect(run).resolves.toMatchObject({ journalEntries: [{ seq: 3, hashAfter: 'script-hash', cmd: command }] });
  });

  it('preserves structured failures and refuses recursive script execution', async () => {
    const boom = vi.fn(async () => {
      throw Object.assign(new Error('nope'), { code: 'not-found', cause: 'no such Set' });
    });
    const { scripts } = host(boom as never);
    const run = scripts.run('x');
    const worker = FakeWorker.last!;
    await expect(worker.call('dispatch', { cmd: 'x' })).rejects.toThrow('not-found: no such Set');
    await expect(worker.call('dispatch', { cmd: 'script.run', code: 'return 1' }, 2)).rejects.toThrow('nested script.run');
    worker.finish({ console: [] });
    await run;
  });

  it('maps a guest failure stack back to the authored source line', async () => {
    const { scripts } = host();
    const run = scripts.run('first();\nthrow new Error("bang");');
    FakeWorker.last!.emit({ kind: 'failed', value: { message: 'bang', stack: 'at script.js:3:7' } });
    await expect(run).resolves.toMatchObject({ error: 'bang (line 2)' });
  });

  it('refuses a second script and stops the active Worker', async () => {
    const { scripts } = host();
    const run = scripts.run('x');
    expect(() => scripts.run('y')).toThrow(/already running/);
    scripts.stop();
    await expect(run).resolves.toMatchObject({ error: 'stopped' });
    expect(scripts.running).toBe(false);
    expect(() => scripts.stop()).not.toThrow();
  });

  it('enforces source and deadline bounds before launching', async () => {
    const spawn = vi.fn(() => new FakeWorker() as unknown as Worker);
    const scripts = new ScriptHost(spawn, async () => null, async () => null);
    await expect(scripts.run('x'.repeat(SCRIPT_SOURCE_CHARACTERS + 1))).resolves.toMatchObject({ error: expect.stringContaining('exceeds') });
    for (const timeout of [0, -1, NaN, Infinity, SCRIPT_TIMEOUT_MS + 1]) {
      await expect(scripts.run('', timeout)).resolves.toMatchObject({ error: expect.stringContaining('timeout must') });
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it('kills an infinite run at its deadline and closes the RPC gate first', async () => {
    vi.useFakeTimers();
    const dispatch = vi.fn(async () => null);
    const scripts = new ScriptHost(() => new FakeWorker() as unknown as Worker, dispatch, async () => null);
    const run = scripts.run('while (true) {}', 50);
    const worker = FakeWorker.last!;
    await vi.advanceTimersByTimeAsync(60);
    vi.useRealTimers();
    await expect(run).resolves.toMatchObject({ error: 'the script did not finish within 50 ms' });
    worker.emit({ kind: 'dispatch', id: 2, value: { cmd: 'model.new' } });
    await Promise.resolve();
    expect(dispatch).not.toHaveBeenCalled();
    expect(worker.terminated).toBe(1);
  });

  it('bounds raw messages, message count, console output and RPC replies', async () => {
    let run = host().scripts.run('x');
    FakeWorker.last!.emit('x'.repeat(SCRIPT_MESSAGE_BYTES + 1));
    await expect(run).resolves.toMatchObject({ error: expect.stringContaining('message limit') });

    run = host().scripts.run('x');
    FakeWorker.last!.emit({ kind: 'log', value: '💥'.repeat(300_000) });
    await expect(run).resolves.toMatchObject({ error: expect.stringContaining('message limit') });

    run = host().scripts.run('x');
    for (let i = 0; i <= SCRIPT_MAX_MESSAGES; i++) FakeWorker.last!.emit({ kind: 'log', value: '' });
    await expect(run).resolves.toMatchObject({ error: expect.stringContaining('message limit') });

    run = host().scripts.run('x');
    for (let i = 0; i < 3; i++) FakeWorker.last!.emit({ kind: 'log', value: '💥'.repeat(100_000) });
    await expect(run).resolves.toMatchObject({ error: expect.stringContaining('console limit') });

    const hugeQuery = vi.fn(async () => '💥'.repeat(300_000));
    const huge = new ScriptHost(() => new FakeWorker() as unknown as Worker, async () => null, hugeQuery);
    run = huge.run('x');
    await expect(FakeWorker.last!.call('query', { query: 'query.model' })).rejects.toThrow('RPC reply exceeds');
    FakeWorker.last!.finish({ console: [] });
    await run;

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const nonJson = new ScriptHost(() => new FakeWorker() as unknown as Worker, async () => null, async () => cyclic);
    run = nonJson.run('x');
    await expect(FakeWorker.last!.call('query', { query: 'query.model' })).rejects.toThrow('RPC reply is not JSON');
    FakeWorker.last!.finish({ console: [] });
    await run;
  });

  it('rejects malformed runtime messages and reports startup and Worker errors', async () => {
    let run = host().scripts.run('x');
    FakeWorker.last!.emit('not json');
    await expect(run).resolves.toMatchObject({ error: 'invalid script runtime message' });

    const failed = new ScriptHost(() => { throw new Error('launch failed'); }, async () => null, async () => null);
    await expect(failed.run('x')).resolves.toMatchObject({ error: 'launch failed' });

    run = host().scripts.run('x');
    (FakeWorker.last!.onerror as ((event: ErrorEvent) => void))({ message: 'boom' } as ErrorEvent);
    await expect(run).resolves.toMatchObject({ error: 'the script Worker failed: boom' });
  });
});

describe('the QuickJS Worker half', () => {
  const run = async (code: string, handle: (call: ScriptCall) => unknown = () => 'ack'): Promise<ScriptDone> => {
    const { port1, port2 } = new MessageChannel();
    const lines: string[] = [];
    let resolveDone!: (done: ScriptDone) => void;
    const done = new Promise<ScriptDone>((resolve) => { resolveDone = resolve; });
    port1.onmessage = (event: MessageEvent<string>) => {
      const message = JSON.parse(event.data) as { kind: string; id?: number; value?: unknown };
      if (message.kind === 'log') lines.push(message.value as string);
      else if (message.kind === 'done') resolveDone({ result: message.value, console: lines });
      else if (message.kind === 'failed') resolveDone({ console: lines, error: describeError(message.value) });
      else if (message.kind === 'timer') setTimeout(() => port1.postMessage(JSON.stringify({ id: message.id, timer: true })), Number(message.value));
      else {
        try {
          port1.postMessage(JSON.stringify({ id: message.id, value: handle(message as ScriptCall) }));
        } catch (error) {
          port1.postMessage(JSON.stringify({ id: message.id, error: describeError(error) }));
        }
      }
    };
    const context = await runScript(code, port2);
    const outcome = await done;
    context?.dispose();
    return outcome;
  };

  it('strips TypeScript, captures console and returns plain data', async () => {
    const done = await run('const n: number = 2;\nconsole.log("n is", n);\nreturn { n: n * 3 };');
    expect(done).toEqual({ result: { n: 6 }, console: ['n is 2'] });
    expect((await run('return () => 1;')).result).toContain('=>');
  });

  it('gives the guest a typed fem proxy whose calls cross the JSON port', async () => {
    const seen: ScriptCall[] = [];
    const done = await run('await fem.model.new({ name: "x" });\nreturn await fem.query.model();', (call) => (seen.push(call), call.kind === 'query' ? { bodies: 1 } : 'ack'));
    expect(seen.map((call) => call.value)).toEqual([{ cmd: 'model.new', name: 'x' }, { query: 'query.model' }]);
    expect(done.result).toEqual({ bodies: 1 });
  });

  it('runs timers and reports source lines and host reply errors', async () => {
    expect((await run('await new Promise(resolve => setTimeout(resolve, 1)); return 4;')).result).toBe(4);
    expect((await run('const = ;')).error).toMatch(/Unexpected token|error/i);
    const thrown = await run('console.log("before");\nthrow new Error("bang");');
    expect(thrown.console).toEqual(['before']);
    expect(thrown.error).toContain('bang');
    expect(thrown.error).toContain('line 2');
    expect((await run('await fem.view.fit()', () => { throw Object.assign(new Error('gone'), { code: 'not-found', cause: 'gone' }); })).error).toContain('not-found: gone');
  });

  it('rejects non-JSON host replies', async () => {
    const { port1, port2 } = new MessageChannel();
    const failure = new Promise<string>((resolve) => {
      port1.onmessage = (event: MessageEvent<string>) => {
        const message = JSON.parse(event.data) as { kind: string; value: { message: string } };
        if (message.kind === 'query') port1.postMessage({ not: 'json' });
        else if (message.kind === 'failed') resolve(message.value.message);
      };
    });
    const context = await runScript('await fem.query.model()', port2);
    await expect(failure).resolves.toContain('invalid script host message');
    context?.dispose();

    const done = await run('return await fem.view.fit()', (call) => call.id);
    expect(done.result).toBe(1);
  });

  it('describes plain and structured errors without inventing source lines', () => {
    expect(describeError({ message: 'plain' })).toBe('plain');
    expect(describeError('a string')).toBe('a string');
    expect(describeError({ code: 'schema', cause: 'bad', stack: 'at script.js:1:1' })).toBe('schema: bad');
  });
});
