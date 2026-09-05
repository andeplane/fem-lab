// TutorialPanel and Tour against a fake registry: picking a tutorial, "do it for me",
// highlighting the target control, and the tour's dismissal. Preact batches a hook's state
// update past the current tick (the same reason `form.test.tsx` keeps a `flush` helper), so
// every assertion that follows a click or a direct `store` mutation awaits one first.
import type { JournalDump, ModelSummary, Registry } from '@femlab/registry';
import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store';
import { Tour } from '../src/tutorial/Tour';
import { TutorialPanel } from '../src/tutorial/TutorialPanel';

const flush = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const click = async (el: Element | null): Promise<void> => {
  el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await flush();
};

function fakeRegistry(): Registry & { dispatch: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn> } {
  const journal: JournalDump = { entries: [], revision: 0, canUndo: false, canRedo: false };
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
    await flush(); // let the panel's subscribe effect register before it is given anything to hear
    store.togglePanel('tutorial', true);
    await flush();
    expect(root.querySelector('.tutorial-panel')).not.toBeNull();
  });

  it('lists the built-in tutorials, and picking one shows its first step', async () => {
    const store = new Store();
    store.togglePanel('tutorial', true);
    render(<TutorialPanel registry={fakeRegistry()} store={store} />, root);
    await flush();
    const picks = [...root.querySelectorAll('.tutorial-pick')];
    expect(picks.length).toBeGreaterThanOrEqual(4);
    const cantilever = picks.find((p) => p.textContent?.includes('Cantilever beam'))!;
    await click(cantilever);
    expect(root.querySelector('.tutorial-step-title')?.textContent).toContain('Start a Model');
    expect(root.querySelector('.tutorial-progress')?.textContent).toContain('step 1 of');
  });

  it('"do it for me" dispatches the step Command through the registry and advances on the resulting Journal', async () => {
    const store = new Store();
    store.togglePanel('tutorial', true);
    const registry = fakeRegistry();
    render(<TutorialPanel registry={registry} store={store} />, root);
    await flush();
    await click(root.querySelector('.tutorial-pick'));
    await click(root.querySelector('.tutorial-btn.primary')); // "Do it for me"
    expect(registry.dispatch).toHaveBeenCalledOnce();
    expect(registry.query).toHaveBeenCalledWith({ query: 'query.journal' });
    expect(store.state.journal?.entries.length).toBe(1);
    // the Journal now satisfies step 1 (model.new), so the panel has moved to step 2
    expect(root.querySelector('.tutorial-progress')?.textContent).toContain('step 2 of');
  });

  it('highlights the control the step names, via data-tutorial-target', async () => {
    const target = document.createElement('button');
    target.setAttribute('data-cmd', 'model.new');
    document.body.append(target);
    const store = new Store();
    store.togglePanel('tutorial', true);
    render(<TutorialPanel registry={fakeRegistry()} store={store} />, root);
    await flush();
    const cantilever = [...root.querySelectorAll('.tutorial-pick')].find((p) => p.textContent?.includes('Cantilever beam'))!;
    await click(cantilever);
    await flush(200);
    expect(target.hasAttribute('data-tutorial-target')).toBe(true);
    target.remove();
  });

  it('Skip moves past a step without the Command ever appearing', async () => {
    const store = new Store();
    store.togglePanel('tutorial', true);
    render(<TutorialPanel registry={fakeRegistry()} store={store} />, root);
    await flush();
    await click(root.querySelector('.tutorial-pick'));
    expect(root.querySelector('.tutorial-progress')?.textContent).toContain('step 1 of');
    const skip = [...root.querySelectorAll('.tutorial-btn')].find((b) => b.textContent === 'Skip')!;
    await click(skip);
    expect(root.querySelector('.tutorial-progress')?.textContent).toContain('step 2 of');
  });
});

describe('Tour', () => {
  it('shows the first stop, and Skip tour dismisses it (persisted)', async () => {
    const tree = Object.assign(document.createElement('div'), { className: 'tree' });
    document.body.append(tree);
    const store = new Store();
    render(<Tour store={store} />, root);
    await flush();
    expect(root.querySelector('.tour-callout')).not.toBeNull();
    await click(root.querySelector('.tutorial-btn')); // "Skip tour"
    expect(root.querySelector('.tour-callout')).toBeNull();
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
    await flush();
    for (let i = 0; i < 4; i++) {
      await click(root.querySelector('.tutorial-btn.primary'));
    }
    const start = [...root.querySelectorAll('.tutorial-btn')].find((b) => b.textContent?.includes('Start the cantilever tutorial'))!;
    await click(start);
    expect(store.state.panels['tutorial']).toBe(true);
    expect(location.hash).toContain('tutorial=cantilever/0');
  });
});
