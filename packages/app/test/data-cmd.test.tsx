import { treeGroups } from '../src/ui/Tree';
// ADR 0003, made enforceable: render the whole shell against a fake engine and check that
// every clickable names a Command the registry actually has. A control with a typo, or one
// wired to nothing, fails here rather than in front of a person.
import { HOST_COMMANDS, Registry, type Command, type QueryResult, type EngineSchema, type JournalDump, type ModelSummary, type ObjectRef, type ResultSummary } from '@femlab/registry';
import { h, render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'preact/test-utils';
import schema from '../../registry/src/generated/engine.schema.json';
import { appHostCommands, makeHostContext } from '../src/host';
import { readHostCaps } from '../src/capabilities';
import { Store, visibilityReducer } from '../src/store';
import { App, handleGlobalKey, isEditableTarget } from '../src/ui/App';
import { journalTarget } from '../src/ui/Bottom';
import type { Dispatch } from '../src/ui/cmd';
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

const objects = (): ObjectRef[] => [
  { ref: 'body:beam', kind: 'body', name: 'beam', summary: 'a box' },
  { ref: 'material:steel', kind: 'material', name: 'steel', summary: 'steel' },
  { ref: 'constraint:fix', kind: 'constraint', name: 'fix', summary: 'on beam.xmin' },
  { ref: 'load:p', kind: 'load', name: 'p', summary: 'on beam.top' },
  { ref: 'step:static', kind: 'step', name: 'static', summary: 'static' },
] as ObjectRef[];

const transport = { dispatch: async () => undefined, query: async () => undefined } as unknown as WorkerTransport;

const journal = (...commands: Record<string, unknown>[]): JournalDump =>
  ({
    entries: commands.map((cmd, seq) => ({ seq, cmd, hashAfter: `h${seq}` })),
    revision: commands.length,
    canUndo: commands.length > 0,
    canRedo: false,
  }) as unknown as JournalDump;

const result = (step: string, stale: boolean, producingSeq: number): ResultSummary =>
  ({
    step,
    revision: producingSeq + 1,
    stale,
    solver: 'cpu-direct',
    iterations: 1,
    residual: 0,
    timeMs: 1,
    extremes: [],
    reactions: [],
    appliedTotal: [0, 0, 0].map((value) => ({ value, unit: 'N' })),
    balance: 0,
  }) as unknown as ResultSummary;

const boundarySeq = (root: HTMLElement): string | undefined => root.querySelector('.boundary')?.previousElementSibling?.querySelector('.no')?.textContent ?? undefined;
const staleSeqs = (root: HTMLElement): string[] => [...root.querySelectorAll('.jrow.stale .no')].map((el) => el.textContent ?? '');

/**
 * The whole shell with every panel showing at once: the tree, the generated Properties form,
 * each bottom tab and the ⌘K palette. If any of them names a Command the registry does not
 * have, the first test below fails.
 */
function mount(
  patch: Partial<Parameters<Store['set']>[0]> = {},
  dispatch: (cmd: { cmd: string } & Record<string, unknown>) => Promise<unknown> = vi.fn(async () => undefined),
): { root: HTMLElement; registry: Registry; store: Store; dispatch: typeof dispatch; commands: ({ cmd: string } & Record<string, unknown>)[] } {
  const store = new Store();
  const commands: ({ cmd: string } & Record<string, unknown>)[] = [];
  const viewer = { current: null };
  const host = readHostCaps({ navigator: { userAgent: 'Chrome/140.0.0.0', hardwareConcurrency: 8, gpu: {} }, crossOriginIsolated: true });
  const registry = new Registry({
    schema: schema as unknown as EngineSchema,
    host: makeHostContext(store, transport, viewer, host),
    hostCommands: [...HOST_COMMANDS, ...appHostCommands(store, transport, viewer, async () => undefined)],
  });
  store.set({ ready: true, model: model(), objects: objects(), revision: 3, hostCaps: host, script: 'fem.model.new({ name: "demo" })', journal: { entries: [{ seq: 0, cmd: { cmd: 'model.new', name: 'demo' }, hashAfter: 'h' }], revision: 1, canUndo: true, canRedo: false } as never, ...patch });
  store.openForm('load.pressure', { name: 'p', on: 'beam.top', value: '2.4 MPa' });
  const root = document.createElement('div');
  document.body.append(root);
  const shellDispatch = async (cmd: { cmd: string } & Record<string, unknown>): Promise<unknown> => {
    commands.push(cmd);
    if (cmd.cmd === 'panel.toggle') store.togglePanel(String(cmd['panel']), cmd['open'] as boolean | undefined);
    if (cmd.cmd === 'view.setVisible') store.set({ hiddenBodies: visibilityReducer(store.state.hiddenBodies, cmd['bodies'] as string[], Boolean(cmd['on'])) });
    return dispatch(cmd);
  };
  act(() => render(<App store={store} dispatch={shellDispatch} viewer={viewer} commands={registry.list().commands} query={async () => ({ value: 1, unit: 'Pa' })} registry={registry} />, root));
  return { root, registry, store, dispatch, commands };
}

async function cleanupShells() {
  // Removing DOM alone leaves subscriptions, effects and lazy imports alive past the test.
  await act(async () => {
    for (const root of [...document.body.children]) render(null, root);
  });
  document.body.replaceChildren();
}

describe('the shell', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ examples: [] }) })));
  });
  afterEach(cleanupShells);

  it('releases shell keyboard handlers before removing its DOM', async () => {
    const { dispatch } = mount();
    await act(async () => {});
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ cmd: 'panel.toggle', panel: 'palette' });
    await cleanupShells();
    // Journal unmount clears its viewer highlight through dispatch. Count only the next key.
    vi.mocked(dispatch).mockClear();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
    expect(dispatch).not.toHaveBeenCalled();
    expect(document.body.children).toHaveLength(0);
  });

  it('closes the command palette before opening a parameterized Command form', async () => {
    const { root, commands } = mount({ panels: { palette: true } });
    const input = root.querySelector<HTMLInputElement>('.palette input')!;
    input.value = 'load.traction';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await afterEffects();
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(enter);
    // Closing restores focus to the opener before Chromium performs Enter's default click.
    expect(enter.defaultPrevented).toBe(true);
    await waitForGone(() => root.querySelector('.palette'), 'the command palette');
    expect(commands.slice(-2)).toEqual([
      { cmd: 'panel.toggle', panel: 'palette', open: false },
      { cmd: 'form.open', command: 'load.traction' },
    ]);
  });

  it('names only Commands the registry has on every clickable, in every panel', async () => {
    const seen = new Set<string>();
    for (const tab of ['journal', 'script', 'results', 'checks', 'console'] as const) {
      await cleanupShells();
      const { root, registry } = mount({ tab, panels: { palette: true, examples: true } });
      const { commands, queries } = registry.list();
      const known = new Set([...commands, ...queries].map((d) => d.name));
      const used = [...root.querySelectorAll('[data-cmd]')].map((el) => el.getAttribute('data-cmd')!);
      for (const u of used) seen.add(u);
      expect([...new Set(used)].filter((c) => !known.has(c)), tab).toEqual([]);
    }
    // Every panel of the design is represented, not just the top bar.
    for (const cmd of ['form.open', 'script.run', 'form.pick', 'chat.insertMention', 'clipboard.copy', 'file.save', 'view.setMode', 'example.filter']) expect([...seen]).toContain(cmd);
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

  it('keeps an intentional Script draft while showing the live Journal script', async () => {
    const { registry, store } = mount({ tab: 'script' });
    await registry.dispatch({ cmd: 'script.setSource', code: '// draft' });
    expect(store.state).toMatchObject({ tab: 'script', scriptDraft: '// draft', scriptEditing: true });
    await registry.dispatch({ cmd: 'script.setSource', code: '\n// inserted Journal', append: true });
    expect(store.state.scriptDraft).toBe('// draft\n// inserted Journal');

    store.set({ script: '// live Journal' });
    await registry.dispatch({ cmd: 'script.setEditing', editing: false });
    expect(store.state.scriptEditing).toBe(false);
    expect(store.state.scriptDraft).toBe('// draft\n// inserted Journal');
    expect(store.state.script).toBe('// live Journal');
    await registry.dispatch({ cmd: 'script.setEditing', editing: true });
    expect(store.state).toMatchObject({ tab: 'script', scriptEditing: true, scriptDraft: '// draft\n// inserted Journal' });
  });

  it('recognises the fields that own editing shortcuts', () => {
    const { root } = mount();
    const input = root.querySelector<HTMLInputElement>('input')!;
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    const token = document.createElement('span');
    editor.append(token);
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(token)).toBe(true);
    expect(isEditableTarget(root)).toBe(false);
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

  it('keeps the drawer outside the workspace once a Model exists', async () => {
    const { root } = mount({ panels: { assistant: true } });
    for (let i = 0; i < 40 && !root.querySelector('aside.assistant'); i++) await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 5)));
    expect(root.querySelector('aside.assistant')).not.toBeNull();
    expect(root.querySelector('.workspace aside.assistant')).toBeNull();
    // A sibling of `.shell`, which is what lets it outlive the flip out of the start screen.
    expect(root.querySelector('.shell ~ aside.assistant')).not.toBeNull();
  });

  it('shows the Result boundary for a fresh solve', () => {
    const entries = journal({ cmd: 'model.new', name: 'demo' }, { cmd: 'solve.run', step: 'static' });
    const { root } = mount({ journal: entries, result: result('static', false, 1) });
    expect(boundarySeq(root)).toBe('1');
    expect(staleSeqs(root)).toEqual([]);
  });

  it('marks only rows after a stale Result and moves the boundary when that Step is re-solved', () => {
    const staleJournal = journal({ cmd: 'model.new', name: 'demo' }, { cmd: 'solve.run', step: 'static' }, { cmd: 'geometry.addBox', name: 'after' });
    const stale = mount({ journal: staleJournal, result: result('static', true, 1) }).root;
    expect(boundarySeq(stale)).toBe('1');
    expect(staleSeqs(stale)).toEqual(['2']);

    const resolvedJournal = journal(...staleJournal.entries.map((entry) => entry.cmd as unknown as Record<string, unknown>), { cmd: 'solve.run', step: 'static' });
    const resolved = mount({ journal: resolvedJournal, result: result('static', false, 3) }).root;
    expect(boundarySeq(resolved)).toBe('3');
    expect(staleSeqs(resolved)).toEqual([]);
  });

  it('attributes the boundary to the current Result and does not invent one after undo', () => {
    const twoSteps = journal({ cmd: 'model.new', name: 'demo' }, { cmd: 'solve.run', step: 'static' }, { cmd: 'solve.run', step: 'modal' });
    const currentStatic = mount({ journal: twoSteps, result: result('static', false, 1) }).root;
    expect(boundarySeq(currentStatic)).toBe('1');

    const undone = journal({ cmd: 'model.new', name: 'demo' });
    expect(boundarySeq(mount({ journal: undone, result: result('static', false, undone.revision) }).root)).toBeUndefined();
    expect(boundarySeq(mount({ journal: twoSteps, result: null }).root)).toBeUndefined();
  });

  it('does not attribute an undone re-solve to an older solve of the same Step', () => {
    const solvedTwice = journal(
      { cmd: 'model.new', name: 'demo' },
      { cmd: 'solve.run', step: 'static' },
      { cmd: 'load.traction', name: 'p', on: 'beam.top', total: ['0 N', '0 N', '-2 kN'] },
      { cmd: 'solve.run', step: 'static' },
    );
    expect(boundarySeq(mount({ journal: solvedTwice, result: result('static', false, 3) }).root)).toBe('3');

    const undone = journal(...solvedTwice.entries.slice(0, -1).map((entry) => entry.cmd as unknown as Record<string, unknown>));
    expect(boundarySeq(mount({ journal: undone, result: result('static', false, 3) }).root)).toBeUndefined();
  });

  it('attributes a retained convergence Result only to its exact producing study', () => {
    const converged = journal(
      { cmd: 'model.new', name: 'demo' },
      { cmd: 'study.converge', step: 'static', sizes: ['50 mm', '25 mm'], quantity: { kind: 'max', field: 'vonMises' }, restore: false },
    );
    expect(boundarySeq(mount({ journal: converged, result: result('static', false, 1) }).root)).toBe('1');

    const restoring = journal(
      { cmd: 'model.new', name: 'demo' },
      { cmd: 'study.converge', step: 'static', sizes: ['50 mm', '25 mm'], quantity: { kind: 'max', field: 'vonMises' }, restore: true },
    );
    // A restoring study never produces a cached Result, even if inconsistent host data points
    // at that exact Journal line.
    expect(boundarySeq(mount({ journal: restoring, result: result('static', false, 1) }).root)).toBeUndefined();
  });

  it('resolves only explicit, live Journal targets to drawable Model names', () => {
    const current = model();
    const refs = objects();
    expect(journalTarget({ cmd: 'geometry.addBox', name: 'beam' }, current, refs)).toEqual({ ref: 'body:beam', highlight: { bodies: ['beam'] } });
    expect(journalTarget({ cmd: 'material.add', name: 'steel' }, current, refs)).toEqual({ ref: 'material:steel', highlight: { bodies: ['beam'] } });
    expect(journalTarget({ cmd: 'constraint.fix', name: 'fix', on: 'old.face' }, current, refs)).toEqual({ ref: 'constraint:fix', highlight: { sets: ['beam.xmin'] } });
    expect(journalTarget({ cmd: 'load.pressure', name: 'p', on: 'old.face' }, current, refs)).toEqual({ ref: 'load:p', highlight: { sets: ['beam.top'] } });
    expect(journalTarget({ cmd: 'model.rename', kind: 'body', name: 'old', to: 'beam' }, current, refs)).toEqual({ ref: 'body:beam', highlight: { bodies: ['beam'] } });
    expect(journalTarget({ cmd: 'step.add', name: 'static' }, current, refs)).toEqual({ ref: 'step:static', highlight: null });

    expect(journalTarget({ cmd: 'geometry.addBox', name: 'deleted' }, current, refs)).toBeNull();
    expect(journalTarget({ cmd: 'geometry.remove', name: 'beam' }, current, refs)).toBeNull();
    expect(journalTarget({ cmd: 'solve.run', step: 'static' }, current, refs)).toBeNull();
  });

  it('selects and highlights a Journal target while keeping copy separate', async () => {
    const dispatch = vi.fn<Dispatch>(async () => undefined);
    const entries = journal({ cmd: 'model.new', name: 'demo' }, { cmd: 'geometry.addBox', name: 'beam', size: ['1 m', '1 m', '1 m'] }, { cmd: 'geometry.addBox', name: 'deleted', size: ['1 m', '1 m', '1 m'] });
    const { root, store } = mount({ tab: 'journal', journal: entries }, dispatch);
    const row = root.querySelector<HTMLElement>('[data-target-ref="body:beam"]')!;
    const select = row.querySelector<HTMLButtonElement>('.jrow-main')!;

    row.dispatchEvent(new MouseEvent('mouseenter'));
    expect(dispatch).toHaveBeenLastCalledWith({ cmd: 'view.highlight', bodies: ['beam'] });
    row.dispatchEvent(new MouseEvent('mouseleave'));
    expect(dispatch).toHaveBeenLastCalledWith({ cmd: 'view.highlight' });
    select.focus();
    expect(dispatch).toHaveBeenLastCalledWith({ cmd: 'view.highlight', bodies: ['beam'] });
    select.blur();
    expect(dispatch).toHaveBeenLastCalledWith({ cmd: 'view.highlight' });

    select.click();
    expect(dispatch).toHaveBeenLastCalledWith({ cmd: 'selection.set', refs: ['body:beam'] });
    row.querySelector<HTMLButtonElement>('.jcopy')!.click();
    expect(dispatch).toHaveBeenLastCalledWith({ cmd: 'clipboard.copy', what: { kind: 'text', text: 'await fem.geometry.addBox({ name: "beam", size: ["1 m", "1 m", "1 m"] });' } });
    expect(store.state.journal).toBe(entries);

    const unavailable = [...root.querySelectorAll<HTMLElement>('.jrow')].find((item) => item.textContent?.includes('deleted'))!;
    expect(unavailable.dataset['targetRef']).toBeUndefined();
    expect(unavailable.querySelector<HTMLButtonElement>('.jrow-main')!.disabled).toBe(true);
    expect(root.querySelector<HTMLElement>('.jrow')!.querySelector<HTMLButtonElement>('.jrow-main')!.disabled).toBe(true);

    row.dispatchEvent(new MouseEvent('mouseenter'));
    render(null, root);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dispatch).toHaveBeenLastCalledWith({ cmd: 'view.highlight' });
  });

  it('keeps semantic object selection and Properties on the Journal object', async () => {
    const { registry, store } = mount();
    const definition = { cmd: 'material.add', name: 'steel', E: '210 GPa', nu: 0.3, rho: '7800 kg/m^3', alpha: '12e-6 1/K' } satisfies Command;
    const query = vi.spyOn(transport, 'query').mockResolvedValueOnce({ command: definition });
    await registry.dispatch({ cmd: 'selection.set', refs: ['material:steel'] });
    expect(query).toHaveBeenCalledWith({ query: 'query.definition', kind: 'material', name: 'steel' });
    expect(store.state.selection.refs).toEqual(['material:steel']);
    expect(store.state.selection.bodies).toEqual([]);
    const { cmd, ...values } = definition;
    expect(store.state.form).toMatchObject({ cmd, values });
    query.mockRestore();
  });

  it('keeps a newer explicit form edit when a Journal selection definition returns late', async () => {
    const { registry, store } = mount();
    let resolveSelection!: (value: QueryResult) => void;
    const query = vi.spyOn(transport, 'query')
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSelection = resolve; }))
      .mockResolvedValueOnce({ command: { cmd: 'load.pressure', name: 'newer', on: 'beam.top', value: '3 MPa' } });
    const selection = registry.dispatch({ cmd: 'selection.set', refs: ['material:steel'] });
    await registry.dispatch({ cmd: 'form.edit', kind: 'load', name: 'newer' });
    resolveSelection({ command: { cmd: 'material.add', name: 'steel', E: '210 GPa', nu: 0.3 } });
    await selection;
    expect(store.state.form).toMatchObject({ cmd: 'load.pressure', values: { name: 'newer', on: 'beam.top', value: '3 MPa' } });
    query.mockRestore();
  });

  it.each([
    { cmd: 'selection.clear' },
    { cmd: 'selection.set', bodies: ['beam'] },
  ])('does not open a late Journal definition after $cmd changes the selection', async (next) => {
    const { registry, store } = mount();
    const previousForm = store.state.form;
    let resolveSelection!: (value: QueryResult) => void;
    const query = vi.spyOn(transport, 'query')
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSelection = resolve; }));
    const selection = registry.dispatch({ cmd: 'selection.set', refs: ['material:steel'] });
    await registry.dispatch(next);
    const selected = store.state.selection;
    resolveSelection({ command: { cmd: 'material.add', name: 'steel', E: '210 GPa', nu: 0.3 } });
    await selection;
    expect(store.state.form).toBe(previousForm);
    expect(store.state.selection).toBe(selected);
    expect(store.state.selection.refs).not.toContain('material:steel');
    query.mockRestore();
  });

  // Issue #41: the start screen leads with the assistant composer, then New project, then the
  // Recent list, then the three cards. Every one of them is a Command with its own `data-cmd`.
  it('renders the start screen in the issue’s reading order before a Model exists', () => {
    const store = new Store();
    const root = document.createElement('div');
    document.body.append(root);
    render(<App store={store} dispatch={async () => undefined} viewer={{ current: null }} />, root);
    expect(root.querySelector('input.ask-field')!.getAttribute('placeholder')).toContain('Describe the part');
    expect(root.textContent).toContain('New project');
    expect(root.textContent).toContain('Projects you start are kept in this browser');
    expect(root.textContent).toContain('Examples');
    expect(root.textContent).toContain('Tutorials');
    // Where a project goes is said out loud, whichever answer this browser gives.
    expect(root.textContent).toMatch(/projects (saved in this browser|need browser storage)/);
    // The composer's field and the project-name field carry the Command they feed.
    expect([...root.querySelectorAll('[data-cmd]')].map((el) => el.getAttribute('data-cmd'))).toEqual([
      'chat.send',
      'chat.send',
      'project.new',
      'project.new',
      'file.open',
      'panel.toggle',
      'panel.toggle',
    ]);
  });

  it('lists Recent projects as project.open cards, with rename and delete on each', () => {
    const store = new Store();
    const at = Date.now() - 4 * 60_000;
    store.set({
      projects: [
        { id: 'a', name: 'corbel-ULS', at, createdAt: at, commands: 41, hash: 'h', thumbnail: null },
        { id: 'b', name: 'cantilever', at: at - 86_400_000, createdAt: at, commands: 12, hash: 'h', thumbnail: 'data:image/webp;base64,AA' },
      ],
    });
    const root = document.createElement('div');
    document.body.append(root);
    render(<App store={store} dispatch={async () => undefined} viewer={{ current: null }} />, root);
    expect(root.textContent).toContain('corbel-ULS');
    expect(root.textContent).toContain('41 Commands · edited 4 minutes ago');
    expect(root.textContent).toContain('12 Commands · edited 1 day ago');
    expect(root.querySelector('img.recent-thumb')!.getAttribute('src')).toBe('data:image/webp;base64,AA');
    expect([...root.querySelectorAll('.recents [data-cmd]')].map((el) => el.getAttribute('data-cmd'))).toEqual([
      'project.open',
      'project.rename',
      'project.delete',
      'project.open',
      'project.rename',
      'project.delete',
    ]);
  });

  it('puts the project name and its saved state in the top bar, and Projects reopens the list', () => {
    const at = new Date('2026-09-06T12:04:00Z').getTime();
    const { root } = mount({ project: { id: 'a', name: 'corbel-ULS', at, createdAt: at, commands: 41, hash: 'h', thumbnail: null, saving: false, autosave: true } });
    const field = root.querySelector<HTMLInputElement>('input.model-name')!;
    expect(field.value).toBe('corbel-ULS');
    expect(field.getAttribute('data-cmd')).toBe('project.rename');
    expect(root.querySelector('.saved-chip')!.textContent).toContain('saved');
    const bar = [...root.querySelectorAll('.topbar [data-cmd]')].map((el) => el.getAttribute('data-cmd'));
    expect(bar).toContain('project.rename');
    expect(bar).toContain('project.save');
    expect(bar).toContain('file.save');
  });

  it('says the project is saving, and says so plainly when the background save is off', async () => {
    const at = Date.now();
    const meta = { id: 'a', name: 'x', at, createdAt: at, commands: 1, hash: null, thumbnail: null };
    expect(mount({ project: { ...meta, saving: true, autosave: true } }).root.querySelector('.saved-chip')!.textContent).toContain('saving…');
    await cleanupShells();
    expect(mount({ project: { ...meta, saving: false, autosave: false } }).root.querySelector('.saved-chip')!.textContent).toContain('not saved — storage is off');
  });

  // Plan F · #43: the add chip is there with items in the group, and its menu is Commands.
  it('offers the shape menu from the Geometry chip even though the group already has a body', async () => {
    const { root, registry } = mount();
    const known = new Set(registry.list().commands.map((d) => d.name));
    const chip = [...root.querySelectorAll<HTMLButtonElement>('.tree .add-row > .chip-add')].find((b) => b.textContent?.includes('add body'))!;
    expect(chip).toBeTruthy();
    await act(async () => chip.click());
    const menu = [...root.querySelectorAll('.add-menu [data-cmd]')];
    expect(menu.map((el) => el.textContent)).toEqual(['▭box', '⬭cylinder', '◯sphere', '▱sheet', '⬒extrude', '◑revolve', '⬬union', '⊖subtract', '⊗intersect', '⇲transform', '∖cut']);
    expect(menu.map((el) => el.getAttribute('data-cmd')!).filter((c) => !known.has(c))).toEqual([]);
  });

  // Issue #211: a menu closes on Escape and gives focus back to the chip that opened it.
  it('closes the shape menu on Escape and returns focus to the chip', async () => {
    const { root } = mount();
    const chip = [...root.querySelectorAll<HTMLButtonElement>('.tree .add-row > .chip-add')].find((b) => b.textContent?.includes('add body'))!;
    await act(async () => chip.click());
    expect(root.querySelector('.add-menu')).toBeTruthy();

    // From inside the menu, which is where the keystroke actually lands.
    const item = root.querySelector<HTMLElement>('.add-menu [data-cmd]')!;
    await act(async () => {
      item.focus();
      item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(root.querySelector('.add-menu')).toBeNull();
    expect(document.activeElement).toBe(chip);
  });
});

it('names simplex element families and preserves the mesh editor arguments', () => {
  for (const [idealisation, order, element] of [['solid3d', 1, 'Tet 4'], ['solid3d', 2, 'Tet 10'], ['planeStress', 1, 'Tri 3'], ['planeStress', 2, 'Tri 6']] as const) {
    const store = new Store();
    const current = model();
    current.idealisation = idealisation;
    current.meshSettings = { mesher: { kind: 'lattice', size: 1 }, order, formulation: 'incompatible-modes', simplices: true };
    store.set({ model: current });
    const row = treeGroups(store.state).find((group) => group.label === 'Mesh')!.items[0]!;
    expect(row.summary).toContain(element);
    expect(row.summary).not.toContain('incompatible-modes');
    expect(row.args).toEqual(current.meshSettings);
  }
});
