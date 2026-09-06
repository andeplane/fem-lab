// Where a Step points, and what it wants typed there. Everything here is pure — a Step and a
// DOM in, a selector list, a rect or a list of values out — so `test/tutorial-target.test.tsx`
// can hold every rung against a fixture DOM without mounting the app (issues #38, #46).
import type { Step } from './types';

/** The Properties panel's own subtree. Only rung 1 may ever point inside it — see `resolve`. */
const FORM = '.props';

/** A `highlight` that is a Command id rather than a raw CSS selector. */
const IS_COMMAND = /^[\w.:-]+$/;

/** The symbol an engineer writes for a field, where the JSON key is not it. */
const LABELS: Record<string, string> = {
  nu: 'ν',
  rho: 'ρ',
  alpha: 'α',
  cp: 'cₚ',
  E: 'E',
};

const SUPER: Record<string, string> = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };

/** `kg/m^3` → `kg/m³`, `degC` → `°C`: the same value, written the way the design writes it. */
export function prettyUnits(text: string): string {
  return text.replace(/\^(-?\d+)/g, (_, d: string) => [...d].map((c) => SUPER[c] ?? c).join('')).replace(/\bdegC\b/g, '°C');
}

/** One value as the person would type it: a list joins with `×`, an object with commas. */
function asText(value: unknown): string {
  if (Array.isArray(value)) return value.map(asText).join(' × ');
  if (value !== null && typeof value === 'object') return Object.entries(value as Record<string, unknown>).map(([k, v]) => `${k} ${asText(v)}`).join(', ');
  return prettyUnits(String(value));
}

/** The fields a Step's Command carries, `cmd` aside: the override first, else what "do it for
 * me" would actually dispatch, so the card can never disagree with the button next to it. */
function sourceOf(step: Step): Record<string, unknown> {
  const src = step.fields ?? (step.doIt as Record<string, unknown> | undefined) ?? {};
  const { cmd: _drop, ...rest } = src;
  return rest;
}

/** The values the card lists: `E · 210 GPa`, `ν · 0.3`, `ρ · 7850 kg/m³` (issue #46). */
export function fieldsOf(step: Step): [string, string][] {
  return Object.entries(sourceOf(step)).map(([k, v]) => [LABELS[k] ?? k, asText(v)]);
}

/**
 * The same values keyed by the `data-field` path `SchemaForm` renders, so each input can carry
 * its own `placeholder`. A multi-part quantity (`size` is three lengths) becomes `size.0`,
 * `size.1`, `size.2`, which is exactly how the form paths its inputs.
 */
export function formHintsOf(step: Step): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (path: string[], value: unknown): void => {
    if (Array.isArray(value)) return value.forEach((v, i) => walk([...path, String(i)], v));
    if (value !== null && typeof value === 'object') return Object.entries(value as Record<string, unknown>).forEach(([k, v]) => walk([...path, k], v));
    out[path.join('.')] = prettyUnits(String(value));
  };
  for (const [k, v] of Object.entries(sourceOf(step))) walk([k], v);
  return out;
}

/**
 * The selectors that could be the control this Step is about, best first:
 *
 * 1. the form's own field rows — but only while the form is already open on the Step's Command,
 *    so "fill this in" never points at a form filled in for something else;
 * 2. a control that *dispatches* the Command (Solve, the units segmented, a tree run row);
 * 3. a control that *opens the form on* it (`data-opens`: the tree's `+ add …` chips, its rows,
 *    the blocker banner's fix links);
 * 4. the raw string, for a `highlight` that is a CSS selector rather than a Command id;
 * 5. the ⌘K field, for the nine Commands with no control of their own (issue #43 retires most
 *    of these) — honest, and it teaches the palette.
 */
export function candidates(step: Step, form: { cmd: string } | null): string[] {
  const out: string[] = [];
  if (form && step.expect && form.cmd === step.expect.cmd) {
    for (const key of Object.keys(sourceOf(step))) out.push(`${FORM} [data-field="${key}"]`);
  }
  const h = step.highlight;
  if (h) {
    if (IS_COMMAND.test(h)) out.push(`[data-cmd="${h}"]`, `[data-opens="${h}"]`);
    else out.push(h);
  }
  out.push('.palette-field');
  return out;
}

/**
 * The first candidate that is actually on screen. Rungs 2–5 skip the Properties panel: its
 * **Revert** button is `form.open` with the very Command the Step is about, so without this the
 * spotlight lands on Revert (plan E review, decision 2). A selector that does not parse is a
 * miss, not a page error (issue #55).
 */
export function resolve(cands: string[], doc: ParentNode = document): HTMLElement | null {
  for (const sel of cands) {
    const intoForm = sel.startsWith(FORM);
    let found: HTMLElement[];
    try {
      found = [...doc.querySelectorAll<HTMLElement>(sel)];
    } catch {
      continue;
    }
    const hit = found.find((el) => intoForm || !el.closest(FORM));
    if (hit) return hit;
  }
  return null;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface Placement {
  left: number;
  top: number;
  /** Which side of the target the card ended up on, so its arrow points back at it. */
  side: 'left' | 'right';
}

const GAP = 16;
const EDGE = 8;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, hi));

/**
 * Put the card beside the target: to its right by preference, to its left when the right has no
 * room, clamped into the viewport either way. Never on top of it, and never over the Properties
 * panel when the target is in it — which is all #46 actually asked for (the drag handle it also
 * proposed is state to persist and a11y to get right for no gain; see the issue).
 */
export function place(rect: Box, card: { width: number; height: number }, viewport: { width: number; height: number }): Placement {
  const right = rect.left + rect.width + GAP;
  const left = rect.left - card.width - GAP;
  const fitsRight = right + card.width + EDGE <= viewport.width;
  const side = fitsRight || left < EDGE ? 'right' : 'left';
  return {
    left: clamp(side === 'right' ? right : left, EDGE, Math.max(EDGE, viewport.width - card.width - EDGE)),
    top: clamp(rect.top, EDGE, Math.max(EDGE, viewport.height - card.height - EDGE)),
    side,
  };
}

/** What to call the resolved control in prose, read off its own visible text so it can never
 * drift from the UI. `null` when it has none worth quoting (a bare form row, an icon). */
export function nameOf(el: HTMLElement | null): string | null {
  const text = (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  return text.length > 0 && text.length <= 40 ? text : null;
}
