// The compact side card of DESIGN-BRIEF §5.8b: step n of m, the explanation, "do it for me",
// Skip, Next. Not part of the `[data-cmd]`-enforced App shell (ADR 0003) — it is a self
// contained panel the coordinator mounts once `<TutorialPanel registry={registry} store={store}
// />`, so its buttons are plain: nothing here is a registry Command in its own right.
import type { JournalDump, ModelSummary, Registry } from '@femlab/registry';
import { useEffect, useState } from 'preact/hooks';
import type { Store } from '../store';
import { TutorialRunner } from './runner';
import { TUTORIALS, tutorialById } from './tutorials';
import './tutorial.css';

/**
 * Find the control a step's `highlight` names — a `data-cmd` value first, else a raw CSS
 * selector — and mark it for the pulsing outline. Retries briefly: the Properties form the
 * highlight points at may not have re-rendered onto the target Command yet.
 *
 * ponytail: a bounded retry loop, not a MutationObserver — good enough for a form that settles
 * within a render or two; move to an observer if a step ever needs to wait longer than this.
 */
function useHighlight(selector: string | undefined): void {
  useEffect(() => {
    if (!selector) return undefined;
    let el: HTMLElement | null = null;
    let tries = 0;
    const timer = setInterval(() => {
      el = document.querySelector<HTMLElement>(`[data-cmd="${selector}"]`) ?? document.querySelector<HTMLElement>(selector);
      if (el) {
        el.setAttribute('data-tutorial-target', '');
        clearInterval(timer);
      } else if (++tries > 20) {
        clearInterval(timer);
      }
    }, 150);
    return () => {
      clearInterval(timer);
      el?.removeAttribute('data-tutorial-target');
    };
  }, [selector]);
}

/** Re-renders this component whenever `runner` notifies of a step change: a plain mutate + a
 * `subscribe` callback, the same shape `Store` uses (`ui/cmd.tsx`'s `useStore`). */
function useRunnerTick(runner: TutorialRunner | null): void {
  const [, setTick] = useState(0);
  useEffect(() => (runner ? runner.subscribe(() => setTick((n) => n + 1)) : undefined), [runner]);
}

export function TutorialPanel({ registry, store }: { registry: Registry; store: Store }) {
  const [s, setS] = useState(store.state);
  useEffect(() => store.subscribe(() => setS(store.state)), [store]);
  const [runner, setRunner] = useState<TutorialRunner | null>(null);
  useRunnerTick(runner);

  const open = s.panels['tutorial'] === true;
  const makeRunner = (tutorial: Parameters<typeof TutorialRunner.resume>[0], startAt?: number): TutorialRunner => {
    const deps = { dispatch: (cmd: { cmd: string } & Record<string, unknown>) => registry.dispatch(cmd) };
    return startAt === undefined ? TutorialRunner.resume(tutorial, deps) : new TutorialRunner(tutorial, deps, startAt);
  };

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

  useHighlight(open ? runner?.currentStep?.highlight : undefined);

  if (!open) return null;

  const close = (): void => store.togglePanel('tutorial', false);

  // "do it for me" bypasses the app's own dispatch wrapper (that lives in main.tsx, outside
  // this module's ownership), so it refreshes just enough of the Store for the Journal watch
  // above to fire: the Model tree and viewer catch up on the next Command either way.
  const doIt = async (): Promise<void> => {
    if (!runner) return;
    await runner.doIt();
    const [model, journal] = await Promise.all([
      registry.query({ query: 'query.model' }) as Promise<ModelSummary>,
      registry.query({ query: 'query.journal' }) as Promise<JournalDump>,
    ]);
    store.set({ model, journal, revision: model.revision });
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
          <button type="button" class="tutorial-btn" onClick={() => setRunner(null)}>
            Choose another tutorial
          </button>
        </div>
      </aside>
    );
  }

  const step = runner.currentStep!;
  return (
    <aside class="tutorial-panel" role="complementary" aria-label="Tutorial">
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
      {step.theory ? <pre class="tutorial-theory mono">{step.theory}</pre> : null}
      <div class="tutorial-actions">
        {step.doIt ? (
          <button type="button" class="tutorial-btn primary" onClick={() => void doIt()}>
            Do it for me
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
  );
}
