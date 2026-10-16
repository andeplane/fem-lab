import { EMPTY_ACCOUNT, FemError, type EngineSchema, type ProjectMeta, type ModelSummary } from '@femlab/registry';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import schema from '../../registry/src/generated/engine.schema.json';
import { readHostCaps } from '../src/capabilities';
import { StartupHost, startupWait, workspaceStatus } from '../src/startup';
import { Store } from '../src/store';
import { App } from '../src/ui/App';
import { afterEffects } from './wait-for';
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const projects: ProjectMeta[] = Array.from({ length: 7 }, (_, i) => ({ id: `${i}`, name: `saved ${i}`, at: 1, createdAt: 1, commands: i, hash: null, thumbnail: null }));
function setup(start: (signal: AbortSignal) => Promise<void> = async () => undefined, listProjects = async () => projects) {
  return new StartupHost({ schema: schema as unknown as EngineSchema, caps: readHostCaps({}), account: EMPTY_ACCOUNT, start, listProjects });
}
afterEach(() => { render(null, document.body); });

it.each(['old-result', 'old-failure'] as const)('clears account catalog synchronously and fences A → B → A %s publication', async outcome => {
  const a = deferred<ProjectMeta[]>(); const b = deferred<ProjectMeta[]>(); const latest = deferred<ProjectMeta[]>();
  const list = vi.fn(async () => projects).mockResolvedValueOnce(projects).mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise).mockImplementationOnce(() => latest.promise);
  const host = setup(async () => undefined, list); await host.loadProjects();
  expect(host.state.projects).toEqual(projects);
  host.setAccount({ ...EMPTY_ACCOUNT, uid: 'A', status: 'active' });
  expect(host.state.projects).toEqual([]); expect(host.state.catalog).toBe('loading');
  host.setAccount({ ...EMPTY_ACCOUNT, uid: 'B', status: 'active' });
  expect(host.state.projects).toEqual([]);
  host.setAccount({ ...EMPTY_ACCOUNT, uid: 'A', status: 'active' });
  expect(host.state.projects).toEqual([]); expect(list).toHaveBeenCalledTimes(4);
  const current = [{ ...projects[0]!, id: 'new-A', name: 'current account A' }];
  latest.resolve(current); await vi.waitFor(() => expect(host.state.catalog).toBe('ready'));
  if (outcome === 'old-result') { a.resolve([{ ...projects[0]!, id: 'stale-A' }]); b.reject(new Error('old B failure')); }
  else { a.reject(new Error('old A failure')); b.resolve([{ ...projects[0]!, id: 'stale-B' }]); }
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(host.state.account.uid).toBe('A'); expect(host.state.projects).toEqual(current); expect(host.state.catalog).toBe('ready'); expect(host.state.catalogError).toBeUndefined();
  expect(await host.registry.query({ query: 'query.projects' })).toEqual({ projects: current });
  host.setAccount({ ...EMPTY_ACCOUNT, uid: 'A', email: 'refreshed@example.test', status: 'active' });
  expect(list).toHaveBeenCalledTimes(4); expect(host.state.projects).toEqual(current);
});

it('clears catalog and stale errors on sign-out before anonymous storage finishes loading', async () => {
  const pending = deferred<ProjectMeta[]>();
  const list = vi.fn(async () => projects).mockRejectedValueOnce(new Error('anonymous storage old failure')).mockResolvedValueOnce(projects).mockImplementationOnce(() => pending.promise);
  const host = setup(async () => undefined, list); await host.loadProjects(); expect(host.state.catalogError).toBe('anonymous storage old failure');
  host.setAccount({ ...EMPTY_ACCOUNT, uid: 'A', status: 'active' });
  expect(host.state.catalogError).toBeUndefined(); await vi.waitFor(() => expect(host.state.projects).toEqual(projects));
  host.setAccount(EMPTY_ACCOUNT);
  expect(host.state.projects).toEqual([]); expect(host.state.catalog).toBe('loading'); expect(host.state.account.uid).toBeNull();
  pending.resolve([]); await vi.waitFor(() => expect(host.state.catalog).toBe('ready')); expect(host.state.projects).toEqual([]);
});

