import { render } from 'preact';
// The ⌘K palette is a view of the registry, so its filter is checked against the real registry:
// typing a Command's name has to put that Command first, or `⇥` fills in the wrong form.
import type { CommandDef, EngineSchema } from '@femlab/registry';
import { HOST_COMMANDS, Registry } from '@femlab/registry';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../registry/src/generated/engine.schema.json';
import { readHostCaps } from '../src/capabilities';
import { appHostCommands, makeHostContext } from '../src/host';
import { Store } from '../src/store';
import { Palette, objectRoute, fuzzy, rankCommands, requiredOf, score } from '../src/ui/Overlays';
import type { WorkerTransport } from '../src/worker-transport';

const transport = { dispatch: async () => undefined, query: async () => undefined } as unknown as WorkerTransport;
const registry = new Registry({
  schema: schema as unknown as EngineSchema,
  host: makeHostContext(new Store(), transport, { current: null }, readHostCaps({ navigator: { userAgent: 'Chrome/1' } })),
  hostCommands: [...HOST_COMMANDS, ...appHostCommands(new Store(), transport, { current: null }, async () => undefined)],
});
const commands: CommandDef[] = registry.list().commands;
const names = (query: string) => rankCommands(query, commands).map((c) => c.name);

describe('the command palette', () => {
  it('matches letters in order, and everything on an empty query', () => {
    expect(fuzzy('', 'anything')).toBe(true);
    expect(fuzzy('gab', 'geometry.addBox')).toBe(true);
    expect(fuzzy('xyz', 'geometry.addBox')).toBe(false);
    expect(fuzzy('add box', 'geometry.addBox')).toBe(true);
  });

  it('ranks an exact name first, then a name that contains the query, then the doc strings', () => {
    expect(score('load.pressure', { name: 'load.pressure', description: '' })).toBe(0);
    expect(score('pressure', { name: 'load.pressure', description: '' })).toBe(1);
    expect(score('lprs', { name: 'load.pressure', description: '' })).toBe(2);
    expect(score('a hole', { name: 'geometry.subtractBox', description: 'a hole, notch or opening' })).toBe(3);
    expect(score('ahole', { name: 'geometry.subtractBox', description: 'a hole, notch or opening' })).toBe(4);
    expect(score('zzz', { name: 'a', description: 'b' })).toBeNull();
  });

  it('puts the Command you typed at the top, not whatever the registry lists first', () => {
    expect(names('model.setUnits')[0]).toBe('model.setUnits');
    expect(names('load.pressure')[0]).toBe('load.pressure');
    expect(names('undo')[0]).toBe('journal.undo');
    expect(names('')).toEqual(commands.map((c) => c.name));
  });

  it('lists every registered Command, host and engine alike, with a doc string each', () => {
    expect(commands.length).toBeGreaterThan(60);
    expect(names('')).toContain('geometry.addBox');
    expect(names('')).toContain('view.fit');
    expect(names('')).toContain('form.open');
    for (const c of commands) expect(c.description.length, c.name).toBeGreaterThan(20);
  });

  it('knows which Commands ↵ can run outright and which need ⇥ first', () => {
    const by = (name: string) => requiredOf(commands.find((c) => c.name === name)!);
    expect(by('view.fit')).toEqual([]);
    expect(by('journal.undo')).toEqual([]);
    expect(by('geometry.addBox')).toEqual(['name', 'size']);
    expect(by('solve.run')).toEqual(['step']);
  });
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

it('routes only real model references and preserves exact-name Tab behavior', async () => {
  const store = new Store();
  store.set({ panels: { palette: true }, objects: [{ ref: 'set:bearing_top', kind: 'set', name: 'bearing_top', summary: 'real face' }] });
  const dispatch = vi.fn(async (_cmd: { cmd: string } & Record<string, unknown>) => undefined);
  const root = document.createElement('div');
  render(<Palette s={store.state} dispatch={dispatch} commands={commands} />, root);
  const input = root.querySelector('input')!;
  input.value = '@bearing';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await tick();
  expect(root.querySelector('.prow')!.textContent).toContain('@set:bearing_top');
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick();
  expect(dispatch).toHaveBeenCalledWith({ cmd: 'selection.set', sets: ['bearing_top'], mode: 'replace' });
  input.value = 'load.pressure';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await tick();
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  await tick();
  expect(dispatch).toHaveBeenCalledWith({ cmd: 'form.open', command: 'load.pressure' });
  input.value = 'view.fit';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await tick();
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick();
  expect(dispatch).toHaveBeenCalledWith({ cmd: 'view.fit' });
  render(null, root);
});

it('opens intent parameters for review and refuses a preview after a Model change', async () => {
  const store = new Store();
  store.set({
    panels: { palette: true },
    paletteIntent: {
      text: 'apply 2.4 MPa',
      status: 'ready',
      modelHash: null,
      clarification: 'Choose the target face before applying.',
      proposals: [{ command: 'load.pressure', args: { value: '2.4 MPa' }, missing: ['name', 'on'] }],
    },
  });
  const dispatch = vi.fn(async (_cmd: { cmd: string } & Record<string, unknown>) => undefined);
  const root = document.createElement('div');
  const show = () => render(<Palette s={store.state} dispatch={dispatch} commands={commands} />, root);
  show();
  const input = root.querySelector('input')!;
  input.value = 'apply 2.4 MPa';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await tick();
  expect(root.textContent).toContain('Choose the target');
  expect(root.querySelector('.prow')!.textContent).toContain('Fill in: name, on');
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick();
  expect(dispatch).toHaveBeenCalledWith({ cmd: 'form.open', command: 'load.pressure', args: { value: '2.4 MPa' } });
  expect(dispatch.mock.calls.some(([c]) => (c as { cmd?: string }).cmd === 'load.pressure')).toBe(false);
  store.set({ paletteIntent: { ...store.state.paletteIntent!, modelHash: 'old-model' } });
  show();
  await tick();
  expect(root.querySelector<HTMLButtonElement>('.prow')!.disabled).toBe(true);
  expect(root.textContent).toContain('Model changed');
  render(null, root);
});

it('routes a Journal object to its actual saved Command parameters', () => {
  const store = new Store();
  expect(objectRoute({ ref: 'set:cut.*', kind: 'set', name: 'cut', summary: 'face family' }, store.state)).toBeNull();
  store.set({
    journal: {
      hash: 'palette-fixture',
      entries: [{ seq: 1, hashAfter: 'h', cmd: { cmd: 'load.pressure', name: 'p', on: 'bearing_top', value: '2.4 MPa' } }],
      revision: 2,
      canUndo: true,
      canRedo: false,
    },
  });
  expect(objectRoute({ ref: 'journal:1', kind: 'journal', name: '1', summary: 'load.pressure' }, store.state)).toEqual({
    cmd: 'form.open',
    command: 'load.pressure',
    args: { name: 'p', on: 'bearing_top', value: '2.4 MPa' },
  });
});

it('routes current editable objects through form.edit without reconstructing historical definitions', () => {
  const store = new Store();
  for (const kind of ['material', 'constraint', 'load', 'step']) {
    expect(objectRoute({ ref: `${kind}:renamed`, kind, name: 'renamed', summary: 'current object' }, store.state)).toEqual({
      cmd: 'form.edit',
      kind,
      name: 'renamed',
    });
  }
});


it('closes the palette before opening an object form and consumes Enter', async () => {
  const store = new Store();
  store.set({ panels: { palette: true }, objects: [{ ref: 'load:tip', kind: 'load', name: 'tip', summary: 'tip load' }] });
  const dispatch = vi.fn(async (_cmd: { cmd: string } & Record<string, unknown>) => undefined);
  const root = document.createElement('div');
  render(<Palette s={store.state} dispatch={dispatch} commands={commands} />, root);
  const input = root.querySelector('input')!;
  input.value = '@tip';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await tick();
  const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  input.dispatchEvent(enter);
  await tick();
  expect(enter.defaultPrevented).toBe(true);
  expect(dispatch.mock.calls.map(([command]) => command)).toEqual([
    { cmd: 'panel.toggle', panel: 'palette', open: false },
    { cmd: 'form.edit', kind: 'load', name: 'tip' },
  ]);
  render(null, root);
});
