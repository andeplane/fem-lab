import { expect, it } from 'vitest';
import { MAX_MODEL_FILE_BYTES, type ReadRequest } from '@femlab/registry';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadEngine } from '../src/engine';
import { sessionEngine } from '../src/session-engine';
import { createRegistry } from '../src/server';
const here = fileURLToPath(new URL('../src', import.meta.url));
const body = { cmd: 'geometry.addBox', name: 'shared', size: ['1 m', '1 m', '1 m'] };
const remove = { cmd: 'geometry.remove', name: 'shared' };

it('rejects a checked endpoint returning a Journal for the document read without changing the Model', async () => {
  const wasm = createRequire(import.meta.url)('../../../tools/wasm-node/femlab_engine_wasm.js') as typeof import('../../app/src/generated/wasm/femlab_engine_wasm');
  let misrouted = false;
  class MisroutedOwner extends wasm.SessionEngine {
    override query(json: string): string {
      const request = JSON.parse(json) as ReadRequest;
      if (misrouted && request.query.query === 'query.document') request.query = { query: 'query.journal' };
      return super.query(JSON.stringify(request));
    }
  }
  const engine = sessionEngine({ SessionEngine: MisroutedOwner, PreparedEngine: wasm.PreparedEngine }, 1, 'misrouted-document');
  const handle = await engine.acquire();
  try {
    await handle.dispatch({ cmd: 'model.new', name: 'preserved document' });
    await handle.dispatch(body);
    const before = await handle.modelFile();
    const journal = await handle.query({ query: 'query.journal' });
    misrouted = true;
    await expect(handle.modelFile()).rejects.toMatchObject({ code: 'internal', cause: 'query.document did not return a Model file' });
    expect(await handle.query({ query: 'query.journal' })).toEqual(journal);
    misrouted = false;
    expect(await handle.modelFile()).toEqual(before);
  } finally { await handle.release(); }
});

it('reads the authoritative SI file under unreadable display units and fences its old request after replacement', async () => {
  const engine = loadEngine(here);
  const handle = await engine.acquire();
  const commands = JSON.parse(readFileSync(new URL('../../../crates/engine/tests/fixtures/document-display-overflow.json', import.meta.url), 'utf8')) as Record<string, unknown>[];
  let replacement: Awaited<ReturnType<typeof engine.acquire>> | undefined;
  try {
    for (const command of commands) await handle.dispatch(command);
    const file = await handle.modelFile();
    expect(file).toMatchObject({ model: { units: { length: 'mm', force: 'mN' }, loads: expect.arrayContaining([
      expect.objectContaining({ name: 'plus', total: [1e307, 0, 0] }), expect.objectContaining({ name: 'minus', total: [-1e307, 0, 0] }),
    ]) } });
    const document = await handle.query({ query: 'query.document' });
    expect(document).toMatchObject({ file, revision: commands.length, hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const retained = await handle.query({ query: 'query.results' });
    await expect(handle.query({ query: 'query.model' })).rejects.toMatchObject({ code: 'unit.display' });
    expect(await handle.modelFile()).toEqual(file);
    expect(await handle.query({ query: 'query.document' })).toEqual(document);
    expect(await handle.query({ query: 'query.results' })).toEqual(retained);
    replacement = await engine.acquire();
    await replacement.dispatch({ cmd: 'model.new', name: 'new project' });
    const current = await replacement.modelFile();
    await expect(handle.modelFile()).rejects.toMatchObject({ code: 'session.expired' });
    expect(await replacement.modelFile()).toEqual(current);
  } finally { await replacement?.release(); await handle.release(); }
});

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
