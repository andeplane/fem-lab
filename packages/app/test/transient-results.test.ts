// Async display transitions exercise the real ResultsView with typed transport/viewer seams.
import { expect, it, vi } from 'vitest';
import type { FieldData, FrameResult, FramesResult, Query, QueryResult, ResultSummary, Valued } from '@femlab/registry';
import { ResultsView } from '../src/results';
import { Store } from '../src/store';
import type { Viewer } from '../src/viewer/viewer';
import type { WorkerTransport } from '../src/worker-transport';

const metres = (value: number): Valued => ({ value, unit: 'm' });
const origin: [Valued, Valued, Valued] = [metres(0), metres(0), metres(0)];
const catalogue: FramesResult = {
  resultId: 'result-1', step: 'motion', modelHash: 'solved', stale: false, field: 'displacement',
  components: 3, storedComponents: 3, nodeCount: 1, retainedBytes: 96,
  frames: [0, 0.2, 1].map((timeSi, index) => ({ index, timeSi, time: { value: timeSi, unit: 's' } })),
};
const summary: ResultSummary = {
  resultId: 'result-1', reactionQuantity: 'force', step: 'motion', revision: 1, stale: false, solver: 'explicit', iterations: 5, residual: 0, timeMs: 1,
  extremes: [{ field: 'displacement', component: 1, min: metres(10), max: metres(10), minAt: origin, maxAt: origin }],
  reactions: [], appliedTotal: [{ value: 0, unit: 'N' }, { value: 0, unit: 'N' }, { value: 0, unit: 'N' }], balance: 0,
  history: catalogue.frames.map(frame => ({ time: frame.time, min: metres(10 * frame.timeSi), max: metres(10 * frame.timeSi) })),
};
const frameOf = (index: number): FrameResult => ({
  sample: { resultId: catalogue.resultId, step: 'motion', modelHash: 'solved', frame: catalogue.frames[index]! },
  field: 'displacement', components: 3, nodeCount: 1, unit: 'm', values: [0, 10 * catalogue.frames[index]!.timeSi, 0],
});

function setup() {
  const store = new Store();
  store.set({ fieldKey: 'umag', result: summary });
  const drawing = {
    hasSurface: true,
    setField: vi.fn<Viewer['setField']>(), setDeformed: vi.fn<Viewer['setDeformed']>(),
    setMode: vi.fn<Viewer['setMode']>(), setDim: vi.fn<Viewer['setDim']>(),
    animate: vi.fn<Viewer['animate']>(), autoScale: vi.fn<Viewer['autoScale']>(() => 1),
  } satisfies Pick<Viewer, 'hasSurface' | 'setField' | 'setDeformed' | 'setMode' | 'setDim' | 'animate' | 'autoScale'>;
  const query = vi.fn(async (q: Query): Promise<QueryResult> => {
    if (q.query === 'query.frames') return catalogue;
    if (q.query === 'query.frame') return frameOf(q.index ?? (q.sample?.kind === 'frame' ? q.sample.index : 1));
    if (q.query === 'query.result') return summary;
    throw new Error(`unexpected Query ${q.query}`);
  });
  const field = vi.fn(async (): Promise<FieldData> => ({ values: new Float32Array([0, 10, 0]), min: 0, max: 10, unit: 'm' }));
  const transport = { query, field } satisfies Pick<WorkerTransport, 'query' | 'field'>;
  const results = new ResultsView(store, transport as unknown as WorkerTransport, { current: drawing as unknown as Viewer });
  return { store, drawing, query, field, results };
}

it('reloads the final field when retained time switches to legacy phase on the same Step', async () => {
  const s = setup();
  await s.results.playTransient({ step: 'motion', playing: false, sample: { kind: 'frame', index: 1 } });
  expect(Array.from(s.drawing.setDeformed.mock.calls.at(-1)![0]!)).toEqual([0, 2, 0]);
  await s.results.animate({ step: 'motion', playing: false, frame: 100 });
  expect(s.field).toHaveBeenCalled();
  expect(Array.from(s.drawing.setDeformed.mock.calls.at(-1)![0]!)).toEqual([0, 10, 0]);
  expect(s.store.state.transient).toBeNull();
});

it('discards an older phase result query after a newer transient selection', async () => {
  const s = setup();
  let resolve!: (result: QueryResult) => void;
  s.query.mockImplementationOnce(() => new Promise<QueryResult>(done => { resolve = done; }));
  const pending = s.results.animate({ step: 'motion', playing: false, frame: 100 });
  await s.results.playTransient({ step: 'motion', playing: false, sample: { kind: 'frame', index: 1 } });
  expect(s.store.state.transient?.frame.index).toBe(1);
  resolve(summary);
  await pending;
  expect(s.store.state.transient?.frame.index).toBe(1);
  expect(Array.from(s.drawing.setDeformed.mock.calls.at(-1)![0]!)).toEqual([0, 2, 0]);
});

it('does not let delayed solve hydration reset a newer selected transient time', async () => {
  const s = setup();
  let resolve!: (result: QueryResult) => void;
  s.query.mockImplementationOnce(() => new Promise<QueryResult>(done => { resolve = done; }));
  const pending = s.results.onAck({ output: { type: 'solve' } });
  await s.results.playTransient({ step: 'motion', playing: false, sample: { kind: 'frame', index: 1 } });
  expect(s.store.state.transient?.frame.index).toBe(1);
  resolve(summary);
  await pending;
  expect(s.store.state.transient?.frame.index).toBe(1);
  expect(Array.from(s.drawing.setDeformed.mock.calls.at(-1)![0]!)).toEqual([0, 2, 0]);
});
