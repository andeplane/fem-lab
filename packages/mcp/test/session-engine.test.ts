import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadEngine } from '../src/engine';
import { createRegistry } from '../src/server';
const here = fileURLToPath(new URL('../src', import.meta.url));
const body = { cmd: 'geometry.addBox', name: 'shared', size: ['1 m', '1 m', '1 m'] };
const remove = { cmd: 'geometry.remove', name: 'shared' };

it('fences retained MCP request handles and cancelled queued work with the checked owner', async () => {
  const engine = loadEngine(here);
  expect(() => engine.dispatch(body)).toThrow('acquire a request lease');
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
