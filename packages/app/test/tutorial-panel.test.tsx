// TutorialPanel and Tour against a fake registry: picking a tutorial, "do it for me",
// highlighting the target control, and the tour's dismissal. Preact batches a hook's state
// update past the current tick, so every assertion that follows a click or a direct `store`
// mutation polls for what it is about to check (`./wait-for`) rather than sleeping for a
// guessed number of milliseconds.
import type { JournalDump, ModelSummary, Registry } from '@femlab/registry';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store';
import { afterEffects, waitFor, waitForGone, waitForText } from './wait-for';
import { Tour } from '../src/tutorial/Tour';
import { TutorialPanel } from '../src/tutorial/TutorialPanel';

const click = async (el: Element | null): Promise<void> => {
  el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await afterEffects();
};
const progress = () => root.querySelector('.tutorial-progress');

function fakeRegistry(): Registry & { dispatch: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn> } {
  const journal: JournalDump = { hash: 'empty', entries: [], revision: 0, canUndo: false, canRedo: false };
  const model: ModelSummary = { name: 'm', revision: 0 } as unknown as ModelSummary;
  const dispatch = vi.fn(async (cmd: { cmd: string } & Record<string, unknown>) => {
    journal.entries = [...journal.entries, { seq: journal.entries.length, cmd, hashAfter: `h${journal.entries.length}` } as never];
    journal.revision = journal.entries.length;
    return { seq: journal.entries.length - 1 };
  });
  const query = vi.fn(async (q: { query: string }) => (q.query === 'query.journal' ? journal : model));
  return { dispatch, query } as unknown as Registry & { dispatch: typeof dispatch; query: typeof query };
}

/**
 * What `main.tsx` puts on `store.dispatch`: run the Command, then put the new Journal on the
 * Store — the panel watches the Store, never the registry, so this is the whole of `refresh`
 * that the tutorial can see (issue #12). `hold` lets a test stop the dispatch mid-flight and
 * check that "Do it for me" is disabled while it is in the air.
 */
function storeDispatch(store: Store, hold?: () => Promise<void>) {
  const calls: { cmd: string }[] = [];
  const dispatch = async (cmd: { cmd: string } & Record<string, unknown>): Promise<unknown> => {
    calls.push(cmd);
    if (hold) await hold();
    const entries = [...(store.state.journal?.entries ?? []), { seq: store.state.journal?.entries.length ?? 0, cmd, hashAfter: 'h' } as never];
    store.set({ journal: { entries, revision: entries.length, canUndo: true, canRedo: false } as never });
    return { seq: entries.length - 1 };
  };
  store.dispatch = dispatch;
  return calls;
}

/** Put a Journal on the Store the way a refresh would, with no dispatch involved. */
const journalOf = (store: Store, cmds: ({ cmd: string } & Record<string, unknown>)[]): void =>
  store.set({ journal: { entries: cmds.map((cmd, seq) => ({ seq, cmd, hashAfter: `h${seq}` })), revision: cmds.length, canUndo: true, canRedo: false } as never });

let root: HTMLElement;

async function cleanupTutorialFixtures(): Promise<void> {
  await act(async () => {
    render(null, root);
  });
  document.body.replaceChildren();
}

beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement('div');
  document.body.append(root);
  localStorage.clear();
  location.hash = '';
});

afterEach(cleanupTutorialFixtures);

