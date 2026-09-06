// The runner in isolation: matching, advancing, persistence, and "do it for me" against a fake
// registry — no DOM component involved (that is tutorial-panel.test.tsx).
import type { JournalEntry } from '@femlab/registry';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { matches, parseTutorialHash, savedStep, TutorialRunner, tutorialHash } from '../src/tutorial/runner';
import type { Tutorial } from '../src/tutorial/types';

const entry = (seq: number, cmd: string, extra: Record<string, unknown> = {}): JournalEntry =>
  ({ seq, cmd: { cmd, ...extra }, hashAfter: `h${seq}` }) as unknown as JournalEntry;

const tutorial: Tutorial = {
  id: 'demo',
  title: 'Demo',
  minutes: 1,
  summary: 'a demo tutorial',
  steps: [
    { title: 'One', explain: 'first', expect: { cmd: 'model.new' }, doIt: { cmd: 'model.new', name: 'demo' } },
    { title: 'Two', explain: 'second', expect: { cmd: 'material.add', match: { name: 'steel' } }, doIt: { cmd: 'material.add', name: 'steel', E: '210 GPa' } },
    { title: 'Three', explain: 'read only', expect: null },
  ],
};

beforeEach(() => {
  localStorage.clear();
  location.hash = '';
});

describe('matches', () => {
  it('requires the Command name to match', () => {
    expect(matches({ cmd: 'model.new' }, { cmd: 'model.new' })).toBe(true);
    expect(matches({ cmd: 'model.rename' }, { cmd: 'model.new' })).toBe(false);
  });

  it('checks only the fields named in match, by strict equality', () => {
    const expect_ = { cmd: 'material.add', match: { name: 'steel' } };
    expect(matches({ cmd: 'material.add', name: 'steel', E: '210 GPa' }, expect_)).toBe(true);
    expect(matches({ cmd: 'material.add', name: 'gold', E: '210 GPa' }, expect_)).toBe(false);
  });
});

describe('TutorialRunner.advanceIfMatched', () => {
  it('advances on a fresh entry that satisfies the current step, and ignores others', () => {
    const runner = new TutorialRunner(tutorial, { dispatch: vi.fn() });
    expect(runner.step).toBe(0);
    // an unrelated Command does not advance it
    expect(runner.advanceIfMatched([entry(0, 'model.setUnits')])).toBe(false);
    expect(runner.step).toBe(0);
    // the expected Command does
    expect(runner.advanceIfMatched([entry(0, 'model.setUnits'), entry(1, 'model.new')])).toBe(true);
    expect(runner.step).toBe(1);
  });

  it('respects match fields: the right Command with the wrong field does not advance it', () => {
    const runner = new TutorialRunner(tutorial, { dispatch: vi.fn() }, 1);
    expect(runner.advanceIfMatched([entry(0, 'material.add', { name: 'gold' })])).toBe(false);
    expect(runner.advanceIfMatched([entry(1, 'material.add', { name: 'steel' })])).toBe(true);
    expect(runner.step).toBe(2);
  });

  it('never re-matches an entry from before the step started', () => {
    const runner = new TutorialRunner(tutorial, { dispatch: vi.fn() });
    runner.advanceIfMatched([entry(0, 'model.new')]);
    expect(runner.step).toBe(1);
    // seq 0 already advanced step 0; step 1 wants material.add, so replaying seq 0 again must not match
    expect(runner.advanceIfMatched([entry(0, 'model.new')])).toBe(false);
    expect(runner.step).toBe(1);
  });

  it('does nothing on a read-only step (expect: null)', () => {
    const runner = new TutorialRunner(tutorial, { dispatch: vi.fn() }, 2);
    expect(runner.advanceIfMatched([entry(5, 'solve.run')])).toBe(false);
    expect(runner.step).toBe(2);
  });
});

describe('TutorialRunner.next / skip', () => {
  it('next only advances a read-only step', () => {
    const runner = new TutorialRunner(tutorial, { dispatch: vi.fn() }, 0);
    expect(runner.next()).toBe(false);
    expect(runner.step).toBe(0);
    const atThree = new TutorialRunner(tutorial, { dispatch: vi.fn() }, 2);
    expect(atThree.next()).toBe(true);
    expect(atThree.isComplete).toBe(true);
  });

  it('skip advances regardless of expect, and stops at the end', () => {
    const runner = new TutorialRunner(tutorial, { dispatch: vi.fn() });
    runner.skip();
    runner.skip();
    runner.skip();
    expect(runner.isComplete).toBe(true);
    runner.skip(); // one past the end is a no-op, not an out-of-range step
    expect(runner.step).toBe(3);
  });
});

