// ADR 0003, made enforceable: render the whole shell against a fake engine and check that
// every clickable names a Command the registry actually has. A control with a typo, or one
// wired to nothing, fails here rather than in front of a person.
import { HOST_COMMANDS, Registry, type EngineSchema, type ModelSummary } from '@femlab/registry';
import { h, render } from 'preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../registry/src/generated/engine.schema.json';
import { appHostCommands, makeHostContext } from '../src/host';
import { readHostCaps } from '../src/capabilities';
import { Store } from '../src/store';
import { App, handleGlobalKey, isEditableTarget } from '../src/ui/App';
import type { WorkerTransport } from '../src/worker-transport';

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

/**
 * The whole shell with every panel showing at once: the tree, the generated Properties form,
 * each bottom tab and the ⌘K palette. If any of them names a Command the registry does not
 * have, the first test below fails.
 */
function mount(
  patch: Partial<Parameters<Store['set']>[0]> = {},
  dispatch: (cmd: { cmd: string } & Record<string, unknown>) => Promise<unknown> = async () => undefined,
): { root: HTMLElement; registry: Registry; store: Store } {
  const store = new Store();
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
  render(<App store={store} dispatch={dispatch} viewer={viewer} commands={registry.list().commands} query={async () => ({ value: 1, unit: 'Pa' })} registry={registry} />, root);
  return { root, registry, store };
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
    root.querySelector('.tree .row')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20)); // preact re-renders after the state change
    const menu = [...root.querySelectorAll('.menu [data-cmd]')].map((el) => el.getAttribute('data-cmd')!);
    expect(menu).toEqual(['model.rename', 'model.duplicate', 'geometry.remove', 'selection.set', 'clipboard.copy']);
    expect(menu.filter((c) => !known.has(c))).toEqual([]);
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

  it('leaves undo and copy to editable controls, including nested contenteditable text', async () => {
    const dispatch = vi.fn(async () => undefined);
    const events: KeyboardEvent[] = [];
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    const child = document.createElement('span');
    editor.append(child);

    for (const target of [input, textarea, editor, child]) {
      for (const key of ['z', 'c']) {
        const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ctrlKey: true });
        events.push(event);
        target.addEventListener('keydown', (e) => handleGlobalKey(e, dispatch, 1, {}), { once: true });
        target.dispatchEvent(event);
      }
    }
    await Promise.resolve();
    expect(dispatch).not.toHaveBeenCalled();
    expect(events.every((event) => !event.defaultPrevented)).toBe(true);
  });

  it('recognizes a contenteditable false island inside an editor as non-editable', () => {
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    const island = document.createElement('div');
    island.setAttribute('contenteditable', 'false');
    const child = document.createElement('span');
    island.append(child);
    editor.append(island);
    expect(isEditableTarget(editor)).toBe(true);
    expect(isEditableTarget(child)).toBe(false);
  });

  it('does not handle a shortcut another listener has already cancelled', () => {
    const dispatch = vi.fn(async () => undefined);
    const event = new KeyboardEvent('keydown', { cancelable: true, key: 'z', ctrlKey: true });
    event.preventDefault();
    handleGlobalKey(event, dispatch, 1, {});
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('handles undo, redo and copy from the workspace and claims their browser shortcuts', async () => {
    const dispatch = vi.fn(async () => undefined);
    const workspace = document.createElement('div');
    const events: KeyboardEvent[] = [];
    workspace.addEventListener('keydown', (e) => {
      events.push(e);
      handleGlobalKey(e, dispatch, 1, {});
    });
    const undo = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'z', ctrlKey: true });
    const redo = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'z', ctrlKey: true, shiftKey: true });
    const copy = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'c', ctrlKey: true });
    workspace.dispatchEvent(undo);
    workspace.dispatchEvent(redo);
    workspace.dispatchEvent(copy);
    expect(dispatch).toHaveBeenNthCalledWith(1, { cmd: 'journal.undo', steps: 1 });
    expect(dispatch).toHaveBeenNthCalledWith(2, { cmd: 'journal.redo', steps: 1 });
    expect(dispatch).toHaveBeenNthCalledWith(3, { cmd: 'clipboard.copy', what: { kind: 'selection' } });
    expect(events.map((event) => event.defaultPrevented)).toEqual([true, true, true]);
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

  // plan E — the tutorial spotlight finds "the + add material chip" from a Command id alone by
  // reading `data-opens`, so that attribute is under the same invariant as `data-cmd`.
  it('names only Commands the registry has on every data-opens, and puts it only on form.open', () => {
    const { root, registry } = mount();
    const known = new Set(registry.list().commands.map((d) => d.name));
    const opens = [...root.querySelectorAll('[data-opens]')];
    expect(opens.length).toBeGreaterThan(0);
    expect(opens.filter((el) => el.getAttribute('data-cmd') !== 'form.open').map((el) => el.getAttribute('data-opens'))).toEqual([]);
    expect([...new Set(opens.map((el) => el.getAttribute('data-opens')!))].filter((c) => !known.has(c))).toEqual([]);
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

  // Plan F · #43: the add chip is there with items in the group, and its menu is Commands.
  it('offers the shape menu from the Geometry chip even though the group already has a body', async () => {
    const { root, registry } = mount();
    const known = new Set(registry.list().commands.map((d) => d.name));
    const chip = [...root.querySelectorAll<HTMLButtonElement>('.tree .add-row > .chip-add')].find((b) => b.textContent?.includes('add body'))!;
    expect(chip).toBeTruthy();
    chip.click();
    await new Promise((r) => setTimeout(r, 20));
    const menu = [...root.querySelectorAll('.add-menu [data-cmd]')];
    expect(menu.map((el) => el.textContent)).toEqual(['▭box', '⬭cylinder', '◯sphere', '▱sheet', '⬒extrude', '◑revolve', '⬬union', '⊖subtract', '⊗intersect', '⇲transform', '∖cut']);
    expect(menu.map((el) => el.getAttribute('data-cmd')!).filter((c) => !known.has(c))).toEqual([]);
  });

  // Issue #211: a menu closes on Escape and gives focus back to the chip that opened it.
  it('closes the shape menu on Escape and returns focus to the chip', async () => {
    const { root } = mount();
    const chip = [...root.querySelectorAll<HTMLButtonElement>('.tree .add-row > .chip-add')].find((b) => b.textContent?.includes('add body'))!;
    chip.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(root.querySelector('.add-menu')).toBeTruthy();

    // From inside the menu, which is where the keystroke actually lands.
    const item = root.querySelector<HTMLElement>('.add-menu [data-cmd]')!;
    item.focus();
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(root.querySelector('.add-menu')).toBeNull();
    expect(document.activeElement).toBe(chip);
  });
});
