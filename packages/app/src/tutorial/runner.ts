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
  /** Journal `seq` of the entry that completed the current step; entries at or before it are
   * from an earlier step (or from before the tutorial started) and cannot re-satisfy it. */
  private watermark = -1;
  private readonly deps: RunnerDeps;
  private readonly listeners = new Set<() => void>();

  constructor(tutorial: Tutorial, deps: RunnerDeps, startAt = 0) {
    this.tutorial = tutorial;
    this.deps = deps;
    this.stepIndex = Math.min(Math.max(startAt, 0), tutorial.steps.length);
  }

  /** Resume from the URL hash first, then localStorage, else start at step 0. */
  static resume(tutorial: Tutorial, deps: RunnerDeps, hash = typeof location === 'undefined' ? '' : location.hash): TutorialRunner {
    const fromHash = parseTutorialHash(hash);
    const start = fromHash && fromHash.id === tutorial.id ? fromHash.step : (savedStep(tutorial.id) ?? 0);
    return new TutorialRunner(tutorial, deps, start);
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
   * Feed the current Journal in; advances one step (and returns `true`) if a fresh entry (one
   * whose `seq` is newer than the watermark) satisfies the current step's `expect`. A step
   * without `expect` never advances here — see `next`.
   */
  advanceIfMatched(entries: JournalEntry[]): boolean {
    const step = this.currentStep;
    if (!step?.expect) return false;
    const hit = entries.find((e) => e.seq > this.watermark && matches(e.cmd as { cmd: string } & Record<string, unknown>, step.expect!));
    if (!hit) return false;
    this.watermark = hit.seq;
    this.stepIndex += 1;
    this.notify();
    return true;
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
    this.watermark = -1;
    this.notify();
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