describe('TutorialPanel', () => {
  it('is invisible until the tutorial panel is open', async () => {
    const store = new Store();
    render(<TutorialPanel registry={fakeRegistry()} store={store} />, root);
    expect(root.querySelector('.tutorial-panel')).toBeNull();
    // The panel's subscribe effect has to register before it is given anything to hear.
    await afterEffects();
    store.togglePanel('tutorial', true);
    await waitFor(() => root.querySelector('.tutorial-panel'), 'the tutorial panel');
  });

  it('lists the built-in tutorials, and picking one shows its first step', async () => {
    const store = new Store();
    store.togglePanel('tutorial', true);
    render(<TutorialPanel registry={fakeRegistry()} store={store} />, root);
    await afterEffects();
    const picks = await waitFor(() => {
      const found = [...root.querySelectorAll('.tutorial-pick')];
      return found.length >= 4 ? found : null;
    }, 'four tutorials to list');
    await click(picks.find((p) => p.textContent?.includes('Cantilever beam'))!);
    await waitForText(() => root.querySelector('.tutorial-step-title'), 'Start a Model');
    await waitForText(progress, 'step 1 of');
  });

  it('"do it for me" dispatches the step Command through the registry and advances on the resulting Journal', async () => {
    const store = new Store();
    store.togglePanel('tutorial', true);
    const registry = fakeRegistry();
    render(<TutorialPanel registry={registry} store={store} />, root);
    await afterEffects();
    await click(await waitFor(() => root.querySelector('.tutorial-pick'), 'a tutorial to pick'));
    await click(await waitFor(() => root.querySelector('.tutorial-btn.primary'), '"Do it for me"'));
    // The Journal now satisfies step 1 (model.new), so the panel moves to step 2.
    await waitForText(progress, 'step 2 of');
    expect(registry.dispatch).toHaveBeenCalledOnce();
    expect(registry.query).toHaveBeenCalledWith({ query: 'query.journal' });
    expect(store.state.journal?.entries.length).toBe(1);
  });

  it('highlights the control the step names, via data-tutorial-target', async () => {
    const target = document.createElement('button');
    target.setAttribute('data-cmd', 'model.new');
    document.body.append(target);
    const store = new Store();
    store.togglePanel('tutorial', true);
    render(<TutorialPanel registry={fakeRegistry()} store={store} />, root);
    await afterEffects();
    const cantilever = await waitFor(() => [...root.querySelectorAll('.tutorial-pick')].find((p) => p.textContent?.includes('Cantilever beam')), 'the cantilever tutorial');
    await click(cantilever);
    await waitFor(() => target.hasAttribute('data-tutorial-target'), 'the target to be highlighted');
    target.remove();
  });

  it('goes through the app\'s own dispatch when the Store carries one, and advances on its Journal', async () => {
    const store = new Store();
    store.togglePanel('tutorial', true);
    const registry = fakeRegistry();
    const calls = storeDispatch(store);
    render(<TutorialPanel registry={registry} store={store} />, root);
    await afterEffects();
    await click(await waitFor(() => root.querySelector('.tutorial-pick'), 'a tutorial to pick'));
    await click(await waitFor(() => root.querySelector('.tutorial-btn.primary'), '"Do it for me"'));
    await waitForText(progress, 'step 2 of');
    expect(calls.map((c) => c.cmd)).toEqual(['model.new']);
    expect(registry.dispatch).not.toHaveBeenCalled(); // issue #12: never the bare registry
    expect(registry.query).not.toHaveBeenCalled(); // the app's dispatch already refreshed
  });

  it('disables "Do it for me" while the Command is in the air, and re-enables it after', async () => {
    const store = new Store();
    store.togglePanel('tutorial', true);
    let release = (): void => undefined;
    storeDispatch(store, () => new Promise<void>((r) => (release = r)));
    render(<TutorialPanel registry={fakeRegistry()} store={store} />, root);
    await afterEffects();
    await click(await waitFor(() => root.querySelector('.tutorial-pick'), 'a tutorial to pick'));
    const doIt = (): HTMLButtonElement | null => root.querySelector<HTMLButtonElement>('.tutorial-btn.primary');
    await click(await waitFor(doIt, '"Do it for me"'));
    await waitFor(() => doIt()?.disabled === true, 'the button to be disabled while pending');
    release();
    await waitForText(progress, 'step 2 of');
    await waitFor(() => doIt()?.disabled === false, 'the button to be enabled again');
  });

  it('advances a step whose Command is already in the Journal, without dispatching it', async () => {
    const store = new Store();
    store.togglePanel('tutorial', true);
    const calls = storeDispatch(store);
    render(<TutorialPanel registry={fakeRegistry()} store={store} />, root);
    await afterEffects();
    await click(await waitFor(() => [...root.querySelectorAll('.tutorial-pick')].find((p) => p.textContent?.includes('Cantilever beam')), 'the cantilever tutorial'));
    await waitForText(progress, 'step 1 of');
    // The person ran the first three Commands themselves; one Journal read walks all three.
    journalOf(store, [{ cmd: 'model.new', name: 'cantilever' }, { cmd: 'model.setUnits' }, { cmd: 'geometry.addBox', name: 'beam' }]);
    await waitForText(progress, 'step 4 of');
    expect(calls).toEqual([]);
  });

  // Issue #87 A, through the real panel: `model.new` rewrites the Journal shorter, and the
  // step the tutorial is on has to stay reachable afterwards.
  it('keeps advancing after a mid-tutorial model.new truncates the Journal', async () => {
    const store = new Store();
    store.togglePanel('tutorial', true);
    storeDispatch(store);
    render(<TutorialPanel registry={fakeRegistry()} store={store} />, root);
    await afterEffects();
    await click(await waitFor(() => [...root.querySelectorAll('.tutorial-pick')].find((p) => p.textContent?.includes('Cantilever beam')), 'the cantilever tutorial'));
    journalOf(store, [{ cmd: 'model.new', name: 'cantilever' }, { cmd: 'model.setUnits' }, { cmd: 'geometry.addBox', name: 'beam' }]);
    await waitForText(progress, 'step 4 of');
    // A second `model.new` resets the Journal to one entry, re-using seq 0.
    journalOf(store, [{ cmd: 'model.new', name: 'again' }]);
    await waitForText(progress, 'step 4 of'); // nothing satisfies it yet, and nothing stalls
    journalOf(store, [{ cmd: 'model.new', name: 'again' }, { cmd: 'material.add', name: 'steel' }]);
    await waitForText(progress, 'step 5 of');
  });

  it('anchors the card beside the target and draws the spotlight over it (issues #38, #46)', async () => {
    const target = document.createElement('button');
    target.setAttribute('data-cmd', 'model.new');
    target.textContent = 'New model';
    document.body.append(target);
    const store = new Store();
    store.togglePanel('tutorial', true);
    render(<TutorialPanel registry={fakeRegistry()} store={store} />, root);
    await afterEffects();
    await click(await waitFor(() => [...root.querySelectorAll('.tutorial-pick')].find((p) => p.textContent?.includes('Cantilever beam')), 'the cantilever tutorial'));
    const card = await waitFor(() => root.querySelector<HTMLElement>('.tutorial-panel.anchored'), 'the card to anchor');
    expect(card.getAttribute('style')).toMatch(/left: *\d+px; *top: *\d+px/);
    expect(card.getAttribute('data-side')).toBe('right');
    expect(root.querySelector('.tutorial-spot')).not.toBeNull();
    // and it names the control in the app's own words rather than the Command id
    expect(root.querySelector('.tutorial-where')!.textContent).toContain('New model');
    target.remove();
  });

  it('lists the values the step expects, and offers them to the form as hints (issue #46)', async () => {
    const store = new Store();
    store.togglePanel('tutorial', true);
    render(<TutorialPanel registry={fakeRegistry()} store={store} />, root);
    await afterEffects();
    await click(await waitFor(() => [...root.querySelectorAll('.tutorial-pick')].find((p) => p.textContent?.includes('Cantilever beam')), 'the cantilever tutorial'));
    await waitForText(() => root.querySelector('.tutorial-values'), 'cantilever');
    await waitFor(() => store.state.formHints, 'the form hints on the store');
    expect(store.state.formHints).toEqual({ name: 'cantilever' });
    // step 3 is `geometry.addBox`, whose size is three lengths: one hint per input
    await click([...root.querySelectorAll('.tutorial-btn')].find((b) => b.textContent === 'Skip')!);
    await click([...root.querySelectorAll('.tutorial-btn')].find((b) => b.textContent === 'Skip')!);
    await waitFor(() => (store.state.formHints?.['size.0'] === undefined ? null : true), 'the box size hints');
    expect(store.state.formHints).toEqual({ name: 'beam', 'size.0': '1 m', 'size.1': '100 mm', 'size.2': '100 mm' });
  });

  it('takes its hints off the store again when the tutorial is closed', async () => {
    const store = new Store();
    store.togglePanel('tutorial', true);
    render(<TutorialPanel registry={fakeRegistry()} store={store} />, root);
    await afterEffects();
    await click(await waitFor(() => root.querySelector('.tutorial-pick'), 'a tutorial to pick'));
    await waitFor(() => store.state.formHints, 'the form hints on the store');
    await click(root.querySelector('.tutorial-close'));
    await waitFor(() => store.state.formHints === null, 'the hints to be cleared');
  });

  it('stays docked when the step names a control that is nowhere on the page', async () => {
    const store = new Store();
    store.togglePanel('tutorial', true);
    render(<TutorialPanel registry={fakeRegistry()} store={store} />, root);
    await afterEffects();
    await click(await waitFor(() => [...root.querySelectorAll('.tutorial-pick')].find((p) => p.textContent?.includes('Cantilever beam')), 'the cantilever tutorial'));
    await waitForText(progress, 'step 1 of');
    expect(root.querySelector('.tutorial-panel.anchored')).toBeNull();
    expect(root.querySelector('.tutorial-spot')).toBeNull();
  });

  it('disposes a pending spotlight retry and its listeners before removing the DOM', async () => {
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const cleared = vi.spyOn(globalThis, 'clearInterval');
    const removed = vi.spyOn(globalThis, 'removeEventListener');
    try {
      render(<TutorialPanel registry={fakeRegistry()} store={new Store()} />, root);
      await afterEffects();
      const retryIndex = intervals.mock.calls.findIndex(([, delay]) => delay === 150);
      const retry = intervals.mock.results[retryIndex]?.value as ReturnType<typeof setInterval>;
      expect(retry).toBeDefined();

      await cleanupTutorialFixtures();

      expect(cleared).toHaveBeenCalledWith(retry);
      expect(removed).toHaveBeenCalledWith('resize', expect.any(Function));
      expect(removed).toHaveBeenCalledWith('scroll', expect.any(Function), true);
      expect(document.body.children).toHaveLength(0);
    } finally {
      intervals.mockRestore();
      cleared.mockRestore();
      removed.mockRestore();
    }
  });

  it('moves focus to the target when nobody is typing, and never while somebody is', async () => {
    const props = Object.assign(document.createElement('aside'), { className: 'props' });
    const typing = document.createElement('input');
    props.append(typing);
    const target = document.createElement('button');
    target.setAttribute('data-cmd', 'model.new');
    document.body.append(props, target);
    const store = new Store();
    store.togglePanel('tutorial', true);
    render(<TutorialPanel registry={fakeRegistry()} store={store} />, root);
    await afterEffects();
    typing.focus();
    await click(await waitFor(() => [...root.querySelectorAll('.tutorial-pick')].find((p) => p.textContent?.includes('Cantilever beam')), 'the cantilever tutorial'));
    await waitFor(() => target.hasAttribute('data-tutorial-target'), 'the target to be highlighted');
    expect(document.activeElement).toBe(typing); // the person was mid-edit: leave them alone
    props.remove();
    target.remove();
  });

  it('Skip moves past a step without the Command ever appearing', async () => {
    const store = new Store();
    store.togglePanel('tutorial', true);
    render(<TutorialPanel registry={fakeRegistry()} store={store} />, root);
    await afterEffects();
    await click(await waitFor(() => root.querySelector('.tutorial-pick'), 'a tutorial to pick'));
    await waitForText(progress, 'step 1 of');
    await click([...root.querySelectorAll('.tutorial-btn')].find((b) => b.textContent === 'Skip')!);
    await waitForText(progress, 'step 2 of');
  });
});

