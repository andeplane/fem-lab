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

  it('keeps the drawer outside the workspace once a Model exists', async () => {
    const { root } = mount({ panels: { assistant: true } });
    for (let i = 0; i < 40 && !root.querySelector('aside.assistant'); i++) await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 5)));
    expect(root.querySelector('aside.assistant')).not.toBeNull();
    expect(root.querySelector('.workspace aside.assistant')).toBeNull();
    // A sibling of `.shell`, which is what lets it outlive the flip out of the start screen.
    expect(root.querySelector('.shell ~ aside.assistant')).not.toBeNull();
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

  it('says the project is saving, and says so plainly when the background save is off', () => {
    const at = Date.now();
    const meta = { id: 'a', name: 'x', at, createdAt: at, commands: 1, hash: null, thumbnail: null };
    expect(mount({ project: { ...meta, saving: true, autosave: true } }).root.querySelector('.saved-chip')!.textContent).toContain('saving…');
    document.body.innerHTML = '';
    expect(mount({ project: { ...meta, saving: false, autosave: false } }).root.querySelector('.saved-chip')!.textContent).toContain('not saved — storage is off');
  });
});