describe('TutorialRunner.doIt', () => {
  it('dispatches the current step Command through the fake registry, and nothing else', async () => {
    const dispatch = vi.fn(async () => ({ seq: 0 }));
    const runner = new TutorialRunner(tutorial, { dispatch });
    await runner.doIt();
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ cmd: 'model.new', name: 'demo' });
    // doIt alone does not advance the step: the Journal (fed back through advanceIfMatched) does
    expect(runner.step).toBe(0);
  });

  it('is a no-op on a step with no doIt', async () => {
    const dispatch = vi.fn();
    const runner = new TutorialRunner(tutorial, { dispatch }, 2);
    await runner.doIt();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('persistence', () => {
  it('writes the step to localStorage and the URL hash on every advance', () => {
    const runner = new TutorialRunner(tutorial, { dispatch: vi.fn() });
    runner.advanceIfMatched([entry(0, 'model.new')]);
    expect(savedStep('demo')).toBe(1);
    expect(location.hash).toBe(`#${tutorialHash('demo', 1)}`);
  });

  it('parseTutorialHash reads id and step back out, and rejects an unrelated hash', () => {
    expect(parseTutorialHash('#tutorial=cantilever/3')).toEqual({ id: 'cantilever', step: 3 });
    expect(parseTutorialHash('#something=else')).toBeNull();
    expect(parseTutorialHash('')).toBeNull();
  });

  it('resumes no further than the Journal proves, and sets the watermark past the proven entries', () => {
    localStorage.setItem('femlab.tutorial.demo', '2');
    // nothing in the Journal: a saved step 2 means nothing, start over
    const empty = TutorialRunner.resume(tutorial, { dispatch: vi.fn() }, [], '');
    expect(empty.step).toBe(0);
    expect(localStorage.getItem('femlab.tutorial.demo')).toBe('0');
    // the first step's Command is there: resume at 1, and that entry cannot satisfy step 1
    const one = TutorialRunner.resume(tutorial, { dispatch: vi.fn() }, [entry(0, tutorial.steps[0]!.expect!.cmd)], '#tutorial=demo/2');
    expect(one.step).toBe(1);
    expect(one.advanceIfMatched([entry(0, tutorial.steps[0]!.expect!.cmd)])).toBe(false);
  });

  it('forget drops the saved step and the hash', () => {
    localStorage.setItem('femlab.tutorial.demo', '3');
    location.hash = tutorialHash('demo', 3);
    TutorialRunner.forget('demo');
    expect(localStorage.getItem('femlab.tutorial.demo')).toBeNull();
    expect(location.hash).toBe('');
  });

  it('resume prefers the URL hash over localStorage, and falls back to localStorage', () => {
    localStorage.setItem('femlab.tutorial.demo', '1');
    const proven = [entry(0, 'model.new'), entry(1, 'material.add', { name: 'steel' })];
    const fromStorage = TutorialRunner.resume(tutorial, { dispatch: vi.fn() }, proven, '');
    expect(fromStorage.step).toBe(1);
    const fromHash = TutorialRunner.resume(tutorial, { dispatch: vi.fn() }, proven, `#${tutorialHash('demo', 2)}`);
    expect(fromHash.step).toBe(2);
  });

  it('restart resets both the step and the watermark', () => {
    const runner = new TutorialRunner(tutorial, { dispatch: vi.fn() });
    runner.advanceIfMatched([entry(0, 'model.new')]);
    runner.restart();
    expect(runner.step).toBe(0);
    // seq 0 must be able to satisfy step 0 again after a restart
    expect(runner.advanceIfMatched([entry(0, 'model.new')])).toBe(true);
  });
});

describe('subscribe', () => {
  it('notifies listeners on every advance', () => {
    const runner = new TutorialRunner(tutorial, { dispatch: vi.fn() });
    const fn = vi.fn();
    const unsubscribe = runner.subscribe(fn);
    runner.skip();
    expect(fn).toHaveBeenCalledTimes(1);
    unsubscribe();
    runner.skip();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
