import { describe, expect, it, vi } from 'vitest';
import { WorkspaceNavigation, browserNavigationHistory, readWorkspaceRoute, workspaceHash, type NavigationWorkspace } from '../src/navigation';

function fixture(hash = '#/') {
  let value = hash;
  const writes: { hash: string; replace: boolean }[] = [];
  const state = { id: null as string | null, home: true, examples: false };
  const show = vi.fn<NavigationWorkspace['show']>(page => { state.home = page === 'home'; state.examples = page === 'examples'; });
  const open = vi.fn<NavigationWorkspace['open']>(async (id, signal) => { signal.throwIfAborted(); state.id = id; });
  const fail = vi.fn();
  let changed = () => {};
  const detach = vi.fn();
  const navigation = new WorkspaceNavigation({
    hash: () => value,
    write: (hash, replace) => { value = hash; writes.push({ hash, replace }); },
    listen: listener => { changed = listener; return detach; },
  }, { current: () => state, show, open, fail });
  return { navigation, state, show, open, fail, writes, detach, hash: () => value, change: (hash: string) => { value = hash; changed(); }, setHash: (hash: string) => { value = hash; } };
}

describe('workspace routes', () => {
  it('round-trips encoded project identifiers and leaves existing Journal and tutorial links alone', () => {
    for (const id of ['cloud-abcd', 'with spaces/#?%å']) expect(readWorkspaceRoute(workspaceHash({ page: 'project', id }))).toEqual({ page: 'project', id });
    expect(readWorkspaceRoute('#/examples')).toEqual({ page: 'examples' });
    expect(readWorkspaceRoute('')).toEqual({ page: 'home' });
    expect(readWorkspaceRoute('#j=abc')).toBeNull();
    expect(readWorkspaceRoute('#tutorial=cantilever/2')).toBeNull();
    for (const hash of ['#/missing', '#/projects/', '#/projects/%E0', '#/projects/a/b']) expect(() => readWorkspaceRoute(hash)).toThrow();
  });

  it('restores a deep link once and preserves the active document when returning from the menu', async () => {
    const f = fixture('#/projects/saved');
    await f.navigation.start();
    expect(f.open.mock.calls.map(call => call[0])).toEqual(['saved']);
    expect(f.show).toHaveBeenLastCalledWith('workspace');
    f.state.home = true; f.navigation.record();
    expect(f.hash()).toBe('#/');
    f.setHash('#/projects/saved'); await f.navigation.restore();
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.show).toHaveBeenLastCalledWith('workspace');
    expect(f.writes).toEqual([{ hash: '#/', replace: false }]);
    f.navigation.record();
    expect(f.writes).toHaveLength(1);
  });

  it('records gallery and newly activated project entries without history duplication', async () => {
    const f = fixture('');
    await f.navigation.start();
    expect(f.writes).toEqual([{ hash: '#/', replace: true }]);
    f.state.examples = true; f.navigation.record(); f.navigation.record();
    expect(f.hash()).toBe('#/examples');
    f.state.examples = false; f.state.home = false; f.state.id = 'new'; f.navigation.record();
    expect(f.hash()).toBe('#/projects/new');
    expect(f.writes).toHaveLength(3);
    expect(f.open).not.toHaveBeenCalled();
  });

  it('returns to the menu with a visible error for missing projects or invalid routes', async () => {
    for (const hash of ['#/projects/missing', '#/unknown']) {
      const f = fixture(hash); f.open.mockRejectedValue(new Error('not available to this owner'));
      await f.navigation.start();
      expect(f.hash()).toBe('#/'); expect(f.show).toHaveBeenLastCalledWith('home'); expect(f.fail).toHaveBeenCalledTimes(1);
    }
  });

  it('serializes rapid traversal and lets the last requested route win', async () => {
    const f = fixture(); await f.navigation.start();
    let complete!: () => void;
    f.open.mockImplementation(async id => { await new Promise<void>(resolve => { complete = resolve; }); f.state.id = id; });
    f.setHash('#/projects/slow'); const first = f.navigation.restore();
    await Promise.resolve();
    f.setHash('#/examples'); const second = f.navigation.restore();
    complete(); await Promise.all([first, second]);
    expect(f.show).toHaveBeenLastCalledWith('examples'); expect(f.hash()).toBe('#/examples'); expect(f.writes).toEqual([]);
  });

  it('invalidates pending private opens on identity reset and detaches on disposal', async () => {
    const f = fixture(); await f.navigation.start();
    let complete!: () => void;
    f.open.mockImplementation(async () => { await new Promise<void>(resolve => { complete = resolve; }); throw new Error('expired owner'); });
    f.setHash('#/projects/private'); const opening = f.navigation.restore(); await Promise.resolve();
    f.navigation.reset(); complete(); await opening;
    expect(f.hash()).toBe('#/'); expect(f.fail).not.toHaveBeenCalled(); expect(f.show).toHaveBeenLastCalledWith('home');
    f.navigation.dispose(); f.change('#/projects/other'); await f.navigation.restore();
    expect(f.open).toHaveBeenCalledTimes(1); expect(f.detach).toHaveBeenCalledOnce();
  });

  it('lets an explicit menu action cancel a pending history open without losing the current document', async () => {
    const f = fixture(); await f.navigation.start(); f.state.id = 'current'; f.state.home = false;
    let complete!: () => void;
    f.open.mockImplementation(async (id, signal) => { await new Promise<void>(resolve => { complete = resolve; }); signal.throwIfAborted(); f.state.id = id; });
    f.setHash('#/projects/slow'); const opening = f.navigation.restore(); await Promise.resolve();
    f.state.home = true; f.navigation.record();
    expect(f.open.mock.calls[0]![1].aborted).toBe(true);
    complete(); await opening;
    expect(f.hash()).toBe('#/'); expect(f.state.id).toBe('current'); expect(f.fail).not.toHaveBeenCalled();
  });

  it('keeps the hosting directory and auth query when writing browser history', () => {
    const pushState = vi.fn(), replaceState = vi.fn(), addEventListener = vi.fn(), removeEventListener = vi.fn();
    const browser = { location: { pathname: '/fem-lab/', search: '?auth=return', hash: '#/' }, history: { pushState, replaceState }, addEventListener, removeEventListener };
    const history = browserNavigationHistory(browser as unknown as Window);
    history.write('#/examples', false); history.write('#/', true);
    expect(pushState).toHaveBeenCalledWith(null, '', '/fem-lab/?auth=return#/examples');
    expect(replaceState).toHaveBeenCalledWith(null, '', '/fem-lab/?auth=return#/');
    const changed = vi.fn(); const stop = history.listen(changed); stop();
    expect(addEventListener.mock.calls.map(call => call[0])).toEqual(['popstate', 'hashchange']);
    expect(removeEventListener.mock.calls.map(call => call[0])).toEqual(['popstate', 'hashchange']);
    expect(history.hash()).toBe('#/');
  });
});
