import { render } from 'preact';
import { expect, it, vi } from 'vitest';
import { HOST_COMMANDS, HOST_QUERIES, Registry, type EngineSchema, type JournalDiff, type JournalEntry } from '@femlab/registry';
import schema from '../../registry/src/generated/engine.schema.json';
import { appHostCommands, appHostQueries, makeHostContext } from '../src/host';
import type { HostCaps } from '../src/capabilities';
import { Store } from '../src/store';
import { Bottom } from '../src/ui/Bottom';
import type { WorkerTransport } from '../src/worker-transport';

const first: JournalEntry = { seq: 0, cmd: { cmd: 'model.new', name: 'A' }, hashAfter: 'a' };
const second: JournalEntry = { seq: 1, cmd: { cmd: 'model.setName', name: 'B' }, hashAfter: 'b' };
const diff = (baseHash = 'a', currentHash = 'a', added: JournalEntry[] = []): JournalDiff =>
  ({ baseHash, currentHash, sharedEntries: 1, removed: [], added });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup() {
  const store = new Store();
  store.set({ journal: { entries: [first], revision: 1, hash: 'a', canUndo: true, canRedo: false } });
  const file = { format: 'femlab/1', model: { name: 'A' }, journal: { entries: [structuredClone(first)] } };
  const query = vi.fn(async (): Promise<JournalDiff> => diff());
  const transport = { exportFile: vi.fn(async () => file), query, importFile: vi.fn() };
  const ctx = makeHostContext(store, transport as unknown as WorkerTransport, { current: null }, {} as HostCaps);
  const registry = new Registry({
    schema: schema as unknown as EngineSchema, host: ctx,
    hostCommands: [...HOST_COMMANDS, ...appHostCommands(store, transport as unknown as WorkerTransport, { current: null }, async () => undefined)],
    hostQueries: [...HOST_QUERIES, ...appHostQueries(store)],
  });
  const compare = (entry = first) => registry.dispatch({ cmd: 'file.compare', json: JSON.stringify({ ...file, journal: { entries: [entry] } }) });
  return { store, file, query, ctx, registry, compare };
}

it.each([[0, 1, 2], [10, 20, 99]])('marks only the causal added occurrence with seq labels %j', (...labels) => {
  const s = setup();
  const entries = [first, second, second].map((entry, index) => ({ ...entry, seq: labels[index]! }));
  s.store.set({ tab: 'journal', journal: { entries, revision: 3, hash: 'history', canUndo: true, canRedo: false },
    journalComparison: { ...diff('base', 'history', [entries[2]!]), sharedEntries: 2 }, comparisonSource: 'saved' });
  const root = document.createElement('div');
  render(<Bottom s={s.store.state} store={s.store} dispatch={async () => undefined} query={async () => undefined} />, root);
  const marked = [...root.querySelectorAll('.comparison-added .no')].map(row => row.textContent);
  render(null, root);
  expect(marked).toEqual([String(labels[2])]);
});

it('fences an imported comparison reply when a pending explicit save finishes', async () => {
  const s = setup();
  await s.compare({ ...first, cmd: { cmd: 'model.new', name: 'colleague' } });
  const write = deferred<void>();
  s.ctx.folder.writeText = vi.fn(() => write.promise);
  const saving = s.registry.dispatch({ cmd: 'file.save', to: 'folder' });
  await vi.waitFor(() => expect(s.ctx.folder.writeText).toHaveBeenCalledOnce());
  const reply = deferred<JournalDiff>(); s.query.mockReturnValueOnce(reply.promise);
  const pending = s.registry.query({ query: 'query.journalComparison' });
  write.resolve(); await saving;
  reply.resolve(diff('colleague', 'a', [first]));
  expect(await pending).toBeNull();
  expect(s.store.state.journalComparison).toBeNull();
  expect(s.store.state.comparisonBaseline).toBeNull();
  expect(s.store.state.savedBaseline).toEqual([first]);
  // The exact normalized baseline is owned by the save, not an alias of the export object.
  const exported = s.file.journal.entries[0]!.cmd;
  if (exported.cmd === 'model.new') exported.name = 'mutated export object';
  expect(s.store.state.savedBaseline).toEqual([first]);
});

