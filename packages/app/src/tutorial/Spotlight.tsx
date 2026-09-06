// The cut-out that says "here" (issue #38): one fixed div at the target's rect with a very
// large `box-shadow` spread, which dims everything else in a single compositor layer — no
// canvas, no four-div mask, and `pointer-events: none` so the control underneath is still
// clickable. `useTarget` is the half with the side effects: find the control, mark it, scroll
// it into view, follow it, and hand its rect back for `place` to hang the card off.
import { useEffect, useState } from 'preact/hooks';
import { type Box, nameOf, PALETTE, resolve } from './target';
import './tutorial.css';

const boxOf = (el: HTMLElement): Box => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
};

const same = (a: Box | null, b: Box | null): boolean =>
  a === b || (a !== null && b !== null && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height);

/**
 * The control the candidates name, once it is on the page. Retries briefly: the Properties form
 * a rung-1 candidate points at may not have re-rendered onto the Command yet.
 *
 * ponytail: a bounded retry loop, not a MutationObserver — good enough for a form that settles
 * within a render or two; move to an observer if a step ever needs to wait longer than this.
 */
export function useTarget(cands: string[]): { box: Box | null; name: string | null; fallback: boolean } {
  const key = cands.join('|');
  const [found, setFound] = useState<{ box: Box; name: string | null; fallback: boolean } | null>(null);
  useEffect(() => {
    let el: HTMLElement | null = null;
    let tries = 0;
    const measure = (): void => {
      if (!el) return;
      const box = boxOf(el);
      const next = { box, name: nameOf(el), fallback: el.matches(PALETTE) };
      setFound((prev) => (same(prev?.box ?? null, box) ? prev : next));
    };
    const look = (): void => {
      el = resolve(key.split('|'));
      if (!el) {
        if (++tries > 20) clearInterval(timer);
        return;
      }
      clearInterval(timer);
      el.setAttribute('data-tutorial-target', '');
      el.scrollIntoView({ block: 'nearest' });
      // Keyboard users get the same cue as everyone else — but never while someone is typing,
      // so focus only moves when it is sitting on nothing or on the tutorial card itself.
      const active = document.activeElement;
      if (active === null || active === document.body || active.closest('.tutorial-panel') !== null) el.focus({ preventScroll: true });
      measure();
    };
    const timer = setInterval(look, 150);
    look();
    addEventListener('resize', measure);
    // Capturing: the Model tree and the Properties panel are their own scroll containers, and a
    // `scroll` listener on `window` never hears them, so the spotlight would drift.
    addEventListener('scroll', measure, true);
    return () => {
      clearInterval(timer);
      removeEventListener('resize', measure);
      removeEventListener('scroll', measure, true);
      el?.removeAttribute('data-tutorial-target');
      setFound(null);
    };
  }, [key]);
  return found ?? { box: null, name: null, fallback: false };
}

export function Spotlight({ box }: { box: Box | null }) {
  if (!box) return null;
  return <div class="tutorial-spot" style={`left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px`} />;
}