it('exposes validated startup actions and persisted metadata while rejecting every engine or model action', async () => {
  const run = deferred<void>(); const host = setup(() => run.promise); const starting = host.start(); await host.loadProjects();
  expect(await host.registry.query({ query: 'query.projects' })).toEqual({ projects });
  expect(await host.registry.query({ query: 'query.workspaceStatus' })).toEqual({ ready: false, phase: 'starting', attempt: 1 });
  for (const cmd of [{ cmd: 'project.open', id: '0' }, { cmd: 'model.new', name: 'early' }, { cmd: 'account.open' }, { cmd: 'panel.toggle', panel: 'examples' }]) await expect(host.registry.dispatch(cmd)).rejects.toMatchObject({ code: 'session.transitioning' });
  await expect(host.registry.query({ query: 'query.model' })).rejects.toMatchObject({ code: 'session.transitioning' });
  await expect(host.registry.dispatch({ cmd: 'form.open' })).rejects.toMatchObject({ code: 'schema' });
  host.cancel(); run.reject(new FemError('cancelled', 'cancelled')); await expect(starting).rejects.toMatchObject({ code: 'cancelled' });
});
it('waits for cancelled work to settle before retry, uses a fresh signal, and expires retained startup invocations', async () => {
  const runs: { signal: AbortSignal; task: ReturnType<typeof deferred<void>> }[] = [];
  const host = setup(signal => { const task = deferred<void>(); runs.push({ signal, task }); return task.promise; });
  const first = host.start(); await expect(host.start()).rejects.toMatchObject({ code: 'session.transitioning' }); host.cancel();
  expect(runs[0]!.signal.aborted).toBe(true); expect(host.state.startup?.phase).toBe('cancelling');
  await expect(host.registry.dispatch({ cmd: 'workspace.retryStartup' })).rejects.toMatchObject({ code: 'session.transitioning' });
  runs[0]!.task.reject(runs[0]!.signal.reason); await expect(first).rejects.toMatchObject({ code: 'cancelled' }); expect(host.state.startup?.phase).toBe('cancelled');
  const retry = host.registry.dispatch({ cmd: 'workspace.retryStartup' }); expect(runs[1]!.signal).not.toBe(runs[0]!.signal); expect(host.state.startup?.attempt).toBe(2);
  host.retire(); runs[1]!.task.resolve(); await retry;
  await expect(host.registry.query({ query: 'query.projects' })).rejects.toMatchObject({ code: 'session.expired' });
  await expect(host.registry.dispatch({ cmd: 'workspace.cancelStartup' })).rejects.toMatchObject({ code: 'session.expired' }); expect(workspaceStatus(true)).toEqual({ ready: true, phase: 'ready' });
});
it('separates storage failure from the structured retryable Worker failure', async () => {
  const host = setup(async () => { throw new FemError('internal', 'Worker failed', 'engine.worker'); }, async () => { throw new Error('storage blocked'); });
  await host.loadProjects(); expect(host.state.catalog).toBe('failed'); expect(host.state.catalogError).toBe('storage blocked');
  await expect(host.start()).rejects.toMatchObject({ code: 'internal' }); expect(host.state.lastError).toEqual({ code: 'internal', cause: 'Worker failed', where: 'engine.worker', suggestion: null });
  expect(host.state.startup?.phase).toBe('failed'); await expect(host.start()).rejects.toMatchObject({ code: 'internal' }); expect(host.state.startup?.attempt).toBe(2);
  expect(() => host.cancel()).toThrow('session.conflict');
});
it('observes late adapter rejection after cancellation without allowing engine creation', async () => {
  const probe = deferred<unknown>(); const controller = new AbortController(); const spawn = vi.fn(); const pending = startupWait(probe.promise, controller.signal).then(spawn);
  controller.abort(new FemError('cancelled', 'stop')); await expect(pending).rejects.toMatchObject({ code: 'cancelled' }); probe.reject(new Error('late adapter failure')); await Promise.resolve(); expect(spawn).not.toHaveBeenCalled();
  await expect(startupWait(Promise.reject(new Error('late')), controller.signal)).rejects.toMatchObject({ code: 'cancelled' }); expect(await startupWait(Promise.resolve(42), new AbortController().signal)).toBe(42);
});
it('preserves the same Start DOM, drafts, focus and expanded Recent when the first real session is published', async () => {
  const run = deferred<void>(); const host = setup(() => run.promise); await host.loadProjects(); const pending = host.start();
  await act(() => { render(<App startup={host} />, document.body); });
  const name = document.querySelector<HTMLInputElement>('[aria-label="project name"]')!; const ask = document.querySelector<HTMLInputElement>('[aria-label="describe the part"]')!;
  await act(() => { name.value = 'kept draft'; name.dispatchEvent(new Event('input', { bubbles: true })); ask.value = 'kept question'; ask.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector<HTMLElement>('.show-all')!.click(); }); name.focus();
  expect(document.querySelectorAll('.recent')).toHaveLength(7);
  for (const node of document.querySelectorAll<HTMLButtonElement>('button[data-cmd]')) { expect(() => host.registry.describe(node.dataset['cmd']!)).not.toThrow(); if (!node.dataset['cmd']!.startsWith('workspace.')) expect(node.disabled).toBe(true); }
  const store = new Store(); store.set({ ready: true, projects, hostCaps: readHostCaps({}) }); host.retire(); run.resolve(); await pending;
  await act(() => { render(<App store={store} dispatch={async () => undefined} viewer={{ current: null }} sessionKey="real-epoch" />, document.body); });
  expect(document.querySelector('[aria-label="project name"]')).toBe(name); expect(document.querySelector('[aria-label="describe the part"]')).toBe(ask);
  expect(name.value).toBe('kept draft'); expect(ask.value).toBe('kept question'); expect(document.activeElement).toBe(name); expect(document.querySelectorAll('.recent')).toHaveLength(7);
  expect(document.querySelector<HTMLButtonElement>('[data-cmd="project.new"]')!.disabled).toBe(false); expect(document.querySelector('.startup-status')).toBeNull();
});

