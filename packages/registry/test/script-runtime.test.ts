import { describe, expect, it } from 'vitest';
import { createScriptContext, SCRIPT_MESSAGE_BYTES } from '../src/script-runtime';

const nextMessage = (sent: string[], index: number) => JSON.parse(sent[index]!) as { kind: string; id?: number; value?: unknown };

describe('portable QuickJS script runtime', () => {
  it('bridges fem calls, timers and plain results through JSON only', async () => {
    const sent: string[] = [];
    const context = await createScriptContext(
      'await new Promise(resolve => setTimeout(resolve, 1)); return await fem.query.model();',
      (text) => sent.push(text),
    );
    expect(nextMessage(sent, 0)).toMatchObject({ kind: 'timer', id: 1, value: 1 });
    context.receive(JSON.stringify({ id: 99, value: 'not pending' }));
    context.receive(JSON.stringify({ id: 1, timer: true }));
    expect(nextMessage(sent, 1)).toMatchObject({ kind: 'query', id: 2, value: { query: 'query.model' } });
    context.receive(JSON.stringify({ id: 2, value: { name: 'beam' } }));
    expect(nextMessage(sent, 2)).toEqual({ kind: 'done', value: { name: 'beam' } });
    context.dispose();
  });

  it('does not expose host I/O, modules or the temporary bridge', async () => {
    const sent: string[] = [];
    const context = await createScriptContext(`
      const names = ['process', 'require', 'fetch', 'XMLHttpRequest', 'WebSocket', 'Worker', '__send'];
      let modules = false;
      try { await import('node:fs'); } catch { modules = true; }
      return { absent: names.every(name => typeof globalThis[name] === 'undefined'), modules, escape: Function('return typeof process')() };
    `, (text) => sent.push(text));
    expect(nextMessage(sent, 0)).toEqual({ kind: 'done', value: { absent: true, modules: true, escape: 'undefined' } });
    context.dispose();
  });

  it('enforces the heap and individual output-message limits and remains reusable', async () => {
    const outOfMemory: string[] = [];
    const memory = await createScriptContext('return "x".repeat(100 * 1024 * 1024)', (text) => outOfMemory.push(text));
    expect((nextMessage(outOfMemory, 0).value as { message: string }).message).toContain('out of memory');
    memory.dispose();

    const tooLarge: string[] = [];
    const output = await createScriptContext("console.log('💥'.repeat(300000))", (text) => tooLarge.push(text));
    expect((nextMessage(tooLarge, 0).value as { message: string }).message).toContain('message exceeds');
    output.dispose();

    const healthy: string[] = [];
    const context = await createScriptContext('return 42', (text) => healthy.push(text));
    expect(nextMessage(healthy, 0)).toEqual({ kind: 'done', value: 42 });
    context.dispose();
  });

  it('disposes a context when bootstrap or TypeScript compilation fails', async () => {
    await expect(createScriptContext('const = ;', () => undefined)).rejects.toThrow('Unexpected token');
  });
});
