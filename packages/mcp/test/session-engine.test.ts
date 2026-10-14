import { expect, it } from 'vitest';
import { MAX_MODEL_FILE_BYTES } from '@femlab/registry';
import { fileURLToPath } from 'node:url';
import { loadEngine } from '../src/engine';
import { createRegistry } from '../src/server';
const here = fileURLToPath(new URL('../src', import.meta.url));
const body = { cmd: 'geometry.addBox', name: 'shared', size: ['1 m', '1 m', '1 m'] };
const remove = { cmd: 'geometry.remove', name: 'shared' };

it('keeps the MCP Model and request lease after an oversized actual prepared ModelFile', async () => {
  const engine = loadEngine(here);
  const handle = await engine.acquire();
  try {
    await handle.dispatch({ cmd: 'model.new', name: 'old project' });
    await handle.dispatch(body);
    const before = await handle.modelFile();
    const command = { cmd: 'model.new', name: `☃🚀"\\${'x'.repeat(MAX_MODEL_FILE_BYTES / 2)}` };
    expect(Buffer.byteLength(JSON.stringify([command]))).toBeLessThan(MAX_MODEL_FILE_BYTES);
    await expect(handle.dispatch(command)).rejects.toMatchObject({ code: 'schema', where: 'file' });
    expect(await handle.modelFile()).toEqual(before);
    await handle.dispatch(remove);
    expect(await handle.query({ query: 'query.model' })).toMatchObject({ name: 'old project', bodies: [] });
  } finally { await handle.release?.(); }
});

it('fences retained MCP request handles and cancelled queued work with the checked owner', async () => {
  const engine = loadEngine(here);
  expect(engine).not.toHaveProperty('dispatch');
  const a = await engine.acquire!();
  await a.dispatch({ cmd: 'model.new', name: 'A' });
  await a.dispatch(body);
  const retained = await engine.acquire!();
  const b = await engine.acquire!();
  await b.dispatch({ cmd: 'model.new', name: 'B' });
  await b.dispatch(body);
  const before = await b.modelFile();
  await expect(retained.dispatch(remove)).rejects.toMatchObject({ code: 'session.expired' });
  await expect(retained.query({ query: 'query.model' })).rejects.toMatchObject({ code: 'session.expired' });
  expect(await b.modelFile()).toEqual(before);
  await expect(b.dispatch({ cmd: 'model.new', name: 42 })).rejects.toMatchObject({ code: 'schema' });
  expect(await b.modelFile()).toEqual(before);
  const cancelled = await engine.acquire!();
  const posted = cancelled.dispatch(remove);
  const rejected = expect(posted).rejects.toMatchObject({ code: 'cancelled' });
  await cancelled.release!(); await rejected;
  expect(await b.modelFile()).toEqual(before);
  await a.release!(); await retained.release!(); await b.release!();
});

it('keeps a nested MCP script on its initiating lease across model.new', async () => {
  const registry = createRegistry({ engine: loadEngine(here) });
  const result = await registry.dispatch({ cmd: 'script.run', code: 'await fem.model.new({name:"nested"}); await fem.geometry.addBox({name:"shared",size:["1 m","1 m","1 m"]});' }) as { error?: string };
  expect(result.error).toBeUndefined();
  expect(await registry.query({ query: 'query.model' })).toMatchObject({ name: 'nested', bodies: [{ name: 'shared' }] });
});


it('does not rebind admission queued behind another request’s replacement', async () => {
  const engine = loadEngine(here);
  const a = await engine.acquire();
  const replacing = a.dispatch({ cmd: 'model.new', name: 'next' });
  const waiting = expect(engine.acquire()).rejects.toMatchObject({ code: 'session.expired' });
  await replacing;
  await waiting;
  const next = await engine.acquire();
  expect(await next.query({ query: 'query.model' })).toMatchObject({ name: 'next' });
  await next.release(); await a.release();
});

