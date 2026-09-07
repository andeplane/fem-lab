import { expect, it } from 'vitest';
import { z } from 'zod';
import { Registry, type EngineSchema, type HostDef } from '../src/registry';
import schema from '../src/generated/engine.schema.json';
import { fakeHost, fakeTransport } from './fakes';

it('refuses a host handler that reaches beyond its declared engine capability', async () => {
  const transport = fakeTransport();
  const definition = (execution: HostDef['execution'], run: HostDef['run']): HostDef => ({ name: 'probe', execution, run, description: 'test handler', schema: z.object({}), tool: false });
  const registry = (def: HostDef) => new Registry({ schema: schema as unknown as EngineSchema, host: fakeHost(transport), hostCommands: [def] });
  for (const policy of ['workspace', 'producer', 'modelRead', 'sessionView', 'replacement', 'control'] as const) {
    const r = registry(definition(policy, (_, ctx) => ctx.transport.dispatch({ cmd: 'model.setName', name: 'unexpected' })));
    await expect(r.dispatch({ cmd: 'probe' })).rejects.toMatchObject({ code: 'schema', where: 'execution' });
  }
  const reset = registry(definition('modelWrite', (_, ctx) => ctx.transport.dispatch({ cmd: 'model.new', name: 'unexpected' })));
  await expect(reset.dispatch({ cmd: 'probe' })).rejects.toMatchObject({ code: 'schema', where: 'execution' });
  expect(transport.dispatch).not.toHaveBeenCalled();
  const edit = registry(definition('modelWrite', (_, ctx) => ctx.transport.dispatch({ cmd: 'model.setName', name: 'allowed' })));
  await edit.dispatch({ cmd: 'probe' });
  expect(transport.dispatch).toHaveBeenCalledWith({ cmd: 'model.setName', name: 'allowed' }, undefined);
  const read = registry(definition('modelRead', (_, ctx) => ctx.transport.query({ query: 'query.model' })));
  await read.dispatch({ cmd: 'probe' });
  expect(transport.query).toHaveBeenCalledWith({ query: 'query.model' });
});