it.each(['resolve', 'reject'] as const)('ignores a late %s from an older current Journal with the same selected baseline', async outcome => {
  const s = setup(); await s.compare();
  const old = deferred<JournalDiff>(); s.query.mockReturnValueOnce(old.promise);
  const pending = s.registry.query({ query: 'query.journalComparison' });
  s.store.set({ journal: { entries: [first, second], revision: 2, hash: 'b', canUndo: true, canRedo: false } });
  expect(s.store.state.journalComparison).toBeNull();
  const current = diff('a', 'b', [second]); s.query.mockResolvedValueOnce(current);
  expect(await s.registry.query({ query: 'query.journalComparison' })).toEqual(current);
  if (outcome === 'resolve') old.resolve(diff()); else old.reject(new Error('obsolete failure'));
  expect(await pending).toBeNull();
  expect(s.store.state.journalComparison).toEqual(current);
});

it('keeps the newer imported file when two comparison requests finish out of order', async () => {
  const s = setup(); const old = deferred<JournalDiff>(); s.query.mockReturnValueOnce(old.promise);
  const pending = s.compare();
  const selected = { ...second, cmd: { cmd: 'model.setName' as const, name: 'new colleague' } };
  const current = diff('new colleague', 'a', [first]); s.query.mockResolvedValueOnce(current);
  await s.compare(selected);
  old.resolve(diff('old colleague')); await pending;
  expect(s.store.state.comparisonSource).toBe('imported');
  expect(s.store.state.comparisonBaseline).toEqual([selected]);
  expect(s.store.state.journalComparison).toEqual(current);
});

it('queries the saved baseline freshly and reports no baseline before save or import', async () => {
  const s = setup();
  expect(await s.registry.query({ query: 'query.journalComparison' })).toBeNull();
  expect(s.query).not.toHaveBeenCalled();
  s.store.markSaved({ entries: [first] });
  s.store.set({ journal: { entries: [first, second], revision: 2, hash: 'b', canUndo: true, canRedo: false } });
  const current = diff('a', 'b', [second]); s.query.mockResolvedValueOnce(current);
  expect(await s.registry.query({ query: 'query.journalComparison' })).toEqual(current);
  expect(s.store.state.comparisonSource).toBe('saved');
});

it('keeps removed colleague rows independent of current attribution and solve boundaries', () => {
  const s = setup(); const solve: JournalEntry = { seq: 1, cmd: { cmd: 'solve.run', step: 'load' }, hashAfter: 'solve' };
  s.store.set({ tab: 'journal', journal: { entries: [first, solve], revision: 2, hash: 'solve', canUndo: true, canRedo: false },
    result: { step: 'load', revision: 2, stale: true, solver: 'cpu-direct', iterations: 1, residual: 0, timeMs: 0, extremes: [], reactions: [], appliedTotal: [{ value: 0, unit: 'N' }, { value: 0, unit: 'N' }, { value: 0, unit: 'N' }], balance: 0 },
    journalWho: { 1: { who: 'ai', at: 1000 } }, journalComparison: { ...diff('b', 'solve', [solve]), removed: [second] }, comparisonSource: 'imported' });
  const root = document.createElement('div');
  render(<Bottom s={s.store.state} store={s.store} dispatch={async () => undefined} query={async () => undefined} />, root);
  const removed = root.querySelector('.comparison-removed')!;
  expect(removed.querySelector('.jwho')?.textContent).toBe('unknown');
  expect(removed.querySelector('.jtime')?.textContent).toBe('');
  expect(removed.querySelector('.boundary')).toBeNull();
  render(null, root);
});

