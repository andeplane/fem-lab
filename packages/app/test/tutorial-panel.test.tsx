// TutorialPanel and Tour against a fake registry: picking a tutorial, "do it for me",
// highlighting the target control, and the tour's dismissal. Preact batches a hook's state
// update past the current tick, so every assertion that follows a click or a direct `store`
// mutation polls for what it is about to check (`./wait-for`) rather than sleeping for a
// guessed number of milliseconds.
import type { JournalDump, ModelSummary, Registry } from '@femlab/registry';
import { render } from 'preact';
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

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.append(root);
  localStorage.clear();
  location.hash = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

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
