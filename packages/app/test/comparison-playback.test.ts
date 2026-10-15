import { describe, expect, it, vi } from 'vitest';
import { FemError, type ComparisonConfiguration, type ComparisonPlaybackState, type EngineTransport, type FrameResult, type FramesResult, type Valued } from '@femlab/registry';
import { ComparisonPlayback, type ComparisonPlaybackPresentation } from '../src/comparison-playback';
import type { PlaybackClock } from '../src/transient';

type Side = 'left' | 'right';
const catalogues: Record<Side, FramesResult> = Object.fromEntries((['left', 'right'] as const).map(side => [side, {
  resultId: side, step: 'heat', modelHash: `solved-${side}`, stale: side === 'left', field: 'temperature', nodeCount: 1,
  components: 3, storedComponents: 1, retainedBytes: 64,
  frames: (side === 'left' ? [0, 0.2, 0.7, 0.9] : [0, 0.3, 0.6, 1.2]).map((timeSi, index) => ({ index, timeSi, time: { value: timeSi * 1000, unit: 'ms' } })),
}])) as Record<Side, FramesResult>;
const frame = (side: Side, index: number): FrameResult => ({
  sample: { resultId: side, step: 'heat', modelHash: `solved-${side}`, frame: catalogues[side].frames[index]! },
  field: 'temperature', components: 3, nodeCount: 1, unit: 'K', values: [300 + catalogues[side].frames[index]!.timeSi * (side === 'left' ? 1 : 2), 0, 0],
});
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function setup(hasClock = true) {
  let now = 0, next = 0;
  const scheduled = new Map<number, () => void>();
  const clock: PlaybackClock = { now: () => now, schedule: callback => { scheduled.set(++next, callback); return next; }, cancel: id => { scheduled.delete(id as number); } };
  let configuration: ComparisonConfiguration = { mode: 'sideBySide', left: { resultId: 'left', field: 'temperature', component: 0 }, right: { resultId: 'right', field: 'temperature', component: 0 } };
  let state: ComparisonPlaybackState | null = null;
  const displayed: Partial<Record<Side, FrameResult>> = {};
  const commits: Partial<Record<Side, number>>[] = [];
  const time = (quantity: string | Valued): number => {
    const parsed = typeof quantity === 'string' ? /^(\d+(?:\.\d+)?) (s|ms)$/.exec(quantity) : null;
    const value = typeof quantity === 'string' ? Number(parsed?.[1]) : quantity.value;
    const unit = typeof quantity === 'string' ? parsed?.[2] : quantity.unit;
    if (!Number.isFinite(value) || (unit !== 's' && unit !== 'ms')) throw new FemError('unit.dimension', 'expected time', 'time');
    return value * (unit === 'ms' ? 0.001 : 1);
  };
  const answer: EngineTransport['query'] = async input => {
    if (input.query === 'query.convert') return { value: time(input.quantity), unit: 's' };
    if (input.query !== 'query.frames' && input.query !== 'query.frame') throw new Error(`unexpected ${input.query}`);
    const side = input.resultId as Side, catalogue = catalogues[side];
    if (input.query === 'query.frames') return catalogue;
    const sample = input.sample;
    if (!sample) throw new Error('sample must be explicit');
    let index: number;
    if (sample.kind === 'frame') index = sample.index;
    else {
      const requested = time(sample.time), frames = catalogue.frames;
      if (requested < frames[0]!.timeSi || requested > frames.at(-1)!.timeSi) throw new FemError('not-found', 'outside retained interval', 'sample.time');
      index = frames.findIndex(f => Math.abs(f.timeSi - requested) < 1e-12);
      if (index < 0 && sample.sampling === 'exact') throw new FemError('not-found', 'time is not retained', 'sample.time');
      if (index < 0) index = frames.reduce((nearest, f) => Math.abs(f.timeSi - requested) + 1e-12 < Math.abs(frames[nearest]!.timeSi - requested) ? f.index : nearest, 0);
    }
    if (!catalogue.frames[index]) throw new FemError('not-found', 'index is not retained', 'sample.index');
    return frame(side, index);
  };
  const query = vi.fn<EngineTransport['query']>(answer);
  const commit = vi.fn<ComparisonPlaybackPresentation['commit']>(async (frames, _catalogues, current) => {
    if (!current()) return false;
    Object.assign(displayed, frames);
    commits.push(Object.fromEntries(Object.entries(frames).map(([side, f]) => [side, f.sample.frame.index])));
    return true;
  });
  const changed = vi.fn((next: ComparisonPlaybackState | null) => { state = next ? structuredClone(next) : null; });
  const failed = vi.fn();
  const playback = new ComparisonPlayback({ query }, hasClock ? clock : undefined, { configuration: () => configuration, commit, changed, failed });
  const advance = async (ms: number, fire = true) => {
    now += ms;
    if (fire) { const callbacks = [...scheduled.values()]; scheduled.clear(); callbacks.forEach(callback => callback()); }
    await settle();
  };
  return { playback, query, answer, commit, changed, failed, displayed, commits, scheduled, advance, state: () => state, configure: (next: ComparisonConfiguration) => { configuration = next; playback.invalidate(); } };
}