it('settles a cancelled comparison picker without changing the selected baseline', async () => {
  const s = setup(); await s.compare();
  const before = s.store.state;
  let picker!: HTMLInputElement;
  const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) { picker = this; });
  try {
    const pending = s.registry.dispatch({ cmd: 'file.compare', picker: true });
    picker.dispatchEvent(new Event('cancel'));
    await expect(pending).rejects.toMatchObject({ code: 'file.not-found' });
    expect(s.store.state).toBe(before);
  } finally { click.mockRestore(); }
});

it('discards an old-current reply even before another comparison query starts', async () => {
  const s = setup(); await s.compare();
  const old = deferred<JournalDiff>(); s.query.mockReturnValueOnce(old.promise);
  const pending = s.registry.query({ query: 'query.journalComparison' });
  s.store.set({ journal: { entries: [first, second], revision: 2, hash: 'b', canUndo: true, canRedo: false } });
  old.resolve(diff());
  expect(await pending).toBeNull();
  expect(s.store.state.journalComparison).toBeNull();
  expect(s.store.state.comparisonSource).toBe('imported');
  expect(s.store.state.comparisonBaseline).toEqual([first]);
});

it('does not draw a live-engine diff against a Store Journal that has not hydrated yet', async () => {
  const s = setup(); await s.compare();
  // A Command has completed in the engine, but query.model/query.journal hydration is pending.
  // No Store reference or comparison request changes while the live Query returns the new hash.
  const newer = diff('a', 'b', [second]); s.query.mockResolvedValueOnce(newer);
  expect(await s.registry.query({ query: 'query.journalComparison' })).toBeNull();
  expect(s.store.state.journal?.hash).toBe('a');
  expect(s.store.state.journalComparison?.currentHash).toBe('a');
  s.store.set({ journal: { entries: [first, second], revision: 2, hash: 'b', canUndo: true, canRedo: false } });
  s.query.mockResolvedValueOnce(newer);
  expect(await s.registry.query({ query: 'query.journalComparison' })).toEqual(newer);
  expect(s.store.state.journalComparison?.currentHash).toBe('b');
});


it('does not select an imported comparison until its live-engine hash matches displayed rows', async () => {
  const s = setup(); s.store.markSaved({ entries: [first] });
  const newer = diff('colleague', 'b', [second]); s.query.mockResolvedValueOnce(newer);
  await s.compare(second);
  expect(s.store.state.comparisonSource).toBeNull();
  expect(s.store.state.comparisonBaseline).toBeNull();
  expect(s.store.state.journalComparison).toBeNull();
  s.store.set({ journal: { entries: [first, second], revision: 2, hash: 'b', canUndo: true, canRedo: false } });
  s.query.mockResolvedValueOnce(newer); await s.compare(second);
  expect(s.store.state.comparisonSource).toBe('imported');
  expect(s.store.state.comparisonBaseline).toEqual([second]);
  expect(s.store.state.journalComparison).toEqual(newer);
});

it('fences an imported reply when project.save establishes its exact receipt baseline', async () => {
  const s = setup(); await s.compare(second);
  const saved = deferred<Awaited<ReturnType<typeof s.ctx.projects.save>>>();
  s.ctx.projects.save = vi.fn(() => saved.promise);
  const saving = s.registry.dispatch({ cmd: 'project.save' });
  const old = deferred<JournalDiff>(); s.query.mockReturnValueOnce(old.promise);
  const pending = s.registry.query({ query: 'query.journalComparison' });
  saved.resolve({ id: 'project', name: 'A', at: 1, createdAt: 0, commands: 1, hash: 'a', thumbnail: null,
    saving: false, autosave: true, journal: { entries: [first] } });
  await saving;
  old.resolve(diff('colleague', 'a', [first]));
  expect(await pending).toBeNull();
  expect(s.store.state.savedBaseline).toEqual([first]);
  expect(s.store.state.comparisonBaseline).toBeNull();
  expect(s.store.state.journalComparison).toBeNull();
  expect(await s.registry.query({ query: 'query.journalComparison' })).toEqual(diff());
  expect(s.store.state.comparisonSource).toBe('saved');
});
