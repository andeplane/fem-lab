import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import type { Store } from '../store';
import { Cmd, useStore, type Dispatch } from '../ui/cmd';
import { useTarget } from './Spotlight';
import { TOUR_STOPS } from './tour-state';
import './tutorial.css';

/** A nonmodal workflow card in its own shell row, never over the form or highlighted target. */
export function Tour({ store, dispatch }: { store: Store; dispatch: Dispatch }) {
  const s = useStore(store), open = s.panels['tour'] === true;
  const attempted = useRef<Store | null>(null);
  const card = useRef<HTMLElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const restore = useRef<HTMLElement | null>(null);
  const stop = TOUR_STOPS[s.tourStep] ?? TOUR_STOPS[0];
  useTarget(open ? [stop.target] : [], false);

  useEffect(() => {
    if (attempted.current === store) return;
    attempted.current = store;
    void dispatch({ cmd: 'tour.show', automatic: true }).catch(() => undefined);
  }, [store, dispatch]);

  const restoreFocus = (): void => {
    if (!card.current?.contains(document.activeElement)) return;
    const previous = restore.current;
    const fallback = document.querySelector<HTMLElement>('.topbar [title="Guided tutorials"]');
    (previous?.isConnected && previous !== document.body && previous !== document.documentElement ? previous : fallback)?.focus();
  };
  const run: Dispatch = command => {
    if (command.cmd === 'tour.dismiss' || command.cmd === 'tour.startCantilever') restoreFocus();
    return dispatch(command);
  };

  useLayoutEffect(() => {
    if (!open) return;
    restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !active.matches('input,textarea,select,[contenteditable="true"]')) heading.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.activeElement instanceof HTMLElement && document.activeElement.closest('[aria-modal="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      restoreFocus();
      void dispatch({ cmd: 'tour.dismiss' }).catch(() => undefined);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, dispatch]);
  useLayoutEffect(() => {
    if (open && card.current?.contains(document.activeElement)) heading.current?.focus({ preventScroll: true });
  }, [s.tourStep]);

  if (!open) return null;
  const last = s.tourStep === TOUR_STOPS.length - 1;
  return <section ref={card} class="tour-callout" role="region" aria-labelledby="modeling-tour-title" aria-describedby="modeling-tour-description">
    <header class="tour-header"><div><span class="tour-progress">MODELING TOUR · {s.tourStep + 1} OF {TOUR_STOPS.length}</span><h2 ref={heading} id="modeling-tour-title" tabIndex={-1}>{stop.title}</h2></div>
      <Cmd dispatch={run} cmd="tour.dismiss" class="tutorial-btn tour-dismiss" label="Dismiss modeling tour">×</Cmd>
    </header>
    <p id="modeling-tour-description" class="tour-text" aria-live="polite">{stop.text}</p>
    <div class="tour-actions">
      <Cmd dispatch={run} cmd="tour.dismiss" class="tutorial-btn">Continue on my own</Cmd>
      <span class="tour-navigation">
        <Cmd dispatch={run} cmd="tour.show" args={{ step: s.tourStep - 1 }} class="tutorial-btn" disabled={s.tourStep === 0}>Back</Cmd>
        {last ? <Cmd dispatch={run} cmd="tour.startCantilever" class="tutorial-btn primary">Build the cantilever tutorial</Cmd>
          : <Cmd dispatch={run} cmd="tour.show" args={{ step: s.tourStep + 1 }} class="tutorial-btn primary">Next</Cmd>}
      </span>
    </div>
    <small class="tour-help">Local modeling is free without sign-in. Escape dismisses this tour; reopen it from Tutorials → Modeling tour.{last ? ' Opening a tutorial does not run its Commands. Use a new project to keep an existing Model.' : ''}</small>
  </section>;
}