describe('independently retained comparison clocks', () => {
  it('advances both irregular schedules independently and preserves a paused pane and the longer remainder', async () => {
    const s = setup();
    await s.playback.select({ mode: 'independent', pane: 'left', resultId: 'left', playing: true, speed: 1 });
    await s.playback.select({ mode: 'independent', pane: 'right', resultId: 'right', playing: true, speed: 2, sample: { kind: 'frame', index: 1 } });
    await s.advance(150);
    expect(s.state()?.left?.sample.frame.index).toBe(0); expect(s.state()?.right?.sample.frame.index).toBe(2);
    expect(s.displayed.right?.values).toEqual([301.2, 0, 0]);
    await s.advance(600);
    expect(s.state()?.left).toMatchObject({ playing: true, sample: { frame: { index: 2, timeSi: 0.7 } } });
    expect(s.state()?.right).toMatchObject({ playing: false, sample: { frame: { index: 3, timeSi: 1.2 } } });
    await s.advance(300);
    expect(s.state()?.left?.playing).toBe(false); expect(s.scheduled.size).toBe(0);
    expect(s.commits.at(-1)).toEqual({ left: 3 });
    expect(s.displayed.right?.sample.frame.timeSi).toBe(1.2);
  });

  it('seeks exact/nearest physical time independently, then holds both schedules at one playhead and stops at the shorter endpoint', async () => {
    const s = setup();
    await s.playback.select({ mode: 'synchronized', leftResultId: 'left', rightResultId: 'right', playing: false, time: '0 s', sampling: 'exact' });
    const before = structuredClone(s.state()), commits = s.commits.length;
    await expect(s.playback.select({ mode: 'synchronized', leftResultId: 'left', rightResultId: 'right', playing: false, time: '200 ms', sampling: 'exact' })).rejects.toMatchObject({ code: 'not-found' });
    expect(s.state()).toEqual(before); expect(s.commits).toHaveLength(commits);
    await s.playback.select({ mode: 'synchronized', leftResultId: 'left', rightResultId: 'right', playing: true, time: '450 ms', sampling: 'nearest' });
    expect(s.state()).toMatchObject({ mode: 'synchronized', playheadSi: 0.45, interval: { startSi: 0, endSi: 0.9 }, left: { sample: { frame: { timeSi: 0.2 } } }, right: { sample: { frame: { timeSi: 0.3 } } } });
    expect(s.query).toHaveBeenCalledWith({ query: 'query.convert', quantity: '450 ms', to: 's' });
    await s.advance(140); expect(s.state()?.playheadSi).toBeCloseTo(0.59);
    expect(s.displayed.left?.sample.frame.timeSi).toBe(0.2); expect(s.displayed.right?.sample.frame.timeSi).toBe(0.3);
    await s.advance(20); expect(s.commits.at(-1)).toEqual({ left: 1, right: 2 });
    await s.advance(140); expect(s.commits.at(-1)).toEqual({ left: 2, right: 2 });
    await s.advance(300);
    expect(s.state()).toMatchObject({ playheadSi: 0.9, left: { playing: false, sample: { frame: { timeSi: 0.9 } } }, right: { playing: false, sample: { frame: { timeSi: 0.6 } } } });
    expect(s.scheduled.size).toBe(0);
    await s.playback.select({ mode: 'independent', pane: 'right', resultId: 'right', playing: false, sample: { kind: 'frame', index: 3 } });
    expect(s.state()).toMatchObject({ mode: 'independent', interval: null, left: { sample: { frame: { timeSi: 0.9 } } }, right: { sample: { frame: { timeSi: 1.2 } } } });
  });

  it('retains sub-frame elapsed time across speed, pause and resume, including direct lifecycle pause', async () => {
    const s = setup();
    await s.playback.select({ mode: 'independent', pane: 'left', resultId: 'left', playing: true });
    await s.advance(650);
    expect(s.state()?.left?.sample.frame.index).toBe(1);
    await s.playback.select({ mode: 'independent', pane: 'left', resultId: 'left', playing: true, speed: 2 });
    await s.advance(30); expect(s.state()?.left?.sample.frame.index).toBe(2);
    await s.advance(20, false); s.playback.pause();
    expect(s.state()?.left?.playheadSi).toBeCloseTo(0.75);
    await s.advance(4000); expect(s.state()?.left?.sample.frame.index).toBe(2);
    await s.playback.select({ mode: 'independent', pane: 'left', resultId: 'left', playing: true });
    await s.advance(80); expect(s.state()?.left?.sample.frame.index).toBe(3);
    await s.playback.select({ mode: 'independent', pane: 'left', resultId: 'left', playing: true });
    expect(s.state()?.left?.sample.frame.index).toBe(0);
    s.playback.pause(); expect(s.scheduled.size).toBe(0);
  });

  it('fences older frame reads and errors without blocking an independent selection in the other pane', async () => {
    const s = setup(), pending = deferred<FrameResult>();
    s.query.mockImplementation(input => input.query === 'query.frame' && input.resultId === 'left' && input.sample?.kind === 'frame' && input.sample.index === 0 ? pending.promise : s.answer(input));
    const old = s.playback.select({ mode: 'independent', pane: 'left', resultId: 'left', playing: false, sample: { kind: 'frame', index: 0 } }); await settle();
    await s.playback.select({ mode: 'independent', pane: 'right', resultId: 'right', playing: false, sample: { kind: 'frame', index: 2 } });
    await s.playback.select({ mode: 'independent', pane: 'left', resultId: 'left', playing: false, sample: { kind: 'frame', index: 2 } });
    pending.reject(new FemError('not-found', 'old request evicted'));
    await expect(old).resolves.toBeUndefined();
    expect(s.commits).toEqual([{ right: 2 }, { left: 2 }]); expect(s.failed).not.toHaveBeenCalled();
  });

  it('publishes synchronized pairs only after both required frames arrive and drops a replaced-session reply', async () => {
    const s = setup(), pending = deferred<FrameResult>();
    s.query.mockImplementation(input => input.query === 'query.frame' && input.resultId === 'right' ? pending.promise : s.answer(input));
    const old = s.playback.select({ mode: 'synchronized', leftResultId: 'left', rightResultId: 'right', playing: false, time: '0 s', sampling: 'exact' }); await settle();
    expect(s.commits).toEqual([]); expect(s.state()).toBeNull();
    s.playback.invalidate(); pending.resolve(frame('right', 0)); await old;
    expect(s.commits).toEqual([]); expect(s.state()).toBeNull();
    s.query.mockImplementation(s.answer);
    await s.playback.select({ mode: 'synchronized', leftResultId: 'left', rightResultId: 'right', playing: false, time: '0 s', sampling: 'exact' });
    expect(s.commits).toEqual([{ left: 0, right: 0 }]);
  });

  it('keeps one timer job and reuses only the required current/next read while a slow frame is pending', async () => {
    const s = setup(), pending = deferred<FrameResult>();
    s.query.mockImplementation(input => input.query === 'query.frame' && input.resultId === 'left' && input.sample?.kind === 'frame' && input.sample.index === 1 ? pending.promise : s.answer(input));
    await s.playback.select({ mode: 'independent', pane: 'left', resultId: 'left', playing: true });
    await s.advance(500); expect(s.scheduled.size).toBe(0);
    await s.advance(600); expect(s.commits).toEqual([{ left: 0 }]);
    expect(s.query.mock.calls.filter(([input]) => input.query === 'query.frame' && input.sample?.kind === 'frame' && input.sample.index === 1)).toHaveLength(1);
    pending.resolve(frame('left', 1)); await settle();
    expect(s.scheduled.size).toBe(1); expect(s.commits).toEqual([{ left: 0 }, { left: 1 }]);
    await s.advance(0); expect(s.state()?.left).toMatchObject({ playing: false, sample: { frame: { index: 3 } } });
    expect(s.scheduled.size).toBe(0);
  });

  it('rejects wrong identities, primary fields, absent clocks and missing overlap without changing the displayed pair', async () => {
    const s = setup();
    await s.playback.select({ mode: 'independent', pane: 'left', resultId: 'left', playing: false });
    const before = structuredClone(s.state());
    await expect(s.playback.select({ mode: 'independent', pane: 'left', resultId: 'other', playing: false })).rejects.toMatchObject({ code: 'result.stale' });
    await expect(s.playback.select({ mode: 'independent', pane: 'left', resultId: 'left', playing: false, speed: 0 })).rejects.toMatchObject({ code: 'schema' });
    s.query.mockImplementation(input => input.query === 'query.frame' ? Promise.resolve({ ...frame('left', 0), sample: { ...frame('left', 0).sample, step: 'wrong' } }) : s.answer(input));
    await expect(s.playback.select({ mode: 'independent', pane: 'left', resultId: 'left', playing: false })).rejects.toMatchObject({ code: 'result.stale' });
    expect(s.state()).toEqual(before); expect(s.commits).toEqual([{ left: 0 }]);
    const withoutClock = setup(false);
    await expect(withoutClock.playback.select({ mode: 'independent', pane: 'left', resultId: 'left', playing: true })).rejects.toMatchObject({ code: 'unsupported' });
    expect(withoutClock.query).not.toHaveBeenCalled();
    s.query.mockImplementation(input => input.query === 'query.frames' && input.resultId === 'right' ? Promise.resolve({ ...catalogues.right, frames: [{ index: 0, timeSi: 2, time: { value: 2, unit: 's' } }] }) : s.answer(input));
    await expect(s.playback.select({ mode: 'synchronized', leftResultId: 'left', rightResultId: 'right', playing: false, sampling: 'nearest' })).rejects.toMatchObject({ code: 'unsupported', where: 'time' });
    expect(s.state()).toEqual(before);
    s.configure({ mode: 'sideBySide', left: { resultId: 'left', field: 'heatFlux' }, right: { resultId: 'right', field: 'temperature', component: 0 } });
    s.query.mockImplementation(s.answer);
    await expect(s.playback.select({ mode: 'independent', pane: 'left', resultId: 'left', playing: false })).rejects.toMatchObject({ code: 'unsupported', where: 'field' });
  });

  it('stops and reports a required evicted read, but ignores a late error after invalidation', async () => {
    const s = setup(), pending = deferred<FrameResult>();
    s.query.mockImplementation(input => input.query === 'query.frame' && input.sample?.kind === 'frame' && input.sample.index === 1 ? pending.promise : s.answer(input));
    await s.playback.select({ mode: 'independent', pane: 'left', resultId: 'left', playing: true });
    await s.advance(500); pending.reject(new FemError('not-found', "retained Result 'left' evicted")); await settle();
    expect(s.failed).toHaveBeenCalledTimes(1); expect(s.state()?.left?.playing).toBe(false); expect(s.scheduled.size).toBe(0);
    const late = setup(), next = deferred<FrameResult>();
    late.query.mockImplementation(input => input.query === 'query.frame' && input.sample?.kind === 'frame' && input.sample.index === 1 ? next.promise : late.answer(input));
    await late.playback.select({ mode: 'independent', pane: 'left', resultId: 'left', playing: true });
    await late.advance(500); late.playback.invalidate(); next.reject(new FemError('not-found', 'old backend'));
    await settle(); expect(late.failed).not.toHaveBeenCalled(); expect(late.state()).toBeNull(); expect(late.scheduled.size).toBe(0);
  });

  it('lets a replacement generation play while an obsolete generation still awaits a frame, without overlapping current ticks', async () => {
    const s = setup(), old = deferred<FrameResult>(), fresh = deferred<FrameResult>();
    s.query.mockImplementation(input => input.query === 'query.frame' && input.resultId === 'left' && input.sample?.kind === 'frame' && input.sample.index === 1 ? old.promise : s.answer(input));
    await s.playback.select({ mode: 'independent', pane: 'left', resultId: 'left', playing: true });
    await s.advance(500);
    expect(s.scheduled.size).toBe(0);
    s.configure({ mode: 'sideBySide', left: { resultId: 'left', field: 'temperature', component: 0 }, right: { resultId: 'right', field: 'temperature', component: 0 } });
    s.query.mockImplementation(input => input.query === 'query.frame' && input.resultId === 'left' && input.sample?.kind === 'frame' && input.sample.index === 1 ? fresh.promise : s.answer(input));
    await s.playback.select({ mode: 'independent', pane: 'left', resultId: 'left', playing: true });
    expect(s.scheduled.size).toBe(1);
    await s.advance(500);
    expect(s.scheduled.size).toBe(0);
    old.resolve(frame('left', 1)); await settle();
    expect(s.commits).toEqual([{ left: 0 }, { left: 0 }]); expect(s.scheduled.size).toBe(0);
    await s.advance(100); expect(s.scheduled.size).toBe(0);
    fresh.resolve(frame('left', 1)); await settle();
    expect(s.commits).toEqual([{ left: 0 }, { left: 0 }, { left: 1 }]); expect(s.scheduled.size).toBe(1);
    expect(s.query.mock.calls.filter(([input]) => input.query === 'query.frame' && input.resultId === 'left' && input.sample?.kind === 'frame' && input.sample.index === 1)).toHaveLength(2);
  });

  it('reports a still-current left tick failure after a newer unrelated right selection, preserving that valid work', async () => {
    for (const rightPlaying of [false, true]) {
      const s = setup(), pending = deferred<FrameResult>();
      s.query.mockImplementation(input => input.query === 'query.frame' && input.resultId === 'left' && input.sample?.kind === 'frame' && input.sample.index === 1 ? pending.promise : s.answer(input));
      await s.playback.select({ mode: 'independent', pane: 'left', resultId: 'left', playing: true });
      await s.advance(500);
      await s.playback.select({ mode: 'independent', pane: 'right', resultId: 'right', playing: rightPlaying, sample: { kind: 'frame', index: 2 } });
      pending.reject(new FemError('not-found', "retained Result 'left' evicted")); await settle();
      expect(s.failed).toHaveBeenCalledTimes(1); expect(s.failed.mock.calls[0]?.[0]).toMatchObject({ code: 'not-found' });
      expect(s.state()?.left?.playing).toBe(false);
      expect(s.state()?.right).toMatchObject({ playing: rightPlaying, sample: { frame: { index: 2 } } });
      expect(s.displayed.right?.values).toEqual([301.2, 0, 0]); expect(s.scheduled.size).toBe(rightPlaying ? 1 : 0);
      if (rightPlaying) { await s.advance(650); expect(s.displayed.right?.values).toEqual([302.4, 0, 0]); expect(s.scheduled.size).toBe(0); }
    }
  });
});