describe('Tour', () => {
  it('shows the first stop, and Skip tour dismisses it (persisted)', async () => {
    const tree = Object.assign(document.createElement('div'), { className: 'tree' });
    document.body.append(tree);
    const store = new Store();
    render(<Tour store={store} />, root);
    await afterEffects();
    await waitFor(() => root.querySelector('.tour-callout'), 'the first tour stop');
    await click(root.querySelector('.tutorial-btn')); // "Skip tour"
    await waitForGone(() => root.querySelector('.tour-callout'), 'the tour callout');
    expect(localStorage.getItem('femlab.tour.dismissed')).toBe('1');
    tree.remove();
  });

  it('stays dismissed across a remount', () => {
    localStorage.setItem('femlab.tour.dismissed', '1');
    const store = new Store();
    render(<Tour store={store} />, root);
    expect(root.querySelector('.tour-callout')).toBeNull();
  });

  it('the last stop starts the cantilever tutorial and opens the panel', async () => {
    const store = new Store();
    render(<Tour store={store} />, root);
    await afterEffects();
    for (let i = 0; i < 4; i++) {
      await click(await waitFor(() => root.querySelector('.tutorial-btn.primary'), `tour stop ${i + 1}`));
    }
    await click(await waitFor(() => [...root.querySelectorAll('.tutorial-btn')].find((b) => b.textContent?.includes('Start the cantilever tutorial')), 'the tutorial hand-off'));
    await waitFor(() => store.state.panels['tutorial'] === true, 'the tutorial panel to open');
    expect(location.hash).toContain('tutorial=cantilever/0');
  });
});
