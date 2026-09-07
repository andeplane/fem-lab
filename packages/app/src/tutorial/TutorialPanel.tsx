import { acquireRegistryProducer, type RegistryProducer } from '../producer-registry';
import { useStore } from '../ui/cmd';
// The compact side card of DESIGN-BRIEF §5.8b: step n of m, the explanation, "do it for me",
// Skip, Next. Not part of the `[data-cmd]`-enforced App shell (ADR 0003) — it is a self
// contained panel the coordinator mounts once `<TutorialPanel registry={registry} store={store}
// />`, so its buttons are plain: nothing here is a registry Command in its own right.
import type { JournalDump, ModelSummary, Registry } from '@femlab/registry';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Store } from '../store';
import { TutorialRunner } from './runner';
import { Spotlight, useTarget } from './Spotlight';
import { candidates, fieldsOf, FORM, formHintsOf, place, rectOf } from './target';
import { TUTORIALS, tutorialById } from './tutorials';
import type { Step } from './types';
import './tutorial.css';

/** The card's own size, for `place`. Measured rather than assumed: the height is whatever the
 * step's prose and values come to. It settles in one extra render and then stops. */
function useCardSize(ref: { current: HTMLElement | null }): { width: number; height: number } {
  const [size, setSize] = useState({ width: 320, height: 300 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && (r.width !== size.width || r.height !== size.height)) setSize({ width: r.width, height: r.height });
  });
  return size;
}

/** Re-renders this component whenever `runner` notifies of a step change: a plain mutate + a
 * `subscribe` callback, the same shape `Store` uses (`ui/cmd.tsx`'s `useStore`). */
function useRunnerTick(runner: TutorialRunner | null): void {
  const [, setTick] = useState(0);
  useEffect(() => (runner ? runner.subscribe(() => setTick((n) => n + 1)) : undefined), [runner]);
}

