// DESIGN-BRIEF §5.8b's first-run tour: five one-sentence stops over the shell's regions, each a
// callout anchored to the region it describes, ending in "start the cantilever tutorial".
import { useEffect, useState } from 'preact/hooks';
import type { Store } from '../store';
import { tutorialHash } from './runner';
import './tutorial.css';

const DISMISSED_KEY = 'femlab.tour.dismissed';

const STOPS: { selector: string; text: string }[] = [
  { selector: '.tree', text: 'The Model tree: every Body, Material, Mesh, Constraint, Load and Step, in workflow order.' },
  { selector: '.viewer', text: 'The viewer: orbit, pan and zoom the geometry, mesh or Result — every click here is a Command too.' },
  { selector: '.props', text: 'Properties: fill in the Command a control proposes, then Apply — you always see it before it runs.' },
  { selector: '.bottom', text: 'The bottom panel: the Journal of every Command, the Script it makes, Results, Checks and the Console.' },
  { selector: '.topbar .outline', text: 'The Assistant shares this Model with you — every tool call it makes lands in the Journal too.' },
];

function isDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function dismiss(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, '1');
  } catch {
    // A private window just means the tour reappears next visit — not worth failing over.
  }
}

/** The stop's bounding rect, recomputed on resize; `null` while the target is not on screen
 * (a good reason to skip the callout rather than draw it at 0,0). */
function useAnchor(selector: string | undefined): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!selector) {
      setRect(null);
      return undefined;
    }
    const update = (): void => {
      const el = document.querySelector<HTMLElement>(selector);
      setRect(el ? el.getBoundingClientRect() : null);
    };
    update();
    addEventListener('resize', update);
    return () => removeEventListener('resize', update);
    // ponytail: no scroll listener — the shell does not scroll at the design's ≥1180 px width.
  }, [selector]);
  return rect;
}

export function Tour({ store }: { store: Store }) {
  const [dismissed, setDismissed] = useState(isDismissed);
  const [i, setI] = useState(0);
  const stop = dismissed ? undefined : STOPS[i];
  const rect = useAnchor(stop?.selector);

  if (dismissed || !stop) return null;

  const close = (): void => (dismiss(), setDismissed(true));
  const startCantilever = (): void => {
    if (typeof location !== 'undefined') location.hash = tutorialHash('cantilever', 0);
    store.togglePanel('tutorial', true);
    close();
  };
  const last = i === STOPS.length - 1;
  const style = rect ? `left:${Math.min(rect.left, (typeof innerWidth === 'undefined' ? 1200 : innerWidth) - 300)}px;top:${rect.bottom + 10}px` : 'left:50%;top:50%;transform:translate(-50%,-50%)';

  return (
    <div class="tour-callout" style={style} role="dialog" aria-label="Welcome tour">
      <p class="tour-text">{stop.text}</p>
      <div class="tour-actions">
        <button type="button" class="tutorial-btn" onClick={close}>
          Skip tour
        </button>
        {last ? (
          <button type="button" class="tutorial-btn primary" onClick={startCantilever}>
            Start the cantilever tutorial
          </button>
        ) : (
          <button type="button" class="tutorial-btn primary" onClick={() => setI(i + 1)}>
            Next ({i + 1}/{STOPS.length})
          </button>
        )}
      </div>
    </div>
  );
}
