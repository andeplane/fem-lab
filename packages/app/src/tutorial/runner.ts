// The tutorial state machine (PLAN.md 5.10): current step, whether the newest Journal entries
// satisfy it, and "do it for me". The Journal is the only source of truth for progress — this
// class never sets a hidden "done" flag; `advanceIfMatched` is the one place a step completes.
import type { JournalEntry } from '@femlab/registry';
import type { Step, Tutorial, TutorialCommand } from './types';

const HASH_KEY = 'tutorial';

/** `#tutorial=<id>/<step>`, alongside whatever else the URL hash already holds (none, today). */
export function tutorialHash(id: string, step: number): string {
  return `${HASH_KEY}=${encodeURIComponent(id)}/${step}`;
}

/** The inverse of `tutorialHash`; `null` for a hash that names no tutorial. */
export function parseTutorialHash(hash: string): { id: string; step: number } | null {
  const m = new RegExp(`(?:^|[#&])${HASH_KEY}=([^/&]+)/(\\d+)`).exec(hash);
  if (!m) return null;
  return { id: decodeURIComponent(m[1]!), step: Number(m[2]) };
}

function storageKey(id: string): string {
  return `femlab.tutorial.${id}`;
}

/** Reads the last step saved for `id` (localStorage), ignoring a browser that refuses storage. */
export function savedStep(id: string): number | null {
  try {
    const raw = localStorage.getItem(storageKey(id));
    return raw === null ? null : Number(raw);
  } catch {
    return null;
  }
}

function save(id: string, step: number): void {
  try {
    localStorage.setItem(storageKey(id), String(step));
  } catch {
    // A private window or a storage quota is a fact about the browser, not a reason to stop
    // the tutorial: progress just will not survive a reload.
  }
}

/** Does `entry` satisfy `expect`? The Command name must match, and every named field must be
 * `===` equal — omitted fields are not compared, so a step can watch `material.add` without
 * caring what `E` was typed. */
export function matches(entry: { cmd: string } & Record<string, unknown>, expect: { cmd: string; match?: Partial<Record<string, unknown>> }): boolean {
  if (entry.cmd !== expect.cmd) return false;
  const fields = expect.match ?? {};
  return Object.keys(fields).every((k) => entry[k] === fields[k]);
}

export interface RunnerDeps {
  /** "do it for me": the one place a Step's `doIt` reaches the app. */
  dispatch(cmd: TutorialCommand): Promise<unknown>;
}

export class TutorialRunner {
  readonly tutorial: Tutorial;
  private stepIndex: number;
  /**
   * How far into `entries` the tutorial has already been satisfied, as an **index**, not a
   * `seq`. `Journal::append` sets `seq = entries.len()`, so a `seq` is an index too — but one
   * that `model.new`, `journal.undo` and `file.restore` re-use when they rewrite the Journal.
   * A watermark kept across such a rewrite becomes unreachable and the step stalls for good
   * (issue #87). An index is clamped to the Journal's current length instead, and seeding it
   * from the Journal length at construction is what stops entries that predate the tutorial
   * from satisfying its steps.
   */
  private baseline: number;
  /** What `restart` puts `baseline` back to: where this runner started reading. */
  private readonly seed: number;
  private readonly deps: RunnerDeps;
  private readonly listeners = new Set<() => void>();

  constructor(tutorial: Tutorial, deps: RunnerDeps, startAt = 0, baseline = 0) {
    this.tutorial = tutorial;
    this.deps = deps;
    this.stepIndex = Math.min(Math.max(startAt, 0), tutorial.steps.length);
    this.seed = Math.max(baseline, 0);
    this.baseline = this.seed;
  }

  /**
   * Resume from the URL hash first, then localStorage, else start at step 0 — but only as far as
   * the Journal actually got. A saved position is a claim about the Model; the Journal is the
   * proof. Every earlier step that expects a Command must have it, in order, or the tutorial
   * starts over (issue #47: a stale `#tutorial=cantilever/3` over an empty Model put "Define
   * the material" on screen with no beam to assign it to). The baseline lands just past the last
   * matched entry, so those entries cannot satisfy a later step either.
   */
  static resume(
    tutorial: Tutorial,
    deps: RunnerDeps,
    entries: JournalEntry[],
    hash = typeof location === 'undefined' ? '' : location.hash,
  ): TutorialRunner {
    const fromHash = parseTutorialHash(hash);
    const wanted = fromHash && fromHash.id === tutorial.id ? fromHash.step : (savedStep(tutorial.id) ?? 0);
    const { step, baseline } = TutorialRunner.provenStep(tutorial, entries, wanted);
    const runner = new TutorialRunner(tutorial, deps, step, baseline);
    if (step !== wanted) save(tutorial.id, step);
    return runner;
  }