function startedModel(withBody: boolean): ModelSummary {
  return { name: 'local', revision: 1, hash: 'active', units: { length: 'm' }, idealisation: 'solid3d',
    bodies: withBody ? [{ name: 'committed', bbox: [{ value: 0, unit: 'm' }, { value: 0, unit: 'm' }, { value: 0, unit: 'm' }, { value: 0.001, unit: 'm' }, { value: 0.002, unit: 'm' }, { value: 0.003, unit: 'm' }], measure: { value: 6e-9, unit: 'm^3' }, faces: [] }] : [],
    materials: [], sets: [], constraints: [], connections: [], loads: [], steps: [], warnings: [] };
}
function mountWorkspace(model: ModelSummary) {
  const store = new Store(); store.set({ model, revision: model.revision, ready: true });
  render(<App store={store} dispatch={async () => undefined} viewer={{ current: null }} />, document.body);
  return store;
}
it('offers the starter geometry form when a person opens an empty local Model', async () => {
  const store = mountWorkspace(startedModel(false));
  await afterEffects();
  expect(store.state.form).toMatchObject({ cmd: 'geometry.addBox', values: { name: 'body', size: ['1 m', '100 mm', '100 mm'] } });
});
it('does not invent a starter draft when the first workspace entry already has geometry', async () => {
  const store = mountWorkspace(startedModel(true));
  await afterEffects();
  expect(store.state.form).toBeNull();
});
it('checks the live Model before a delayed starter effect, after geometry arrives between render and effects', async () => {
  const store = mountWorkspace(startedModel(false));
  // Preact has rendered the empty Model, but its after-paint effect has not run yet.
  store.set({ model: startedModel(true) });
  await afterEffects();
  expect(store.state.form).toBeNull();
});
it('preserves an explicit geometry edit instead of replacing it with the starter body', async () => {
  const store = new Store(); store.set({ model: startedModel(true), revision: 1, ready: true });
  store.openForm('geometry.addBox', { name: 'committed', size: ['2 mm', '2 mm', '3 mm'] }, false, { kind: 'body', name: 'committed' });
  const form = store.state.form;
  render(<App store={store} dispatch={async () => undefined} viewer={{ current: null }} />, document.body);
  await afterEffects();
  expect(store.state.form).toBe(form);
});
