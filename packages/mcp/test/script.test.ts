import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';
import { createScriptContext, SCRIPT_MESSAGE_BYTES } from '../src/script-context';
import { runScript, describe as describeError, type ScriptDeps } from '../src/script';

const nothing = () => Promise.resolve(null);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it('keeps the MCP registry responsive during infinite loops, in a disposable process', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fem-script-test-'));
  try {
    const outfile = path.join(dir, 'server.mjs');
    await build({ entryPoints: ['test/fixtures/script-server.ts'], outfile, bundle: true, platform: 'node', format: 'esm' });
    const { stdout } = await promisify(execFile)(process.execPath, [outfile, path.resolve('dist/script-worker.js')], { timeout: 10_000 });
    expect(JSON.parse(stdout)).toEqual({ responsive: true, timedOut: true, after: 'still alive' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('does not admit a delayed Command after timeout or after successful completion', async () => {
  const dispatch = vi.fn(nothing);
  const query = vi.fn(async () => { await delay(1500); return {}; });
  const result = await runScript('await fem.query.model(); await fem.model.new({ name: "late" });', dispatch, query, 1000);
  expect(result.error).toContain('did not finish');
  expect(query).toHaveBeenCalledOnce();
  await delay(1600);
  expect(dispatch).not.toHaveBeenCalled();
  expect(await runScript('setTimeout(() => fem.model.new({ name: "late" }), 50); return 1;', dispatch, nothing)).toMatchObject({ result: 1 });
  await delay(100);
  expect(dispatch).not.toHaveBeenCalled();
});

it('runs timers, cancellation, queries and errors without exposing native I/O', async () => {
  const out = await runScript(`
    const id = setTimeout(() => { throw new Error('cancelled'); }, 1);
    clearTimeout(id);
    await new Promise(r => setTimeout(r, 10));
    const globals = ['process', 'require', 'fetch', 'WebSocket', 'Worker', '__send'];
    const absent = globals.every(key => typeof globalThis[key] === 'undefined');
    let modules = false;
    try { await import('node:fs'); } catch { modules = true; }
    return { absent, modules, escape: Function('return typeof process')(), value: await fem.query.model() };
  `, nothing, async () => ({ name: 'test' }));
  expect(out).toEqual({ console: [], result: { absent: true, modules: true, escape: 'undefined', value: { name: 'test' } } });
  expect((await runScript('await fem.script.run({ code: "return 1" });', nothing, nothing)).error).toContain('nested script.run');
  expect((await runScript('\nthrow new Error("line");', nothing, nothing)).error).toContain('line 2');
  expect((await runScript('setTimeout(() => { throw new Error("timer failed") }, 1); await new Promise(() => {});', nothing, nothing)).error).toContain('timer failed');
});

it('bounds guest memory, output and messages and remains usable afterwards', async () => {
  expect((await runScript('return "x".repeat(100 * 1024 * 1024)', nothing, nothing)).error).toContain('out of memory');
  expect((await runScript('console.log("x".repeat(1024 * 1024))', nothing, nothing)).error).toContain('message exceeds');
  expect((await runScript('for (let i = 0; i < 20; i++) console.log("x".repeat(100000));', nothing, nothing)).error).toContain('console limit');
  expect(await runScript('return 42', nothing, nothing)).toEqual({ console: [], result: 42 });
});

it('adapts real QuickJS messages and disposes failed contexts', async () => {
  const sent: string[] = [];
  const context = await createScriptContext('return await fem.query.model()', (text) => sent.push(text));
  expect(JSON.parse(sent[0]!)).toEqual({ kind: 'query', id: 1, value: { query: 'query.model' } });
  context.receive(JSON.stringify({ id: 1, value: { name: 'beam' } }));
  expect(JSON.parse(sent[1]!)).toEqual({ kind: 'done', value: { name: 'beam' } });
  context.dispose();
  await expect(createScriptContext('const = ;', nothing)).rejects.toThrow('Unexpected token');
  const huge = await createScriptContext(`console.log('x'.repeat(${SCRIPT_MESSAGE_BYTES}))`, (text) => sent.push(text));
  expect(JSON.parse(sent.at(-1)!).value.message).toContain('message exceeds');
  huge.dispose();
});

function fakeRuntime() {
  const events = new EventEmitter();
  const sent: unknown[] = [];
  const terminate = vi.fn(async () => 0);
  let now = 0;
  const timers: (() => void)[] = [];
  const deps: ScriptDeps = {
    launch: () => Object.assign(events, { postMessage: (v: unknown) => { sent.push(v); }, terminate }),
    now: () => now,
    later: (fn) => { timers.push(fn); return timers.length as unknown as ReturnType<typeof setTimeout>; },
    cancel: vi.fn(),
  };
  return { deps, events, sent, terminate, timers, advance: () => { now = 31_000; }, emit: (v: unknown) => events.emit('message', JSON.stringify(v)) };
}

describe('runtime lifecycle and the hostile message boundary', () => {
  it.each([0, -1, NaN, Infinity, 30_001])('refuses an invalid deadline %s', async (timeout) => {
    expect((await runScript('', nothing, nothing, timeout)).error).toContain('timeout must');
  });
  it.each(['not json', 'null', '{"kind":"dispatch","id":1,"value":null}', '{"kind":"timer","id":1,"value":"x"}'])('rejects malformed worker output %s', async (text) => {
    const fake = fakeRuntime();
    const result = runScript('', nothing, nothing, undefined, fake.deps);
    fake.events.emit('message', text);
    expect((await result).error).toBe('invalid script runtime message');
  });
  it.each([{}, 'x'.repeat(1024 * 1024 + 1)])('bounds raw worker messages', async (text) => {
    const fake = fakeRuntime();
    const result = runScript('', nothing, nothing, undefined, fake.deps);
    fake.events.emit('message', text);
    expect((await result).error).toContain('message limit');
  });
  it('bounds message count', async () => {
    const fake = fakeRuntime();
    const result = runScript('', nothing, nothing, undefined, fake.deps);
    for (let n = 0; n < 10_001; n++) fake.emit({ kind: 'log', value: '' });
    expect((await result).error).toContain('message limit');
  });
  it('closes the gate before termination and ignores late success, error, exit and replies', async () => {
    const fake = fakeRuntime();
    const dispatch = vi.fn(nothing);
    let reject!: (e: unknown) => void;
    const result = runScript('', dispatch, () => new Promise((_, fail) => { reject = fail; }), undefined, fake.deps);
    fake.emit({ kind: 'query', id: 1, value: { query: 'query.model' } });
    fake.emit({ kind: 'timer', id: 2, value: 20 });
    fake.advance();
    fake.emit({ kind: 'dispatch', id: 3, value: { cmd: 'model.new' } });
    fake.emit({ kind: 'done', value: 1 });
    fake.events.emit('error', new Error('late'));
    fake.events.emit('exit', 1);
    fake.timers[1]!();
    reject(new Error('late query'));
    expect((await result).error).toContain('did not finish');
    expect(dispatch).not.toHaveBeenCalled();
    expect(fake.sent).toEqual([]);
    expect(fake.terminate).toHaveBeenCalledTimes(1);
  });
  it('reports launch, worker, exit and termination failures', async () => {
    const fake = fakeRuntime();
    expect((await runScript('', nothing, nothing, undefined, { ...fake.deps, launch: () => { throw new Error('launch'); } })).error).toBe('launch');
    for (const event of ['error', 'exit']) {
      const run = runScript('', nothing, nothing, undefined, fake.deps);
      fake.events.emit(event, event === 'error' ? new Error('worker') : 2);
      expect((await run).error).toContain(event === 'error' ? 'worker' : 'exited (2)');
    }
    const broken = fakeRuntime();
    broken.terminate.mockRejectedValue(new Error('cannot terminate'));
    const run = runScript('', nothing, nothing, undefined, broken.deps);
    broken.emit({ kind: 'done', value: null });
    expect((await run).error).toContain('termination failed: cannot terminate');
    expect(describeError(null)).toBe('null');
    expect(describeError({ message: 'x', stack: 'at script.js:1' })).toBe('x');
  });
});