  /** The furthest step ≤ `wanted` whose predecessors all have their Command in the Journal, and
   * the index just past the entry that proved the last of them. */
  static provenStep(tutorial: Tutorial, entries: JournalEntry[], wanted: number): { step: number; baseline: number } {
    let baseline = 0;
    const limit = Math.min(Math.max(wanted, 0), tutorial.steps.length);
    for (let i = 0; i < limit; i++) {
      const expect = tutorial.steps[i]?.expect;
      if (!expect) continue;
      const at = entries.findIndex((e, k) => k >= baseline && matches(e.cmd as { cmd: string } & Record<string, unknown>, expect));
      if (at < 0) return { step: i, baseline };
      baseline = at + 1;
    }
    return { step: limit, baseline };
  }

  get step(): number {
    return this.stepIndex;
  }

  get currentStep(): Step | undefined {
    return this.tutorial.steps[this.stepIndex];
  }

  get isComplete(): boolean {
    return this.stepIndex >= this.tutorial.steps.length;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    save(this.tutorial.id, this.stepIndex);
    if (typeof location !== 'undefined') location.hash = tutorialHash(this.tutorial.id, this.stepIndex);
    for (const fn of this.listeners) fn();
  }

  /**
   * Feed the current Journal in; advances (and returns `true`) for every step whose `expect` is
   * satisfied by an entry at or after the baseline. It loops, so a Journal that already answers
   * three steps — a resume, an opened example, a replayed share link — walks through all three
   * and notifies once; and a step whose Command is already journaled is *recognised* rather
   * than re-issued, which is idempotence for free. A step without `expect` stops the walk —
   * see `next`.
   */
  advanceIfMatched(entries: JournalEntry[]): boolean {
    let moved = false;
    for (;;) {
      const step = this.currentStep;
      if (!step?.expect) break;
      // The Journal was rewritten (model.new, journal.undo, file.restore): indices at or beyond
      // its new length no longer name anything, so the baseline follows it down (issue #87).
      if (this.baseline > entries.length) this.baseline = entries.length;
      const at = entries.findIndex((e, k) => k >= this.baseline && matches(e.cmd as { cmd: string } & Record<string, unknown>, step.expect!));
      if (at < 0) break;
      this.baseline = at + 1;
      this.stepIndex += 1;
      moved = true;
    }
    if (moved) this.notify();
    return moved;
  }

  /** For a read-only step (`expect: null`): advance on the person's own "Next". */
  next(): boolean {
    if (this.isComplete || this.currentStep?.expect) return false;
    this.stepIndex += 1;
    this.notify();
    return true;
  }

  /** Move on without the Command ever appearing — always allowed, from either kind of step. */
  skip(): void {
    if (this.isComplete) return;
    this.stepIndex += 1;
    this.notify();
  }

  restart(): void {
    this.stepIndex = 0;
    this.baseline = this.seed;
    this.notify();
  }

  /** Forget the saved position and take the tutorial out of the URL: on close, or once it is done. */
  static forget(id: string): void {
    try {
      localStorage.removeItem(storageKey(id));
    } catch {
      // storage refused: nothing to forget
    }
    if (typeof location !== 'undefined' && parseTutorialHash(location.hash)?.id === id) {
      history.replaceState(null, '', location.pathname + location.search);
    }
  }

  /** Dispatch the current step's Command. Does not itself advance: the Journal it produces is
   * what `advanceIfMatched` reads next, so a person who both clicks "do it for me" and then
   * clicks the real control never double-advances. */
  async doIt(): Promise<unknown> {
    const cmd = this.currentStep?.doIt;
    if (!cmd) return undefined;
    return this.deps.dispatch(cmd);
  }
}
