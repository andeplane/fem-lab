import { describe, expect, it, vi } from 'vitest';
import type { FrameResult, FramesResult } from '@femlab/registry';
import { TransientPlayback, type PlaybackClock, type TransientState } from '../src/transient';

const catalogue: FramesResult = {
  resultId: 'result-1', step: 'heat', modelHash: 'solved', stale: false, field: 'temperature', nodeCount: 1,
  components: 3, storedComponents: 1, retainedBytes: 64,
  frames: [0, 0.2, 0.7, 0.9].map((timeSi, index) => ({ index, timeSi, time: { value: timeSi * 1000, unit: 'ms' } })),
};
const frame = (index: number): FrameResult => ({
  sample: { resultId: catalogue.resultId, step: 'heat', modelHash: 'solved', frame: catalogue.frames[index]! },
  field: 'temperature', components: 3, nodeCount: 1, unit: 'K', values: [100 + catalogue.frames[index]!.timeSi, 0, 0],
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function setup() {
  let now = 0;
  let next = 0;
  const scheduled = new Map<number, () => void>();
  const clock: PlaybackClock = { now: () => now, schedule: (callback) => { scheduled.set(++next, callback); return next; }, cancel: (id) => { scheduled.delete(id as number); } };
  const query = vi.fn(async (q: { query: string; index?: number; sample?: { index?: number } }) => q.query === 'query.frames' ? catalogue : frame(q.index ?? q.sample?.index ?? 1));
  const committed: number[] = [];
  const prepare = vi.fn(async (value: FrameResult) => () => committed.push(value.sample.frame.index));
  let state: TransientState | null = null;
  const changed = vi.fn((next: TransientState | null) => { state = next; });
  const failed = vi.fn();
  const playback = new TransientPlayback({ query } as never, clock, prepare, changed, failed);
  const advance = async (ms: number) => {
    now += ms;
    const callbacks = [...scheduled.values()]; scheduled.clear();
    callbacks.forEach((callback) => callback());
    await settle();
  };
  return { playback, query, prepare, committed, changed, failed, scheduled, advance, state: () => state };
}

describe('retained physical-time playback', () => {
  it('holds actual retained fields on an irregular time grid and stops at the endpoint', async () => {
    const s = setup();
    await s.playback.select({ step: 'heat', playing: true, speed: 2 });
    await s.advance(90); expect(s.committed).toEqual([0]);
    await s.advance(20); expect(s.committed).toEqual([0, 1]);
    await s.advance(250); expect(s.committed).toEqual([0, 1, 2]);
    await s.advance(100); expect(s.committed).toEqual([0, 1, 2, 3]);
    expect(s.state()).toMatchObject({ playing: false, frame: { timeSi: 0.9 } });
    expect(s.scheduled.size).toBe(0);
    expect(s.prepare.mock.calls.map(([value]) => value.values[0])).toEqual([100, 100.2, 100.7, 100.9]);
  });

  it('passes unit-bearing selectors to Rust unchanged, then pauses and resumes from the selected time', async () => {
    const s = setup();
    const sample = { kind: 'time', time: '200 ms', sampling: 'exact' } as const;
    await s.playback.select({ step: 'heat', playing: false, sample });
    expect(s.query).toHaveBeenCalledWith({ query: 'query.frame', step: 'heat', sample });
    expect(s.state()?.frame.index).toBe(1);
    await s.advance(5000); expect(s.committed).toEqual([1]);
    await s.playback.select({ step: 'heat', playing: true });
    await s.advance(510); expect(s.state()?.frame.index).toBe(2);
  });

  it('discards out-of-order frames and prepared drawings after a newer selection', async () => {
    const s = setup();
    const old = deferred<FrameResult>();
    s.query.mockImplementation(async (q) => q.query === 'query.frames' ? catalogue : q.index === 0 ? old.promise : frame(2));
    s.query.mockImplementation(async (q) => q.query === 'query.frames' ? catalogue : old.promise);
    const pending = s.playback.select({ step: 'heat', playing: false, sample: { kind: 'frame', index: 0 } });
    await settle();
    s.query.mockImplementation(async (q) => q.query === 'query.frames' ? catalogue : frame(3));
    await s.playback.select({ step: 'heat', playing: false, sample: { kind: 'frame', index: 3 } });
    old.resolve(frame(0)); await pending;
    expect(s.committed.at(-1)).toBe(3);
    expect(s.state()?.frame.index).toBe(3);
  });

  it('invalidates pending reads and all cached payloads on same-hash re-solves', async () => {
    const s = setup();
    await s.playback.select({ step: 'heat', playing: false });
    const old = deferred<FrameResult>();
    s.query.mockImplementation(async (q) => q.query === 'query.frames' ? catalogue : old.promise);
    const pending = s.playback.select({ step: 'heat', playing: false }); await settle();
    s.playback.invalidate();
    old.resolve(frame(2)); await pending;
    expect(s.state()).toBeNull(); expect(s.committed).toEqual([0]);
    s.query.mockImplementation(async (q) => q.query === 'query.frames' ? catalogue : { ...frame(0), values: [800, 0, 0] });
    await s.playback.select({ step: 'heat', playing: false });
    expect(s.prepare.mock.calls.at(-1)?.[0].values[0]).toBe(800);
  });

  it('rejects stale metadata without replacing the current frame', async () => {
    const s = setup();
    await s.playback.select({ step: 'heat', playing: false });
    s.query.mockResolvedValue({ ...catalogue, stale: true });
    await expect(s.playback.select({ step: 'heat', playing: false })).rejects.toMatchObject({ code: 'result.stale' });
    expect(s.committed).toEqual([0]); expect(s.state()?.frame.index).toBe(0);
  });

  it('preserves elapsed time between retained frames across speed changes and pauses', async () => {
    const s = setup();
    await s.playback.select({ step: 'heat', playing: true });
    await s.advance(650); expect(s.state()?.frame.index).toBe(1);
    await s.playback.select({ step: 'heat', playing: true, speed: 2 });
    await s.advance(30); expect(s.state()?.frame.index).toBe(2);
    await s.playback.select({ step: 'heat', playing: false });
    await s.advance(4000); expect(s.state()?.frame.index).toBe(2);
    await s.playback.select({ step: 'heat', playing: true });
    await s.advance(100); expect(s.state()?.frame.index).toBe(3);
  });
});
