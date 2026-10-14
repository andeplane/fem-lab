import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOST_COMMANDS, Registry, type Command, type EngineSchema, type EngineTransport, type ModelSummary } from '@femlab/registry';
import schema from '../../registry/src/generated/engine.schema.json';
import { fakeTransport } from '../../registry/test/fakes';
import { appHostCommands, makeHostContext } from '../src/host';
import { readHostCaps } from '../src/capabilities';
import { Store } from '../src/store';
import { ModelTree, type HoverFrames } from '../src/ui/Tree';
import type { Dispatch } from '../src/ui/cmd';
import { afterEffects, waitFor } from './wait-for';

const definitions: Command[] = [
  { cmd: 'constraint.fix', name: 'cold', on: 'left.xmin' },
  { cmd: 'load.pressure', name: 'driven', on: 'right.xmax', value: '2 Pa' },
  { cmd: 'load.gravity', name: 'weight', g: ['0 m/s^2', '0 m/s^2', '-9.81 m/s^2'] },
  { cmd: 'load.heatSource', name: 'heater', bodies: ['right'], q: '2 W/m^3' },
  { cmd: 'load.temperature', name: 'expansion', bodies: ['left'], value: '20 degC' },
  { cmd: 'contact.thermal', name: 'conductance', of: 'weld', conductance: '2 W/(m^2 K)' },
];
const quantity = (value: number) => ({ value, unit: 'm' });
const model: ModelSummary = {
  name: 'targets', revision: 1, hash: 'model-hash', units: { length: 'm' }, idealisation: 'solid3d',
  bodies: ['left', 'right'].map(name => ({ name, bbox: [quantity(0), quantity(0), quantity(0), quantity(1), quantity(1), quantity(1)], measure: { value: 1, unit: 'm^3' }, faces: [`${name}.xmin`, `${name}.xmax`] })),
  materials: [], sets: [], constraints: [{ name: 'cold', on: 'left.xmin', summary: 'fixed' }],
  connections: [{ name: 'weld', kind: 'bonded', master: 'left.xmax', slave: 'right.xmin', summary: 'bonded' }],
  loads: definitions.filter(command => command.cmd.startsWith('load.') || command.cmd === 'contact.thermal').map(command => ({
    name: 'name' in command ? command.name : '', kind: command.cmd === 'contact.thermal' ? 'thermalContact' : command.cmd.slice(5), summary: 'no target names in this summary',
    ...('on' in command ? { on: command.on } : {}),
  })),
  steps: [], warnings: [],
};
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach(close => close()));

function frames() {
  let id = 0;
  const callbacks = new Map<number, () => void>();
  return {
    request: vi.fn((callback: () => void) => { callbacks.set(++id, callback); return id; }),
    cancel: vi.fn((handle: number) => { callbacks.delete(handle); }),
    flush: () => { const queued = [...callbacks.values()]; callbacks.clear(); queued.forEach(callback => callback()); },
  } satisfies HoverFrames & { flush(): void };
}

async function mount() {
  const store = new Store();
  store.set({ model, ready: true, journal: { hash: 'journal-hash', entries: [{ seq: 0, cmd: { cmd: 'model.new', name: model.name }, hashAfter: 'h' }], revision: 1, canUndo: true, canRedo: false } });
  const transport = fakeTransport();
  transport.query = vi.fn<EngineTransport['query']>(async query => {
    if (query.query !== 'query.definition') throw new Error(`unexpected ${query.query}`);
    const command = definitions.find(command => 'name' in command && command.name === query.name);
    if (!command) throw new Error(`unknown definition ${query.name}`);
    return { command };
  });
  const viewer = { current: null };
  const context = makeHostContext(store, transport, viewer, readHostCaps({ navigator: { userAgent: 'Chrome/140' } }));
  const registry = new Registry({ schema: schema as unknown as EngineSchema, host: context, hostCommands: [...HOST_COMMANDS, ...appHostCommands(store, transport, viewer, async () => undefined)] });
  const sent: Array<{ cmd: string } & Record<string, unknown>> = [];
  const running: Promise<unknown>[] = [];
  const dispatch: Dispatch = command => { sent.push(command); const result = registry.dispatch(command as never); running.push(result); return result; };
  const hoverFrames = frames();
  const root = document.createElement('div'); document.body.append(root);
  const draw = () => render(<ModelTree s={store.state} dispatch={dispatch} hoverFrames={hoverFrames} />, root);
  const unsubscribe = store.subscribe(draw); draw(); await afterEffects();
  const row = (name: string) => [...root.querySelectorAll<HTMLButtonElement>('.row-main')].find(button => button.querySelector('.name')?.textContent === name)!;
  const close = () => { unsubscribe(); render(null, root); root.remove(); };
  cleanups.push(close);
  return { store, context, registry, transport, sent, running, hoverFrames, root, row, close };
}