export function TutorialPanel({ registry, store }: { registry: Registry; store: Store }) {
  const s = useStore(store);
  const owner = useRef<Promise<RegistryProducer> | null>(null);
  const [runner, setRunner] = useState<TutorialRunner | null>(null);
  useRunnerTick(runner);

  const open = s.panels['tutorial'] === true;
  const makeRunner = (tutorial: Parameters<typeof TutorialRunner.resume>[0], startAt?: number): TutorialRunner => {
    if (owner.current) void owner.current.then(value => value.release()).catch(() => undefined);
    const producer = acquireRegistryProducer(registry);
    void producer.catch(() => undefined);
    owner.current = producer;
    const deps = { dispatch: async (command: { cmd: string } & Record<string, unknown>) => {
      const lease = await producer;
      await lease.registry.query({ query: 'query.journal' }); // observe the visible step, including edits made by hand
      const result = await lease.registry.dispatch(command);
      lease.store()?.togglePanel('tutorial', true);
      return result;
    } };
    return startAt === undefined ? TutorialRunner.resume(tutorial, deps, s.journal?.entries ?? []) : new TutorialRunner(tutorial, deps, startAt, s.journal?.entries.length ?? 0);
  };
  useEffect(() => {
    const pending = owner.current;
    if (!pending) return;
    void pending.then(lease => {
      if (owner.current !== pending) return;
      if (lease.signal.aborted || lease.store() && lease.store() !== store) {
        owner.current = null; setRunner(null); void lease.release();
      }
    }).catch(() => { if (owner.current === pending) { owner.current = null; setRunner(null); } });
  }, [store]);
  useEffect(() => () => { if (owner.current) void owner.current.then(lease => lease.release()).catch(() => undefined); }, []);

  // Resume from the URL hash (Tour's "start the cantilever tutorial" sets it) or localStorage
  // the moment the panel opens, if nothing is running yet.
  useEffect(() => {
    if (!open || runner) return;
    const fromHash = typeof location !== 'undefined' ? location.hash : '';
    const id = /tutorial=([^/]+)\//.exec(fromHash)?.[1];
    const tutorial = id ? tutorialById(decodeURIComponent(id)) : undefined;
    if (tutorial) setRunner(makeRunner(tutorial));
  }, [open, runner]);

  // The one source of truth: whenever the Journal changes (a real click or "do it for me"),
  // see if it satisfies the current step.
  useEffect(() => {
    if (runner && s.journal) runner.advanceIfMatched(s.journal.entries);
  }, [runner, s.journal]);

  // Where the current step points, and where the card goes so it never covers it (#38, #46).
  const current: Step | undefined = open ? runner?.currentStep : undefined;
  const { box, name, fallback } = useTarget(current ? candidates(current, s.form) : []);
  const cardRef = useRef<HTMLElement | null>(null);
  const cardSize = useCardSize(cardRef);
  // The step's values, offered to the Properties form as placeholders. This is the whole of the
  // tutorial module's reach into the shell, and it goes through the Store (issue #46).
  const values = current ? fieldsOf(current) : [];
  useEffect(() => {
    store.set({ formHints: current ? formHintsOf(current) : null });
    return () => store.set({ formHints: null });
  }, [current, store]);
  // Read live rather than remembered: `box` already changes on every resize and scroll, so the
  // Properties panel is re-measured on exactly the occasions that can move it.
  const spot = box ? place(box, cardSize, { width: innerWidth, height: innerHeight }, rectOf(FORM)) : null;
  // One "do it for me" at a time: the button is disabled until the Journal has been re-read,
  // so a second click cannot issue the same Command again (issue #37). Through the app's own
  // dispatch the Journal, tree, viewer and results all refresh; without it (a bare panel) the
  // Store is refreshed here so the Journal watch above still fires.
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  // Anchored beside the target; docked bottom-right when nothing resolved.
  const card = spot ? { class: 'tutorial-panel anchored', style: `left:${spot.left}px;top:${spot.top}px`, 'data-side': spot.side } : { class: 'tutorial-panel' };

  const close = (): void => {
    if (owner.current) void owner.current.then(lease => lease.release()).catch(() => undefined);
    owner.current = null;
    if (runner) TutorialRunner.forget(runner.tutorial.id);
    setRunner(null);
    store.togglePanel('tutorial', false);
  };

  const doIt = async (): Promise<void> => {
    if (!runner || busy) return;
    setBusy(true);
    try {
      await runner.doIt();
      if (!store.dispatch) {
        const [model, journal] = await Promise.all([
          registry.query({ query: 'query.model' }) as Promise<ModelSummary>,
          registry.query({ query: 'query.journal' }) as Promise<JournalDump>,
        ]);
        store.set({ model, journal, revision: model.revision });
      }
    } catch {
      // the Command's error is on the store already (main.tsx's dispatch) or in the console
    } finally {
      setBusy(false);
    }
  };

  if (!runner) {
    return (
      <aside class="tutorial-panel" role="complementary" aria-label="Tutorials">
        <div class="tutorial-head">
          <span class="tutorial-title">Tutorials</span>
          <button type="button" class="tutorial-close" onClick={close} aria-label="close">
            ×
          </button>
        </div>
        <div class="tutorial-list">
          {TUTORIALS.map((t) => (
            <button key={t.id} type="button" class="tutorial-pick" onClick={() => setRunner(makeRunner(t, 0))}>
              <span class="tutorial-pick-title">{t.title}</span>
              <span class="tutorial-pick-meta mono">{t.minutes} min</span>
              <span class="tutorial-pick-summary">{t.summary}</span>
            </button>
          ))}
        </div>
      </aside>
    );
  }

  const total = runner.tutorial.steps.length;
  if (runner.isComplete) {
    return (
      <aside class="tutorial-panel" role="complementary" aria-label="Tutorial">
        <div class="tutorial-head">
          <span class="tutorial-title">{runner.tutorial.title} — done</span>
          <button type="button" class="tutorial-close" onClick={close} aria-label="close">
            ×
          </button>
        </div>
        <p class="tutorial-explain">Every step is in the Journal. Pick another tutorial, or close this and keep building.</p>
        <div class="tutorial-actions">
          <button
            type="button"
            class="tutorial-btn"
            onClick={() => {
              TutorialRunner.forget(runner.tutorial.id);
              setRunner(null);
            }}
          >
            Choose another tutorial
          </button>
        </div>
      </aside>
    );
  }

  const step = runner.currentStep!;
  return (
    <>
      <Spotlight box={box} />
      <aside ref={cardRef} {...card} role="complementary" aria-label="Tutorial" aria-live="polite">
        <div class="tutorial-head">
          <span class="tutorial-title">{runner.tutorial.title}</span>
          <span class="tutorial-progress mono">
            step {runner.step + 1} of {total}
          </span>
          <button type="button" class="tutorial-close" onClick={close} aria-label="close">
            ×
          </button>
        </div>
        <h3 class="tutorial-step-title">{step.title}</h3>
        <p class="tutorial-explain">{step.explain}</p>
        {fallback && step.expect ? (
          <p class="tutorial-where">
            Nothing on screen runs <code class="mono">{step.expect.cmd}</code> yet — press <kbd>⌘K</kbd>, type it and press ↵.
          </p>
        ) : name ? (
          <p class="tutorial-where">
            Click <b>{name}</b> — it is the outlined control.
          </p>
        ) : null}
        {values.length > 0 ? (
          <dl class="tutorial-values mono">
            {values.map(([label, value]) => (
              <>
                <dt key={`${label}-k`}>{label}</dt>
                <dd key={`${label}-v`}>{value}</dd>
              </>
            ))}
          </dl>
        ) : null}
        {step.theory ? <pre class="tutorial-theory mono">{step.theory}</pre> : null}
        <div class="tutorial-actions">
          {step.doIt ? (
            <button type="button" class="tutorial-btn primary" disabled={busy} onClick={() => void doIt()}>
              {busy ? 'Doing it…' : 'Do it for me'}
            </button>
          ) : null}
          {step.expect === null ? (
            <button type="button" class="tutorial-btn primary" onClick={() => runner.next()}>
              Next
            </button>
          ) : null}
          <button type="button" class="tutorial-btn" onClick={() => runner.skip()}>
            Skip
          </button>
        </div>
      </aside>
    </>
  );
}
