// ADR 0003, made enforceable: render the whole shell against a fake engine and check that
// every clickable names a Command the registry actually has. A control with a typo, or one
// wired to nothing, fails here rather than in front of a person.
import { HOST_COMMANDS, Registry, type EngineSchema, type ModelSummary } from '@femlab/registry';
import { h, render } from 'preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../registry/src/generated/engine.schema.json';
import { appHostCommands, makeHostContext } from '../src/host';
import { readHostCaps } from '../src/capabilities';
import { Store, visibilityReducer } from '../src/store';
import { App } from '../src/ui/App';
import type { WorkerTransport } from '../src/worker-transport';
import { afterEffects, waitFor, waitForGone } from './wait-for';

// `test/setup.ts` stands the drawer's chunk in with a component that renders nothing. Issue #40
// is about *where* that chunk is mounted, so this file swaps in a marker element it can find.
vi.mock('../src/ai', () => ({
  AssistantPanel: () => h('aside', { class: 'assistant' }),
  chatBridge: { send: () => undefined, insertMention: () => undefined, clear: () => undefined },
}));

const model = (): ModelSummary =>
  ({
    name: 'demo',
    revision: 3,
    hash: 'h',
    units: { length: 'mm', force: 'N', stress: 'MPa' },
    idealisation: 'solid',
    bodies: [{ name: 'beam', material: 'steel', bbox: [], measure: { value: 0.01, unit: 'm^3' }, faces: ['beam.top', 'beam.xmin'] }],
    materials: [{ name: 'steel', E: { value: 210, unit: 'GPa' }, nu: 0.3, rho: null, assignedTo: ['beam'] }],
    sets: [],
    constraints: [{ name: 'fix', on: 'beam.xmin', summary: 'fixed' }],
    loads: [{ name: 'p', kind: 'pressure', on: 'beam.top', summary: '2.4 MPa' }],
    steps: [{ name: 'static', procedure: 'static', constraints: ['fix'], loads: ['p'], solved: false }],
    meshSettings: null,
    warnings: [{ code: 'W-1200', text: 'no mesh settings yet', where: null }],
  }) as unknown as ModelSummary;

const transport = { dispatch: async () => undefined, query: async () => undefined } as unknown as WorkerTransport;

const withSteps = (names: string[]): ModelSummary => ({
  ...model(),
  steps: names.map((name) => ({ name, procedure: 'static', constraints: ['fix'], loads: ['p'], solved: false })),
} as unknown as ModelSummary);

function dragEvent(type: string, transfer: DataTransfer, clientY = 0): DragEvent {
  const event = new DragEvent(type, { bubbles: true, cancelable: true, clientY });
  // happy-dom does not implement DragEventInit.dataTransfer yet.
  Object.defineProperties(event, { dataTransfer: { value: transfer }, clientY: { value: clientY } });
  return event;
}

/**
 * The whole shell with every panel showing at once: the tree, the generated Properties form,
 * each bottom tab and the ⌘K palette. If any of them names a Command the registry does not
 * have, the first test below fails.
 */
function mount(patch: Partial<Parameters<Store['set']>[0]> = {}): { root: HTMLElement; registry: Registry; store: Store; commands: ({ cmd: string } & Record<string, unknown>)[] } {
  const store = new Store();
  const commands: ({ cmd: string } & Record<string, unknown>)[] = [];
  const viewer = { current: null };
  const host = readHostCaps({ navigator: { userAgent: 'Chrome/140.0.0.0', hardwareConcurrency: 8, gpu: {} }, crossOriginIsolated: true });
  const registry = new Registry({
    schema: schema as unknown as EngineSchema,
    host: makeHostContext(store, transport, viewer, host),
    hostCommands: [...HOST_COMMANDS, ...appHostCommands(store, transport, viewer, async () => undefined)],
  });
  store.set({ ready: true, model: model(), revision: 3, hostCaps: host, script: 'fem.model.new({ name: "demo" })', journal: { entries: [{ seq: 0, cmd: { cmd: 'model.new', name: 'demo' }, hashAfter: 'h' }], revision: 1, canUndo: true, canRedo: false } as never, ...patch });
  store.openForm('load.pressure', { name: 'p', on: 'beam.top', value: '2.4 MPa' });
  const root = document.createElement('div');
  document.body.append(root);
  const dispatch = async (cmd: { cmd: string } & Record<string, unknown>): Promise<void> => {
    commands.push(cmd);
    if (cmd.cmd === 'panel.toggle') store.togglePanel(String(cmd['panel']), cmd['open'] as boolean | undefined);
    if (cmd.cmd === 'view.setVisible') store.set({ hiddenBodies: visibilityReducer(store.state.hiddenBodies, cmd['bodies'] as string[], Boolean(cmd['on'])) });
  };
  render(<App store={store} dispatch={dispatch} viewer={viewer} commands={registry.list().commands} query={async () => ({ value: 1, unit: 'Pa' })} registry={registry} />, root);
  return { root, registry, store, commands };
}

