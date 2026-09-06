// ADR 0003, made enforceable: render the whole shell against a fake engine and check that
// every clickable names a Command the registry actually has. A control with a typo, or one
// wired to nothing, fails here rather than in front of a person.
import { HOST_COMMANDS, Registry, type EngineSchema, type JournalDump, type ModelSummary, type ResultSummary } from '@femlab/registry';
import { h, render } from 'preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../registry/src/generated/engine.schema.json';
import { appHostCommands, makeHostContext } from '../src/host';
import { readHostCaps } from '../src/capabilities';
import { Store } from '../src/store';
import { App } from '../src/ui/App';
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

const journal = (...commands: Record<string, unknown>[]): JournalDump =>
  ({
    entries: commands.map((cmd, seq) => ({ seq, cmd, hashAfter: `h${seq}` })),
    revision: commands.length,
    canUndo: commands.length > 0,
    canRedo: false,
  }) as unknown as JournalDump;

const result = (step: string, stale: boolean, revision: number): ResultSummary =>
  ({
    step,
    revision,
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
function mount(patch: Partial<Parameters<Store['set']>[0]> = {}): { root: HTMLElement; registry: Registry; store: Store } {
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
  render(<App store={store} dispatch={async () => undefined} viewer={viewer} commands={registry.list().commands} query={async () => ({ value: 1, unit: 'Pa' })} registry={registry} />, root);
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
