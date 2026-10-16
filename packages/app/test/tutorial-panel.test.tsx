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
import { bindRegistryProducer } from '../src/producer-registry';
import { afterEffects, waitFor, waitForGone, waitForText } from './wait-for';
import { Tour } from '../src/tutorial/Tour';
import { tourCommands, TOUR_DISMISSED_KEY, TOUR_STOPS, type TourHost } from '../src/tutorial/tour-state';
import { TutorialPanel } from '../src/tutorial/TutorialPanel';
import { tutorialById } from '../src/tutorial/tutorials';

const click = async (el: Element | null): Promise<void> => {
  el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await afterEffects();
};
const progress = () => root.querySelector('.tutorial-progress');

function fakeRegistry(): Registry & { dispatch: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn> } {
  const journal: JournalDump = { hash: 'empty', entries: [], revision: 0, canUndo: false, canRedo: false };
  const model: ModelSummary = { name: 'm', revision: 0, bodies: [] } as unknown as ModelSummary;
  const dispatch = vi.fn(async (cmd: { cmd: string } & Record<string, unknown>) => {
    if (cmd.cmd === 'model.new') journal.entries = [];
    journal.entries = [...journal.entries, { seq: journal.entries.length, cmd, hashAfter: `h${journal.entries.length}` } as never];
    journal.revision = journal.entries.length;
    return { seq: journal.entries.length - 1 };
  });
  const query = vi.fn(async (q: { query: string }) => (q.query === 'query.journal' ? journal : model));
  const registry = { dispatch, query } as unknown as Registry & { dispatch: typeof dispatch; query: typeof query };
  bindRegistryProducer(registry, async () => ({ registry, signal: new AbortController().signal, store: () => undefined, release: async () => undefined }));
  return registry;
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

function withProducer(store: Store, registry = fakeRegistry()): Registry {
  bindRegistryProducer(registry, async () => ({ registry: { ...registry, dispatch: store.dispatch! } as unknown as Registry,
    signal: new AbortController().signal, store: () => store, release: async () => undefined }));
  return registry;
}

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

  it.each([1, 16])('starts a second tutorial over a %i-entry Model and advances after one replacement', async (count) => {
    const store = new Store();
    store.togglePanel('tutorial', true);
    journalOf(store, Array.from({ length: count }, (_, i) => i === 0 ? { cmd: 'model.new', name: 'previous' } : { cmd: 'model.setUnits' }));
    const registry = fakeRegistry();
    render(<TutorialPanel registry={registry} store={store} />, root);
    await afterEffects();
    await click(await waitFor(() => [...root.querySelectorAll('.tutorial-pick')].find((p) => p.textContent?.includes('Column buckling')), 'the column tutorial'));
    await waitForText(progress, 'step 1 of');
    expect(registry.dispatch).not.toHaveBeenCalled();
    await click(root.querySelector('.tutorial-btn.primary'));
    await waitForText(progress, 'step 2 of');
    expect(registry.dispatch).toHaveBeenCalledExactlyOnceWith({ cmd: 'model.new', name: 'column-buckling' });
    expect(store.state.journal?.entries).toHaveLength(1);
    expect(store.state.journal?.entries[0]?.cmd).toEqual({ cmd: 'model.new', name: 'column-buckling' });
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

  it('uses its captured producer dispatch and advances on the published Journal', async () => {
    const store = new Store();
    store.togglePanel('tutorial', true);
    const registry = fakeRegistry();
    const calls = storeDispatch(store);
    withProducer(store, registry);
    render(<TutorialPanel registry={registry} store={store} />, root);
    await afterEffects();
    await click(await waitFor(() => root.querySelector('.tutorial-pick'), 'a tutorial to pick'));
    await click(await waitFor(() => root.querySelector('.tutorial-btn.primary'), '"Do it for me"'));
    await waitForText(progress, 'step 2 of');
    expect(calls.map((c) => c.cmd)).toEqual(['model.new']);
    expect(registry.dispatch).not.toHaveBeenCalled(); // issue #12: never the bare registry
    expect(registry.query).toHaveBeenCalledWith({ query: 'query.journal' }); // explicit observation before writing
  });

  it('disables "Do it for me" while the Command is in the air, and re-enables it after', async () => {
    const store = new Store();
    store.togglePanel('tutorial', true);
    let release = (): void => undefined;
    storeDispatch(store, () => new Promise<void>((r) => (release = r)));
    render(<TutorialPanel registry={withProducer(store)} store={store} />, root);
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

  it('renders the concrete slab closing theory as paragraphs, maths, bold, code and bullets', async () => {
    const store = new Store();
    store.togglePanel('tutorial', true);
    render(<TutorialPanel registry={fakeRegistry()} store={store} />, root);
    await afterEffects();
    await click(await waitFor(() => [...root.querySelectorAll('.tutorial-pick')].find((p) => p.textContent?.includes('Concrete floor slab')), 'the concrete slab tutorial'));
    const tutorial = tutorialById('concrete-floor-slab')!;
    for (let i = 0; i < tutorial.steps.length - 1; i++) {
      await click([...root.querySelectorAll('.tutorial-btn')].find((b) => b.textContent === 'Skip')!);
    }
    const theory = await waitFor(() => root.querySelector('.tutorial-theory'), 'the closing theory');
    expect(theory.querySelectorAll('.katex').length).toBeGreaterThan(10);
    expect(theory.querySelector('.katex-display')).not.toBeNull();
    expect(theory.querySelector('strong')?.textContent).toBe('The load.');
    expect(theory.querySelector('code')?.textContent).toBe('bearing-a');
    expect(theory.querySelectorAll('li')).toHaveLength(3);
    expect(theory.querySelectorAll('.theory-copy > p').length).toBeGreaterThan(5);
    expect(theory.textContent).not.toContain('$');
    expect(theory.textContent).not.toContain('**');
    expect(theory.tagName).not.toBe('PRE');
  });

  it('keeps the truss step actions outside its scroll region and dispatches all joints and members', async () => {
    const store = new Store();
    store.togglePanel('tutorial', true);
    const registry = fakeRegistry();
    render(<TutorialPanel registry={registry} store={store} />, root);
    await afterEffects();
    await click(await waitFor(() => [...root.querySelectorAll('.tutorial-pick')].find((p) => p.textContent?.includes('Steel roof truss')), 'the truss tutorial'));
    for (let i = 0; i < 2; i++) await click([...root.querySelectorAll('.tutorial-btn')].find((b) => b.textContent === 'Skip')!);
    await waitForText(() => root.querySelector('.tutorial-step-title'), 'The truss, as lines');
    const content = root.querySelector('.tutorial-content')!;
    const actions = root.querySelector('.tutorial-actions')!;
    expect(content.contains(actions)).toBe(false);
    expect(content.nextElementSibling).toBe(actions);
    expect([...content.querySelectorAll('dt')].map(el => el.textContent)).toEqual(['points', 'members', 'divisions']);
    expect([...content.querySelectorAll('dd')].map(el => el.textContent)).toEqual(['12 joints', '21 members', '1']);
    await click(root.querySelector('.tutorial-btn.primary'));
    await waitForText(progress, 'step 4 of');
    const command = tutorialById('steel-roof-truss')!.steps[2]!.doIt!;
    expect(registry.dispatch).toHaveBeenCalledExactlyOnceWith(command);
    expect(command['points']).toHaveLength(12);
    expect(command['members']).toHaveLength(21);
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

function tourHarness(store = new Store(), overrides: Partial<TourHost> = {}) {
  const commands = tourCommands(store, {
    preferences: localStorage,
    openCantilever: async () => { location.hash = 'tutorial=cantilever/0'; },
    ...overrides,
  });
  const dispatch = vi.fn(async (command: { cmd: string } & Record<string, unknown>) => {
    const { cmd, ...input } = command;
    const definition = commands.find(def => def.name === cmd)!;
    return definition.run(definition.schema.parse(input), undefined as never);
  });
  store.dispatch = dispatch;
  return { store, dispatch, commands };
}

const tourButton = (text: string) => [...root.querySelectorAll<HTMLButtonElement>('.tour-callout button')].find(button => button.textContent === text) ?? null;

describe('Tour', () => {
  it('guides all eight modeling stages through view Commands without modifying the Journal or Model', async () => {
    const { store, dispatch } = tourHarness();
    const model = { name: 'my work', bodies: [], revision: 1 } as unknown as ModelSummary;
    journalOf(store, [{ cmd: 'model.new', name: 'my work' }]);
    store.set({ model, revision: 1 });
    const journal = store.state.journal;
    render(<Tour store={store} dispatch={dispatch} />, root);
    await waitForText(() => root.querySelector('h2'), TOUR_STOPS[0].title);
    expect(tourButton('Back')?.disabled).toBe(true);
    for (const stop of TOUR_STOPS.slice(1)) {
      await click(tourButton('Next'));
      await waitForText(() => root.querySelector('h2'), stop.title);
    }
    await click(tourButton('Back'));
    await waitForText(() => root.querySelector('h2'), 'Solve the Step');
    expect(store.state.model).toBe(model);
    expect(store.state.journal).toBe(journal);
    expect(dispatch.mock.calls.every(([command]) => command.cmd === 'tour.show')).toBe(true);
    expect(root.querySelectorAll('button:not([data-cmd])')).toHaveLength(0);
  });

  it('dismisses with Continue on my own and stays dismissed after remount, but can explicitly reopen', async () => {
    const { store, dispatch } = tourHarness();
    render(<Tour store={store} dispatch={dispatch} />, root);
    await waitForText(() => root.querySelector('h2'), 'Add geometry');
    await click(tourButton('Continue on my own'));
    await waitForGone(() => root.querySelector('.tour-callout'), 'the tour callout');
    expect(localStorage.getItem(TOUR_DISMISSED_KEY)).toBe('1');
    render(null, root);
    const next = tourHarness();
    render(<Tour store={next.store} dispatch={next.dispatch} />, root);
    await afterEffects();
    expect(root.querySelector('.tour-callout')).toBeNull();
    next.store.togglePanel('tree.geometry', false);
    await next.dispatch({ cmd: 'tour.show' });
    await waitForText(() => root.querySelector('h2'), 'Add geometry');
    expect(next.store.state.panels['tree.geometry']).toBe(true);
    expect(localStorage.getItem(TOUR_DISMISSED_KEY)).toBe('1');
  });

  it('dismisses with the close button and Escape, restoring the invoking control without a focus trap', async () => {
    localStorage.setItem(TOUR_DISMISSED_KEY, '1');
    const trigger = document.createElement('button');
    trigger.textContent = 'Tutorials';
    document.body.append(trigger);
    const { store, dispatch } = tourHarness();
    render(<Tour store={store} dispatch={dispatch} />, root);
    await afterEffects();
    trigger.focus();
    await dispatch({ cmd: 'tour.show' });
    const heading = await waitFor(() => root.querySelector('h2'), 'the tour heading');
    await waitFor(() => document.activeElement === heading, 'focus at the heading');
    // The card has no tab trap: the person can return to the workspace at any time.
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    heading.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitForGone(() => root.querySelector('.tour-callout'), 'the escaped tour');
    expect(document.activeElement).toBe(trigger);
    await dispatch({ cmd: 'tour.show' });
    await waitFor(() => root.querySelector('.tour-dismiss'), 'close control');
    await click(root.querySelector('.tour-dismiss'));
    await waitForGone(() => root.querySelector('.tour-callout'), 'the closed tour');
    expect(localStorage.getItem(TOUR_DISMISSED_KEY)).toBe('1');
  });

  it('does not steal focus from a field or consume Escape from a modal', async () => {
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    const input = document.createElement('input');
    modal.append(input); document.body.append(modal); input.focus();
    const { store, dispatch } = tourHarness();
    render(<Tour store={store} dispatch={dispatch} />, root);
    await waitForText(() => root.querySelector('h2'), 'Add geometry');
    expect(document.activeElement).toBe(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await afterEffects();
    expect(store.state.panels['tour']).toBe(true);
    await dispatch({ cmd: 'tour.dismiss' });
  });

  it('returns focus to Tutorials when reopening removed the invoking panel button', async () => {
    const topbar = document.createElement('div'); topbar.className = 'topbar';
    const fallback = document.createElement('button'); fallback.title = 'Guided tutorials'; topbar.append(fallback); document.body.append(topbar);
    const { store, dispatch } = tourHarness();
    render(<Tour store={store} dispatch={dispatch} />, root);
    await waitForText(() => root.querySelector('h2'), 'Add geometry');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitForGone(() => root.querySelector('.tour-callout'), 'the escaped tour');
    expect(document.activeElement).toBe(fallback);
  });

  it('does not interrupt a tutorial that created the first Model', async () => {
    const { store, dispatch } = tourHarness();
    store.togglePanel('tutorial', true);
    render(<Tour store={store} dispatch={dispatch} />, root);
    await afterEffects();
    expect(root.querySelector('.tour-callout')).toBeNull();
    expect(store.state.panels['tutorial']).toBe(true);
    expect(localStorage.getItem(TOUR_DISMISSED_KEY)).toBeNull();
  });

  it('allows local dismissal and tutorial opening when browser preferences are denied', async () => {
    const { store, dispatch } = tourHarness(new Store(), { preferences: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } } });
    render(<Tour store={store} dispatch={dispatch} />, root);
    await waitForText(() => root.querySelector('h2'), 'Add geometry');
    await click(tourButton('Continue on my own'));
    await waitForGone(() => root.querySelector('.tour-callout'), 'the dismissed tour');
    await dispatch({ cmd: 'tour.show', step: 7 });
    await waitForText(() => root.querySelector('h2'), 'Read and check Results');
    await click(tourButton('Build the cantilever tutorial'));
    await waitForGone(() => root.querySelector('.tour-callout'), 'the completed tour');
    expect(store.state.panels['tutorial']).toBe(true);
    expect(location.hash).toBe('#tutorial=cantilever/0');
  });

  it('strictly validates registered view Commands and leaves existing work untouched on tutorial launch failure', async () => {
    const { store, dispatch, commands } = tourHarness(new Store(), { openCantilever: async () => { throw new Error('unavailable'); } });
    for (const step of [-1, 8, 1.5]) await expect(dispatch({ cmd: 'tour.show', step })).rejects.toThrow();
    for (const definition of commands) expect(definition.schema.safeParse({ unexpected: true }).success).toBe(false);
    await dispatch({ cmd: 'tour.show', step: 7 });
    await expect(dispatch({ cmd: 'tour.startCantilever' })).rejects.toThrow('unavailable');
    expect(store.state.panels['tour']).toBe(true);
    expect(store.state.panels['tutorial']).not.toBe(true);
    expect(localStorage.getItem(TOUR_DISMISSED_KEY)).toBeNull();
  });

  it('the registered cantilever handoff replaces another active runner without requiring tour.show first', async () => {
    localStorage.setItem(TOUR_DISMISSED_KEY, '1');
    const { store, dispatch } = tourHarness();
    const registry = fakeRegistry();
    store.togglePanel('tutorial', true);
    render(<TutorialPanel registry={registry} store={store} />, root);
    await click(await waitFor(() => [...root.querySelectorAll('.tutorial-pick')].find(pick => pick.textContent?.includes('Column buckling')), 'the column tutorial'));
    await click(root.querySelector('.tutorial-btn.primary'));
    await waitForText(progress, 'step 2 of');
    await dispatch({ cmd: 'tour.startCantilever' });
    await waitForText(() => root.querySelector('.tutorial-title'), 'Cantilever beam');
    await waitForText(progress, 'step 1 of 11');
    expect(registry.dispatch).toHaveBeenCalledExactlyOnceWith({ cmd: 'model.new', name: 'column-buckling' });
    // The same Command can explicitly restart that runner too.
    await click(root.querySelector('.tutorial-btn.primary'));
    await waitForText(progress, 'step 2 of 11');
    await dispatch({ cmd: 'tour.startCantilever' });
    await waitForText(progress, 'step 1 of 11');
    expect(registry.dispatch).toHaveBeenCalledTimes(2);
  });

  it('follows the first model.new into its replacement Store instead of mistaking its reset generation for another restart', async () => {
    const old = tourHarness();
    const registry = fakeRegistry();
    journalOf(old.store, [{ cmd: 'model.new', name: 'previous' }, { cmd: 'model.setUnits' }]);
    await old.dispatch({ cmd: 'tour.startCantilever' });
    render(<TutorialPanel registry={registry} store={old.store} />, root);
    await waitForText(progress, 'step 1 of 11');
    expect(old.store.state.tutorialStart).toBe(1);
    // The producer's model.new replaces both the Journal and its Store. The panel survives,
    // just as it does in App; that new acknowledged entry must satisfy the existing step.
    const replacement = tourHarness();
    replacement.store.togglePanel('tutorial', true);
    journalOf(replacement.store, [{ cmd: 'model.new', name: 'cantilever' }]);
    render(<TutorialPanel registry={registry} store={replacement.store} />, root);
    await waitForText(progress, 'step 2 of 11');
    expect(replacement.store.state.tutorialStart).toBe(0);
    expect(registry.dispatch).not.toHaveBeenCalled();
    await replacement.dispatch({ cmd: 'tour.startCantilever' });
    await waitForText(progress, 'step 1 of 11');
    expect(replacement.store.state.journal?.entries).toHaveLength(1);
  });

  it('reopens from an active tutorial and starts the cantilever at step one without consuming earlier work', async () => {
    localStorage.setItem(TOUR_DISMISSED_KEY, '1');
    const { store, dispatch } = tourHarness();
    const registry = fakeRegistry();
    journalOf(store, [{ cmd: 'model.new', name: 'cantilever' }, { cmd: 'model.setUnits' }]);
    store.set({ model: { name: 'cantilever', bodies: [], revision: 2 } as unknown as ModelSummary, revision: 2 });
    store.togglePanel('tutorial', true);
    render(<><Tour store={store} dispatch={dispatch} /><TutorialPanel registry={registry} store={store} /></>, root);
    await click(await waitFor(() => root.querySelector('.tutorial-pick'), 'a tutorial to pick'));
    await waitForText(progress, 'step 1 of');
    await click(root.querySelector('[data-cmd="tour.show"]'));
    await waitForText(() => root.querySelector('h2'), 'Add geometry');
    expect(store.state.panels['tutorial']).toBe(false);
    await dispatch({ cmd: 'tour.show', step: 7 });
    await waitForText(() => root.querySelector('h2'), 'Read and check Results');
    await click(tourButton('Build the cantilever tutorial'));
    await waitForText(progress, 'step 1 of 11');
    expect(registry.dispatch).not.toHaveBeenCalled();
    expect(store.state.journal?.entries).toHaveLength(2);
    expect(localStorage.getItem(TOUR_DISMISSED_KEY)).toBe('1');
    expect(store.state.panels['tour']).toBe(false);
  });
});