describe('Constraint and Load targets in the Model tree', () => {
  it.each([['cold', 'constraint', 'left.xmin'], ['driven', 'load', 'right.xmax']])('selects %s targets and opens its exact edit form without journalling', async (name, kind, target) => {
    const app = await mount();
    const before = app.store.state.journal;
    app.row(name!).click();
    await waitFor(() => app.store.state.form?.target?.name === name, 'target edit form');
    expect(app.sent.slice(0, 2)).toEqual([
      { cmd: 'selection.set', sets: [target] }, { cmd: 'form.edit', kind, name },
    ]);
    expect(app.store.state.selection.sets).toEqual([target]);
    expect(app.store.state.form?.values['on']).toBe(target);
    expect(app.store.state.journal).toBe(before);
    expect(app.transport.dispatch).not.toHaveBeenCalled();
  });

  it('coalesces hover to a frame, preserves selection on leave, and cancels queued hover on unmount', async () => {
    const app = await mount();
    await app.registry.dispatch({ cmd: 'selection.set', sets: ['left.xmin'] });
    const selected = app.store.state.selection;
    const cold = app.row('cold').parentElement!, hot = app.row('driven').parentElement!;
    cold.dispatchEvent(new MouseEvent('mouseenter'));
    cold.dispatchEvent(new MouseEvent('mouseleave'));
    hot.dispatchEvent(new MouseEvent('mouseenter'));
    expect(app.hoverFrames.request).toHaveBeenCalledTimes(1);
    app.hoverFrames.flush();
    await waitFor(() => app.store.state.hover.sets[0] === 'right.xmax', 'hover target');
    expect(app.sent).toEqual([{ cmd: 'view.hover', sets: ['right.xmax'] }]);
    hot.dispatchEvent(new MouseEvent('mouseleave')); app.hoverFrames.flush();
    await waitFor(() => app.store.state.hover.sets.length === 0, 'hover leave');
    expect(app.store.state.selection).toBe(selected);
    cold.dispatchEvent(new MouseEvent('mouseenter'));
    app.close(); app.hoverFrames.flush();
    expect(app.hoverFrames.cancel).toHaveBeenCalledOnce();
    expect(app.sent.at(-1)).toEqual({ cmd: 'view.hover' });
    expect(app.store.state.hover).toEqual({ bodies: [], faces: [], sets: [] });
    expect(app.transport.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ['weight', ['left', 'right'], []], ['heater', ['right'], []], ['expansion', ['left'], []],
    ['conductance', [], ['left.xmax', 'right.xmin']],
  ])('resolves %s from its current saved definition for hover and selection', async (name, bodies, sets) => {
    const app = await mount();
    app.row(name as string).parentElement!.dispatchEvent(new MouseEvent('mouseenter'));
    app.hoverFrames.flush();
    await waitFor(() => app.store.state.hover.bodies.length + app.store.state.hover.sets.length > 0, 'body load hover');
    expect(app.store.state.hover).toEqual({ bodies, faces: [], sets });
    expect(app.store.state.form).toBeNull();
    app.row(name as string).click();
    await waitFor(() => app.store.state.form?.target?.name === name, 'body load form');
    expect(app.store.state.selection.bodies).toEqual(bodies);
    expect(app.store.state.selection.sets).toEqual(sets);
    expect(app.transport.dispatch).not.toHaveBeenCalled();
  });

  it('rejects stale target replies after leaving, newer hover, or Model replacement', async () => {
    const app = await mount();
    const pending: Array<(reply: Awaited<ReturnType<EngineTransport['query']>>) => void> = [];
    app.transport.query = vi.fn<EngineTransport['query']>(() => new Promise(resolve => pending.push(resolve)));
    const delayed = app.context.view.hover({ load: 'heater' });
    await app.context.view.hover({ sets: ['left.xmin'] });
    pending.shift()!({ command: definitions[3]! }); await delayed;
    expect(app.store.state.hover.sets).toEqual(['left.xmin']);
    const afterLeave = app.context.view.hover({ load: 'heater' });
    await app.context.view.hover({});
    pending.shift()!({ command: definitions[3]! }); await afterLeave;
    expect(app.store.state.hover).toEqual({ bodies: [], faces: [], sets: [] });
    const replaced = app.context.view.hover({ load: 'heater' });
    app.store.set({ model: { ...model, hash: 'replacement', name: 'other' } });
    pending.shift()!({ command: definitions[3]! }); await replaced;
    expect(app.store.state.hover).toEqual({ bodies: [], faces: [], sets: [] });
  });

  it('does not reopen an older Load when its delayed selection finishes after a newer tree click', async () => {
    const app = await mount();
    let release: ((reply: Awaited<ReturnType<EngineTransport['query']>>) => void) | undefined;
    app.transport.query = vi.fn<EngineTransport['query']>(async query => {
      if (query.query !== 'query.definition') throw new Error(`unexpected ${query.query}`);
      if (query.name === 'heater') return new Promise(resolve => { release = resolve; });
      return { command: definitions[0]! };
    });
    app.row('heater').click();
    await waitFor(() => release, 'delayed Load selection');
    app.row('cold').click();
    await waitFor(() => app.store.state.form?.target?.name === 'cold', 'newer Constraint form');
    release!({ command: definitions[3]! });
    await Promise.all(app.running);
    expect(app.store.state.form?.target?.name).toBe('cold');
    expect(app.store.state.selection.sets).toEqual(['left.xmin']);
    expect(app.sent.filter(command => command.cmd === 'form.edit')).toEqual([{ cmd: 'form.edit', kind: 'constraint', name: 'cold' }]);
  });
});
