import { batchModule } from '../../../tools/checked-batch.mjs';
// The real tree -> host Command -> engine Query -> Properties -> Apply path. The independent
// fixture lists public input variants; exact saved Model equality catches omitted/rounded data.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_COMMANDS, Registry, type EngineSchema, type JsonSchema, type ModelSummary } from '@femlab/registry';
import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import cases from '../../../tools/fixtures/editable-definitions.json';
import schema from '../../registry/src/generated/engine.schema.json';
import { appHostCommands, makeHostContext } from '../src/host';
import { readHostCaps } from '../src/capabilities';
import { Store } from '../src/store';
import { ModelTree } from '../src/ui/Tree';
import { SchemaForm } from '../src/ui/SchemaForm';
import type { Defs } from '../src/ui/schema';
import type { EngineTransport as WorkerTransport } from '@femlab/registry';
import { waitFor } from './wait-for';

const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const wasm = batchModule(createRequire(import.meta.url)(path.join(rootPath, 'tools/wasm-node/femlab_engine_wasm.js'))) as {
  Engine: new (threads: number) => { dispatch(c: string): Promise<string>; query(q: string): string; export_file(): string; free(): void };
};
const doc = schema as unknown as EngineSchema;
const defs: Defs = { ...doc.commands.$defs, ...doc.queries.$defs };
const variants = new Map<string, JsonSchema>(doc.commands.oneOf.map(v => [v.properties['cmd']!.const!, v as unknown as JsonSchema]));
const roots: HTMLElement[] = [];
afterEach(() => { for (const root of roots.splice(0)) { render(null, root); root.remove(); } });

async function mount(input: Record<string, unknown>) {
  const engine = new wasm.Engine(1);
  for (const command of [
    { cmd: 'geometry.addBox', name: 'base', size: ['1 m', '1 m', '1 m'] },
    { cmd: 'geometry.addMass', name: 'ref', at: ['2 m', '0 m', '0 m'], mass: '1 kg' },
    { cmd: 'step.add', name: 'prior', procedure: 'heat-steady', constraints: [], loads: [] }, input,
  ]) await engine.dispatch(JSON.stringify(command));
  const transport = {
    dispatch: async (c: unknown) => JSON.parse(await engine.dispatch(JSON.stringify(c))),
    query: async (q: unknown) => JSON.parse(engine.query(JSON.stringify(q))),
  } as unknown as WorkerTransport;
  const store = new Store();
  store.set({ ready: true, model: await transport.query({ query: 'query.model' }) as ModelSummary });
  const viewer = { current: null };
  const registry = new Registry({ schema: doc, host: makeHostContext(store, transport, viewer, readHostCaps({ navigator: { userAgent: 'Chrome/140' } })), hostCommands: [...HOST_COMMANDS, ...appHostCommands(store, transport, viewer, async () => undefined)] });
  const sent: Record<string, unknown>[] = [];
  let last: Promise<unknown> = Promise.resolve();
  const dispatch = (c: { cmd: string } & Record<string, unknown>) => {
    sent.push(c); last = registry.dispatch(c as never); return last;
  };
  const query = (q: { query: string } & Record<string, unknown>) => registry.query(q as never);
  const root = document.createElement('div'); roots.push(root); document.body.append(root);
  const draw = () => render(<><ModelTree s={store.state} dispatch={dispatch} /><SchemaForm s={store.state} store={store} dispatch={dispatch} query={query} defs={defs} variants={variants} /></>, root);
  const unsubscribe = store.subscribe(draw); draw();
  const row = [...root.querySelectorAll<HTMLButtonElement>('.row-main')].find(el => el.querySelector('.name')?.textContent === 'editable')!;
  expect(row).toBeDefined(); row.click(); await last;
  await waitFor(() => store.state.form?.values['name'] === 'editable' ? true : null, 'lossless editable form');
  return { root, store, engine, sent, done: () => last, close: () => { unsubscribe(); render(null, root); engine.free(); } };
}

describe('editing Model tree objects', () => {
  it.each(cases.map((c, i) => [i, c] as const))('preserves every Model field for fixture %i', async (_i, c) => {
    const app = await mount(c.command);
    try {
      const before = JSON.parse(app.engine.export_file()).model;
      expect(app.sent[0]).toEqual({ cmd: 'form.edit', kind: c.kind, name: 'editable' });
      expect(app.store.state.form!.cmd).toBe(c.command.cmd);
      app.root.querySelector<HTMLButtonElement>('.apply')!.click(); await app.done();
      expect(JSON.parse(app.engine.export_file()).model).toEqual(before);
    } finally { app.close(); }
  });

  it('displays structured quantities as exact unit text and edits them through Apply', async () => {
    const app = await mount({ cmd: 'material.add', name: 'editable', E: '210.123456789 GPa', nu: 0.3, alpha: '1.23456789e-5 1/K', source: 'keep this' });
    try {
      const field = app.root.querySelector<HTMLElement>('[data-field="E"]')!;
      const input = field.querySelector<HTMLInputElement>('input')!;
      expect(input.value).toBe('210123456789 Pa');
      input.value = '199.876543219 GPa'; input.dispatchEvent(new Event('input', { bubbles: true })); await app.done();
      app.root.querySelector<HTMLButtonElement>('.apply')!.click(); await app.done();
      const material = JSON.parse(app.engine.export_file()).model.materials[0];
      expect(material.e).toBe(199876543219); expect(material.alpha).toBe(1.23456789e-5); expect(material.source).toBe('keep this');
      // Reopen the current structured definition, then use the real stepper.
      app.root.querySelector<HTMLButtonElement>('.row-main[title="form.edit — editable"]')!.click(); await app.done();
      app.root.querySelector<HTMLButtonElement>('[data-field="E"] button[title="+10 %"]')!.click(); await app.done();
      expect(app.store.state.form!.values['E']).toBe('219864000000 Pa');
      app.root.querySelector<HTMLButtonElement>('.apply')!.click(); await app.done();
      expect(JSON.parse(app.engine.export_file()).model.materials[0].e).toBe(219864000000);
    } finally { app.close(); }
  });
});

it('ignores a delayed edit definition after another form or edit request takes over', async () => {
  const store = new Store();
  const pending: Array<(value: unknown) => void> = [];
  const transport = { query: () => new Promise(resolve => pending.push(resolve)) } as unknown as WorkerTransport;
  const commands = appHostCommands(store, transport, { current: null }, async () => undefined);
  const edit = commands.find(c => c.name === 'form.edit')!;
  const first = edit.run({ kind: 'material', name: 'old' }, undefined as never);
  store.openForm('geometry.addBox', { name: 'new' });
  pending.shift()!({ command: { cmd: 'material.add', name: 'old' } }); await first;
  expect(store.state.form!.values['name']).toBe('new');
  const second = edit.run({ kind: 'material', name: 'second' }, undefined as never);
  const third = edit.run({ kind: 'material', name: 'third' }, undefined as never);
  pending.shift()!({ command: { cmd: 'material.add', name: 'second' } }); await second;
  expect(store.state.form!.values['name']).toBe('new');
  pending.shift()!({ command: { cmd: 'material.add', name: 'third' } }); await third;
  expect(store.state.form!.values['name']).toBe('third');
  const fourth = edit.run({ kind: 'material', name: 'fourth' }, undefined as never);
  store.set({ revision: store.state.revision + 1 });
  pending.shift()!({ command: { cmd: 'material.add', name: 'fourth' } }); await fourth;
  expect(store.state.form!.values['name']).toBe('third');
});
