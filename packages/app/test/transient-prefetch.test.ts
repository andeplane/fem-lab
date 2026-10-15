// Prefetch is observable through required Query counts and the values actually committed.
import { expect, it, vi } from 'vitest';
import type { FrameResult, FramesResult, Query, QueryResult } from '@femlab/registry';
import { TransientPlayback, type PlaybackClock, type TransientState } from '../src/transient';

function catalogue(step: string): FramesResult {
  return {
    resultId: `result-${step}`, step, modelHash: 'unchanged-model', stale: false, field: 'temperature', nodeCount: 1,
    components: 3, storedComponents: 1, retainedBytes: 64,
    frames: [0, 0.2, 0.7, 0.9].map((timeSi, index) => ({ index, timeSi, time: { value: timeSi, unit: 's' } })),
  };
}
function frame(series: FramesResult, index: number, initial: number): FrameResult {
  return {
    sample: { resultId: series.resultId, step: series.step, modelHash: series.modelHash, frame: series.frames[index]! },
    field: 'temperature', components: 3, nodeCount: 1, unit: 'K',
    values: [initial + series.frames[index]!.timeSi, 0, 0],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function setup(answer: (query: Query) => Promise<QueryResult>) {
  let now = 0;
  let next = 0;
  const timers = new Map<number, () => void>();
  const clock: PlaybackClock = {
    now: () => now,
    schedule: callback => { timers.set(++next, callback); return next; },
    cancel: handle => { timers.delete(handle as number); },
  };
  const query = vi.fn(answer);
  let state: TransientState | null = null;
  const committed: { step: string; index: number; value: number }[] = [];
  const failed = vi.fn();
  const playback = new TransientPlayback({ query }, clock,
    async value => () => committed.push({ step: value.sample.step, index: value.sample.frame.index, value: value.values[0]! }),
    nextState => { state = nextState; }, failed);
  const advance = async (milliseconds: number) => {
    now += milliseconds;
    const callbacks = [...timers.values()]; timers.clear();
    callbacks.forEach(callback => callback());
    await settle();
  };
  return { playback, query, committed, failed, advance, state: () => state };
}

it('reuses a still-pending next-frame fetch when playback reaches that retained time', async () => {
  const series = catalogue('warm');
  const next = deferred<FrameResult>();
  const s = setup(async q => {
    if (q.query === 'query.frames') return series;
    if (q.query === 'query.frame') return q.index === 1 ? next.promise : frame(series, q.index!, 100);
    throw new Error(`unexpected Query ${q.query}`);
  });
  await s.playback.select({ step: 'warm', playing: true });
  expect(s.query.mock.calls.filter(([q]) => q.query === 'query.frame').map(([q]) => q)).toEqual([
    { query: 'query.frame', step: 'warm', index: 0 },
    { query: 'query.frame', step: 'warm', index: 1 },
  ]);
  await s.advance(250);
  expect(s.committed).toEqual([{ step: 'warm', index: 0, value: 100 }]);
  expect(s.query.mock.calls.filter(([q]) => q.query === 'query.frame' && q.index === 1)).toHaveLength(1);
  next.resolve(frame(series, 1, 100)); await settle();
  expect(s.committed.at(-1)).toEqual({ step: 'warm', index: 1, value: 100.2 });
  expect(s.query.mock.calls.filter(([q]) => q.query === 'query.frame' && q.index === 1)).toHaveLength(1);
  expect(s.query.mock.calls.filter(([q]) => q.query === 'query.frame' && q.index === 2)).toHaveLength(1);
  expect(s.failed).not.toHaveBeenCalled();
});

it.each(['another Step', 'a same-hash re-solve'] as const)('discards a late prefetch after selecting %s', async target => {
  const oldSeries = catalogue('old');
  const nextSeries = catalogue(target === 'another Step' ? 'new' : 'old');
  const oldNext = deferred<FrameResult>();
  const newNext = deferred<FrameResult>();
  let replaced = false;
  const s = setup(async q => {
    const series = replaced ? nextSeries : oldSeries;
    if (q.query === 'query.frames') return series;
    if (q.query === 'query.frame') {
      if (q.index === 1) return replaced ? newNext.promise : oldNext.promise;
      return frame(series, q.index!, replaced ? 200 : 100);
    }
    throw new Error(`unexpected Query ${q.query}`);
  });
  await s.playback.select({ step: oldSeries.step, playing: true });
  if (target === 'a same-hash re-solve') s.playback.invalidate();
  replaced = true;
  await s.playback.select({ step: nextSeries.step, playing: true });
  oldNext.resolve(frame(oldSeries, 1, 100)); await settle();
  await s.advance(250);
  // The new target's next frame is still pending. The old value must not fill its cache slot.
  expect(s.committed).toEqual([
    { step: oldSeries.step, index: 0, value: 100 },
    { step: nextSeries.step, index: 0, value: 200 },
  ]);
  expect(s.state()?.frame.index).toBe(0);
  newNext.resolve(frame(nextSeries, 1, 200)); await settle();
  expect(s.committed.at(-1)).toEqual({ step: nextSeries.step, index: 1, value: 200.2 });
  expect(s.state()?.catalogue.step).toBe(nextSeries.step);
  expect(s.failed).not.toHaveBeenCalled();
});