it('publishes converted Commands as one checked Candidate and preserves the live Journal on failure', async () => {
  const engine = loadEngine(here);
  const initiating = await engine.acquire();
  await initiating.dispatch({ cmd: 'model.new', name: 'original' });
  await initiating.dispatch(body);
  const before = await initiating.modelFile();
  await expect(initiating.replaceCommands([
    { cmd: 'model.new', name: 'invalid import' },
    { cmd: 'geometry.addBox', name: 'bad', size: ['0 m', '1 m', '1 m'] },
  ])).rejects.toMatchObject({ code: 'schema' });
  expect(await initiating.modelFile()).toEqual(before);

  const delayedRead = await engine.acquire();
  await initiating.replaceCommands([{ cmd: 'model.new', name: 'imported' }, body]);
  await expect(delayedRead.replaceCommands([{ cmd: 'model.new', name: 'late import' }])).rejects.toMatchObject({ code: 'session.expired' });
  await initiating.dispatch({ ...body, name: 'follow-up' });
  expect(await initiating.query({ query: 'query.model' })).toMatchObject({ name: 'imported', bodies: [{ name: 'shared' }, { name: 'follow-up' }] });
  const imported = await initiating.modelFile();
  const cancelled = await engine.acquire();
  const posted = cancelled.replaceCommands([{ cmd: 'model.new', name: 'cancelled import' }]);
  const rejected = expect(posted).rejects.toMatchObject({ code: 'cancelled' });
  await cancelled.release(); await rejected;
  expect(await initiating.modelFile()).toEqual(imported);
  await delayedRead.release(); await initiating.release();
});

it('captures an import session before async I/O even when its own request replaces the project', async () => {
  const engine = loadEngine(here);
  const initiating = await engine.acquire();
  const late = initiating.captureImport();
  await initiating.dispatch({ cmd: 'model.new', name: 'newer project' });
  const before = await initiating.modelFile();
  await expect(late.query({ query: 'query.model' })).rejects.toMatchObject({ code: 'session.expired' });
  await expect(late.replaceCommands([{ cmd: 'model.new', name: 'late import' }])).rejects.toMatchObject({ code: 'session.expired' });
  expect(await initiating.modelFile()).toEqual(before);
  const current = initiating.captureImport();
  expect(await current.query({ query: 'query.model' })).toMatchObject({ name: 'newer project' });
  await current.replaceCommands([{ cmd: 'model.new', name: 'awaited import' }]);
  // Sequential new admissions see the producer's explicitly completed replacement.
  expect(await initiating.captureImport().query({ query: 'query.model' })).toMatchObject({ name: 'awaited import' });
  await initiating.release();
  expect(() => initiating.captureImport()).toThrow('this request has ended');
});

it('refuses a deferred file read after a concurrent model.new inside the same real MCP script', async () => {
  const engine = loadEngine(here);
  let releaseRead!: (bytes: Uint8Array) => void;
  const pendingRead = new Promise<Uint8Array>(resolve => { releaseRead = resolve; });
  const registry = createRegistry({
    engine: { acquire: async () => {
      const handle = await engine.acquire();
      return { ...handle, dispatch: async command => {
        const ack = await handle.dispatch(command);
        if (command['name'] === 'newer project') releaseRead(new TextEncoder().encode('*NODE'));
        return ack;
      } };
    } },
    abaqusIo: { read: async () => ({ name: 'late.inp', size: 5, read: () => pendingRead }), pick: async () => null, sha256: async () => 'a'.repeat(64) },
  });
  const result = await registry.dispatch({ cmd: 'script.run', code: 'const late = fem.file.importAbaqus({path:"late.inp",name:"late import",body:"bar",mode:"mesh",unitLength:"1 m"}); await fem.model.new({name:"newer project"}); await late;' }) as { error?: string };
  expect(result.error).toContain('this import belongs to a previous project');
  expect(await registry.query({ query: 'query.model' })).toMatchObject({ name: 'newer project', bodies: [] });
});