describe('the shell', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('names only Commands the registry has on every clickable, in every panel', () => {
    const seen = new Set<string>();
    for (const tab of ['journal', 'script', 'results', 'checks', 'console'] as const) {
      document.body.innerHTML = '';
      const { root, registry } = mount({ tab, panels: { palette: true } });
      const { commands, queries } = registry.list();
      const known = new Set([...commands, ...queries].map((d) => d.name));
      const used = [...root.querySelectorAll('[data-cmd]')].map((el) => el.getAttribute('data-cmd')!);
      for (const u of used) seen.add(u);
      expect([...new Set(used)].filter((c) => !known.has(c)), tab).toEqual([]);
    }
    // Every panel of the design is represented, not just the top bar.
    for (const cmd of ['form.open', 'script.run', 'selection.setPickTarget', 'chat.insertMention', 'clipboard.copy', 'file.save', 'view.setMode']) expect([...seen]).toContain(cmd);
  });

  it('opens a tree row\'s context menu, and every entry there is a Command too', async () => {
    const { root, registry } = mount();
    const known = new Set(registry.list().commands.map((d) => d.name));
    await afterEffects();
    root.querySelector('.tree .row')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    await waitFor(() => root.querySelector('.menu'), 'the tree context menu');
    const menu = [...root.querySelectorAll('.menu [data-cmd]')].map((el) => el.getAttribute('data-cmd')!);
    expect(menu).toEqual(['model.rename', 'model.duplicate', 'geometry.remove', 'selection.set', 'clipboard.copy']);
    expect(menu.filter((c) => !known.has(c))).toEqual([]);
  });

  it('collapses groups and exposes body visibility and row actions as Commands', async () => {
    const { root, store, commands } = mount();
    await afterEffects();
    const geometry = root.querySelector<HTMLButtonElement>('.group-head')!;
    expect(geometry.getAttribute('aria-expanded')).toBe('true');
    geometry.click();
    await waitFor(() => root.querySelector('.group-head')?.getAttribute('aria-expanded') === 'false', 'the Geometry group to collapse');
    expect(root.querySelector('.group-head')!.getAttribute('aria-expanded')).toBe('false');
    await waitForGone(() => root.querySelector('#tree-geometry-items'), 'the Geometry group body');
    expect(store.state.revision).toBe(3);
    root.querySelector<HTMLButtonElement>('.group-head')!.click();
    await waitFor(() => root.querySelector('#tree-geometry-items'), 'the Geometry group body');

    root.querySelector<HTMLButtonElement>('[aria-label="Hide beam in viewer"]')!.click();
    await waitFor(() => root.querySelector('[aria-label="Show beam in viewer"]'), 'the hidden-body eye');
    expect(store.state.hiddenBodies).toEqual(['beam']);
    expect(root.querySelector('[aria-label="Show beam in viewer"]')).not.toBeNull();
    root.querySelector<HTMLButtonElement>('[aria-label="Actions for beam"]')!.click();
    await waitFor(() => root.querySelector('.menu'), 'the body actions menu');
    expect(root.querySelector('.menu')).not.toBeNull();
    expect(commands.slice(-4)).toEqual([
      { cmd: 'panel.toggle', panel: 'tree.geometry', open: false },
      { cmd: 'panel.toggle', panel: 'tree.geometry', open: true },
      { cmd: 'view.setVisible', bodies: ['beam'], on: false },
      { cmd: 'panel.toggle', panel: 'tree.menu.body:beam', open: true },
    ]);
  });

  it('keeps row menus exclusive and a closed menu closed across unrelated panel changes', async () => {
    const { root, store } = mount();
    await afterEffects();
    const actions = [...root.querySelectorAll<HTMLButtonElement>('[aria-label^="Actions for"]')];
    expect(actions.length).toBeGreaterThan(1);
    const secondName = actions[1]!.getAttribute('aria-label')!.slice('Actions for '.length);
    actions[0]!.click();
    await waitFor(() => root.querySelector('.menu'), 'the first row menu');
    actions[1]!.click();
    await waitFor(() => root.querySelector('.menu')?.closest('.row')?.querySelector('.name')?.textContent === secondName, 'the second row menu');
    expect(Object.entries(store.state.panels).filter(([key, open]) => key.startsWith('tree.menu.') && open)).toHaveLength(1);

    root.querySelector('.menu')!.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    await waitForGone(() => root.querySelector('.menu'), 'the dismissed row menu');
    store.togglePanel('examples', true);
    await afterEffects();
    expect(root.querySelector('.menu')).toBeNull();
  });

  it('reorders Steps once per completed drag and leaves the tree controlled by the Model', async () => {
    const { root, commands } = mount({ model: withSteps(['heat', 'static', 'modal']) });
    await afterEffects();
    const source = root.querySelector<HTMLElement>('[data-step="modal"]')!;
    const transfer = new DataTransfer();

    // happy-dom does not declare native `ondrag*` properties, so Preact retains the JSX case.
    source.dispatchEvent(dragEvent('DragStart', transfer));
    expect(transfer.getData('text/plain')).toBe('modal');
    await afterEffects();
    expect(root.querySelector('[data-step="modal"]')!.classList.contains('dragging')).toBe(true);
    const currentTarget = root.querySelector<HTMLElement>('[data-step="heat"]')!;
    currentTarget.getBoundingClientRect = () => ({ top: 100, height: 40 } as DOMRect);
    currentTarget.dispatchEvent(dragEvent('DragOver', transfer, 105));
    await afterEffects();
    const markedTarget = root.querySelector<HTMLElement>('[data-step="heat"]')!;
    expect(markedTarget.classList.contains('drop-before'), markedTarget.className).toBe(true);
    markedTarget.dispatchEvent(dragEvent('Drop', transfer, 105));
    source.dispatchEvent(dragEvent('DragEnd', transfer));
    await afterEffects();

    expect(commands).toEqual([{ cmd: 'step.reorder', order: ['modal', 'heat', 'static'] }]);
    expect([...root.querySelectorAll('[data-step] .name')].map((el) => el.textContent)).toEqual(['heat', 'static', 'modal']);
    expect(root.querySelector('.drop-before, .drop-after, .dragging')).toBeNull();
  });

  it('offers a keyboard reorder and dispatches nothing for cancelled or same-position drags', async () => {
    const { root, commands } = mount({ model: withSteps(['heat', 'static', 'modal']) });
    await afterEffects();
    root.querySelector<HTMLButtonElement>('[aria-label="Move heat later"]')!.click();
    expect(commands).toEqual([{ cmd: 'step.reorder', order: ['static', 'heat', 'modal'] }]);

    const cancelled = root.querySelector<HTMLElement>('[data-step="modal"]')!;
    const cancelledTransfer = new DataTransfer();
    cancelled.dispatchEvent(dragEvent('DragStart', cancelledTransfer));
    await afterEffects();
    root.querySelector<HTMLElement>('[data-step="heat"]')!.dispatchEvent(dragEvent('DragOver', cancelledTransfer, 0));
    root.querySelector<HTMLElement>('[data-step="modal"]')!.dispatchEvent(dragEvent('DragEnd', cancelledTransfer));
    await afterEffects();
    expect(commands).toHaveLength(1);

    const row = root.querySelector<HTMLElement>('[data-step="static"]')!;
    const transfer = new DataTransfer();
    row.dispatchEvent(dragEvent('DragStart', transfer));
    row.dispatchEvent(dragEvent('Drop', transfer));
    row.dispatchEvent(dragEvent('DragEnd', transfer));
    expect(commands).toHaveLength(1);
  });

  it('names only Commands the registry has on every clickable', () => {
    const { root, registry } = mount();
    const { commands, queries } = registry.list();
    const known = new Set([...commands, ...queries].map((d) => d.name));
    const used = [...root.querySelectorAll('[data-cmd]')].map((el) => el.getAttribute('data-cmd')!);
    expect(used.length).toBeGreaterThan(10);
    expect([...new Set(used)].filter((c) => !known.has(c))).toEqual([]);
  });

  it('puts a `data-cmd` on every button, so nothing can do something the registry cannot', () => {
    const { root } = mount();
    // ADR 0003 binds the shell in `src/ui/**`. The tutorial card and the first-run tour are
    // self-contained panels whose own doc comments say they are not Commands; they are mounted
    // here, not written here, so this check skips their subtrees rather than their module.
    const bare = [...root.querySelectorAll('button')].filter((b) => !b.hasAttribute('data-cmd') && !b.closest('.tutorial-panel, .tour-callout'));
    expect(bare.map((b) => b.textContent)).toEqual([]);
  });

  it('shows the model, the revision and the tree the engine reported', () => {
    const { root } = mount();
    expect(root.textContent).toContain('demo');
    expect(root.textContent).toContain('rev 3');
    expect(root.textContent).toContain('beam');
    expect(root.textContent).toContain('steel');
  });

  it('disables Solve and says why while a warning stands', () => {
    const { root } = mount();
    const solve = root.querySelector<HTMLButtonElement>('button.solve')!;
    expect(solve.disabled).toBe(true);
    expect(solve.title).toContain('W-1200');
  });

  it('starts on the Journal tab and shows the Command lines', () => {
    const { root } = mount();
    expect(root.querySelector('.bottom-body')!.textContent).toContain('model.new');
  });

  // Issue #40: the drawer used to be a column of `.workspace`, which only exists once a Model
  // does, so "Ask the Assistant" on the start screen did nothing at all.
  it('mounts the Assistant drawer on the start screen, with no Model at all', async () => {
    const store = new Store();
    const viewer = { current: null };
    const host = readHostCaps({ navigator: { userAgent: 'Chrome/140.0.0.0', hardwareConcurrency: 8, gpu: {} }, crossOriginIsolated: true });
    const registry = new Registry({ schema: schema as unknown as EngineSchema, host: makeHostContext(store, transport, viewer, host), hostCommands: HOST_COMMANDS });
    store.set({ panels: { assistant: true } });
    const root = document.createElement('div');
    document.body.append(root);
    render(<App store={store} dispatch={async () => undefined} viewer={viewer} registry={registry} />, root);
    // The drawer is a lazy chunk; give the `import()` a turn.
    for (let i = 0; i < 40 && !root.querySelector('aside.assistant'); i++) await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 5)));
    expect(root.querySelector('.start')).not.toBeNull();
    expect(root.querySelector('aside.assistant')).not.toBeNull();
    render(null, root);
  });

  it('keeps the drawer outside the workspace once a Model exists, and reserves its width', async () => {
    const { root } = mount({ panels: { assistant: true } });
    for (let i = 0; i < 40 && !root.querySelector('aside.assistant'); i++) await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 5)));
    expect(root.querySelector('aside.assistant')).not.toBeNull();
    expect(root.querySelector('.workspace aside.assistant')).toBeNull();
    expect(root.querySelector('.under-bar')!.className).toBe('under-bar with-assistant');
  });

  it('renders the start screen with its four paths before a Model exists', () => {
    const store = new Store();
    const root = document.createElement('div');
    document.body.append(root);
    render(<App store={store} dispatch={async () => undefined} viewer={{ current: null }} />, root);
    expect(root.textContent).toContain('Open an example');
    expect(root.textContent).toContain('Start a tutorial');
    // The "start from geometry" card carries the model-name field, which is the same Command.
    expect([...root.querySelectorAll('[data-cmd]')].map((el) => el.getAttribute('data-cmd'))).toEqual(['panel.toggle', 'panel.toggle', 'model.new', 'model.new', 'panel.toggle']);
  });
});
