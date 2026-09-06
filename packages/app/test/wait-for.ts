// Preact schedules its effects and its repaint off the current tick, and how many ticks that
// takes depends on how loaded the machine is — under a full vitest worker pool a fixed
// `setTimeout(20)` loses about one run in three. So no test sleeps for a guessed number of
// milliseconds: they poll for the state they are about to assert on, and fail with what they
// were waiting for if it never arrives.
const INTERVAL_MS = 5;
const CAP_MS = 2000;

const frame = (): Promise<void> => new Promise((r) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => r()) : setTimeout(r, 0)));
const turn = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * Resolve once Preact has flushed the effects of a fresh mount. `useEffect` runs after a paint,
 * so a subscription a component registers there — `useStore`, the tutorial runner's — is not
 * live on the tick the component first renders, and a click or a `store.set` before then
 * changes state nothing is listening to.
 *
 * Preact's `afterNextFrame` races a `requestAnimationFrame` against a 100 ms timer and then
 * queues the callback on a `setTimeout(0)`, so one frame is not enough: the boundary is a
 * frame *and* the turn after it. Waiting for the boundary rather than for a number of
 * milliseconds is what makes this survive a loaded machine — load moves the frame later, it
 * does not make the wait shorter.
 */
export async function afterEffects(): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await frame();
    await turn();
  }
}

/** Poll `read` until it returns something truthy, and hand that back. */
export async function waitFor<T>(read: () => T, what = 'the DOM to settle', cap = CAP_MS): Promise<NonNullable<T>> {
  const deadline = Date.now() + cap;
  for (;;) {
    const value = read();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`waited ${cap} ms for ${what}`);
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

/** Poll until `text` shows up inside the element `find` returns, and hand back its text. */
export function waitForText(find: () => Element | null | undefined, text: string, cap = CAP_MS): Promise<string> {
  return waitFor(() => {
    const seen = find()?.textContent ?? '';
    return seen.includes(text) ? seen : null;
  }, `"${text}"`, cap);
}

/** Poll until `find` returns nothing: a callout dismissed, a panel closed. */
export function waitForGone(find: () => Element | null | undefined, what = 'an element to go', cap = CAP_MS): Promise<true> {
  return waitFor(() => find() == null || null, what, cap) as Promise<true>;
}
