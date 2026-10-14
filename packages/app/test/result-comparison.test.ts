import { FemError, type DifferenceField, type EngineTransport, type Query, type QueryResult, type ResultField, type ResultSummary, type RetainedResults, type Surface, type Valued } from '@femlab/registry';
import { expect, it, vi } from 'vitest';
import { fakeTransport, RESULT } from '../../registry/test/fakes';
import { ResultComparison, type ComparisonViewer } from '../src/result-comparison';
import { Store } from '../src/store';
import type { CameraState } from '../src/viewer/viewer';

const operand = (resultId: string, field = 'displacement', component?: number) => ({ resultId, field, ...(component === undefined ? {} : { component }) });
const pair = { mode: 'sideBySide' as const, left: operand('old'), right: operand('new', 'vonMises') };
const q = (value: number, unit = 'm'): Valued => ({ value, unit });
function viewer() {
  let camera: CameraState = { position: [3, 4, 5], target: [0, 0, 0] }, zoom = 1;
  const fake = {
    animate: vi.fn(), setField: vi.fn(), setDeformed: vi.fn(), setSurface: vi.fn(), setVisible: vi.fn(), setMode: vi.fn(),
    setDim: vi.fn(), setColormap: vi.fn(), setFieldValidity: vi.fn(), setSelection: vi.fn(), preset: vi.fn(), setProjection: vi.fn(),
    setCamera: vi.fn((next: CameraState) => { camera = next; }), getCamera: () => camera,
    setComparisonFrameHeight: vi.fn(), getCameraZoom: () => zoom, setCameraZoom: vi.fn((next: number) => { zoom = next; }),
  } satisfies ComparisonViewer;
  return fake;
}
function surface(id: string): Surface {
  return { resultId: id, step: 'static', positions: Float32Array.from([0, 0, 0, id === 'old' ? 1 : 2, 0, 0, 0, 1, 0]),
    indices: Uint32Array.of(0, 1, 2), triBody: Uint32Array.of(0), triFace: Uint32Array.of(0), bodyNames: [`body-${id}`], faceNames: [`face-${id}`],
    setNames: [`set-${id}`], triSetOffsets: Uint32Array.of(0, 1), triSets: Uint32Array.of(0) };
}
const summaries: Record<string, ResultSummary> = Object.fromEntries(['old', 'new'].map(id => [id, {
  ...RESULT, resultId: id, stale: id === 'old', extremes: [RESULT.extremes[0]!, { ...RESULT.extremes[0]!, field: 'vonMises', min: q(0, 'MPa'), max: q(6, 'MPa') }],
}]));
const fields = (id: string, field: string): ResultField => ({ resultId: id, step: 'static', field, components: field === 'displacement' ? 3 : 1,
  per: 'node', entityCount: 3, nodeCount: 3, unit: field === 'displacement' ? 'm' : 'Pa',
  values: field === 'displacement' ? [0, 0, 0, 0.001234567891, 0, 0, 0, 0.002, 0] : [0, 3e6, 6e6] });
function setup() {
  let catalogue: RetainedResults = { limit: 8, records: ['old', 'new'].map((id, i) => ({ id, step: 'static', solvedRevision: i, modelName: id, modelHash: id, inputHash: id, stale: id === 'old', nodes: 3, elements: 1, fieldBytes: 72, meshBytes: 100, modelJsonBytes: 100 })) };
  let reply: ((query: Query) => Promise<QueryResult>) | null = null;
  const transport: EngineTransport = fakeTransport();
  transport.surface = vi.fn(async selector => surface(selector!.resultId!));
  const answer: EngineTransport['query'] = async query => {
    if (query.query === 'query.results') return catalogue;
    if (query.query === 'query.result') return summaries[query.resultId!]!;
    if (query.query === 'query.field') return fields(query.resultId!, query.field);
    if (query.query === 'query.convert') {
      const { value, unit } = query.quantity as Valued;
      const factors: Record<string, number> = { m: 1, mm: 0.001, Pa: 1, MPa: 1e6, K: 1, degC: 1 };
      if (!(unit in factors) || !(query.to in factors) || ((unit === 'm' || unit === 'mm') !== (query.to === 'm' || query.to === 'mm')))
        throw new FemError('unit.dimension', 'unit dimensions differ');
      return q((value * factors[unit]! + (unit === 'degC' ? 273.15 : 0) - (query.to === 'degC' ? 273.15 : 0)) / factors[query.to]!, query.to);
    }
    throw new Error(`unexpected ${query.query}`);
  };
  transport.query = vi.fn(async query => reply ? reply(query) : answer(query));
  const store = new Store(), left = viewer(), right = viewer();
  const lifecycle = { pauseSingle: vi.fn(), restoreSingle: vi.fn(async () => undefined) };
  const comparison = new ResultComparison(store, transport, { left: { current: left }, right: { current: right } }, lifecycle);
  return { store, left, right, transport, lifecycle, comparison, catalogue: (next: RetainedResults) => { catalogue = next; },
    reply: (next: (query: Query, original: EngineTransport['query']) => Promise<QueryResult>) => { reply = query => next(query, answer); } };
}

it('pins independent retained surfaces/fields, units, legends and exact scientific picks after an edit or new solve', async () => {
  const { comparison, left, right, catalogue, store } = setup();
  await comparison.configure(pair);
  expect(left.setSurface.mock.lastCall?.[0].resultId).toBe('old');
  expect(right.setSurface.mock.lastCall?.[0].resultId).toBe('new');
  expect(comparison.state().left?.legend?.max).toEqual(q(2, 'mm'));
  expect(comparison.state().right?.legend?.max).toEqual(q(6, 'MPa'));
  await comparison.legend({ pane: 'left', resultId: 'old', range: [q(0, 'm'), q(0.004, 'm')], colormap: 'turbo' });
  expect(comparison.state().left?.legend?.max).toEqual(q(4, 'mm'));
  expect(comparison.state().right?.legend?.automatic).toBe(true);
  const pick = await comparison.pick({ pane: 'left', resultId: 'old', at: [q(1001.234567891, 'mm'), q(0), q(0)], face: 'set-old' });
  expect(pick?.value).toEqual(q(0.001234567891));
  expect(store.state.selection.refs).toEqual([]);
  const next = comparison.state().catalogue;
  catalogue({ ...next, records: next.records.map(record => ({ ...record, stale: true })) });
  await comparison.refresh();
  expect(comparison.state().configuration).toEqual(pair);
  expect(comparison.state().left?.summary.stale).toBe(true);
  expect(comparison.state().right?.summary.stale).toBe(true);
  expect(comparison.state().left?.legend?.max).toEqual(q(4, 'mm'));
});

it('scopes visibility and picks to each retained body/id and refuses obsolete or dimensional actions', async () => {
  const { comparison, right } = setup(); await comparison.configure(pair);
  comparison.visible({ pane: 'left', resultId: 'old', bodies: ['body-old'], on: false });
  expect(comparison.state().right?.hiddenBodies).toEqual([]);
  expect(right.setVisible).not.toHaveBeenCalledWith(['body-old'], false);
  expect(await comparison.pick({ pane: 'left', resultId: 'old', at: [q(1), q(0), q(0)] })).toBeNull();
  expect(() => comparison.visible({ pane: 'left', resultId: 'new', bodies: [], on: false })).toThrowError(expect.objectContaining({ code: 'result.stale' }));
  expect(() => comparison.visible({ pane: 'left', resultId: 'old', bodies: ['body-new'], on: false })).toThrowError(expect.objectContaining({ code: 'not-found' }));
  await expect(comparison.pick({ pane: 'left', resultId: 'old', at: [q(1), q(0), q(0)], face: 'current-face' })).rejects.toMatchObject({ code: 'not-found' });
  await expect(comparison.legend({ pane: 'left', resultId: 'old', range: [q(0, 'MPa'), q(1, 'MPa')] })).rejects.toMatchObject({ code: 'unit.dimension' });
});

it('shares camera, orthographic span and zoom across unequal meshes without changing their topology', async () => {
  const { comparison, left, right } = setup(); await comparison.configure(pair);
  expect(left.setComparisonFrameHeight.mock.lastCall).toEqual(right.setComparisonFrameHeight.mock.lastCall);
  right.setCamera({ position: [8, 7, 6], target: [1, 0, 0] }); right.setCameraZoom(2.5);
  comparison.cameraChanged('right');
  expect(left.getCamera()).toEqual(right.getCamera()); expect(left.getCameraZoom()).toBe(2.5);
  comparison.preset('top');
  expect(left.preset).toHaveBeenCalledWith('top', { min: [0, 0, 0], max: [2, 1, 0] });
});

it('suspends comparison for current geometry/mesh and resumes the same pins; single resets independent hides', async () => {
  const { comparison, store, left, lifecycle } = setup(); await comparison.configure(pair);
  comparison.visible({ pane: 'left', resultId: 'old', bodies: ['body-old'], on: false });
  store.set({ viewMode: 'geometry' }); comparison.suspend(); left.setSurface.mockClear(); comparison.resume();
  expect(left.setSurface).not.toHaveBeenCalled();
  await expect(comparison.pick({ pane: 'left', resultId: 'old', at: [q(0), q(0), q(0)] })).rejects.toMatchObject({ code: 'unsupported' });
  store.set({ viewMode: 'results' }); comparison.resume();
  expect(left.setSurface.mock.lastCall?.[0].resultId).toBe('old');
  await comparison.configure({ mode: 'single' });
  expect(lifecycle.restoreSingle).toHaveBeenCalledTimes(1);
  expect(left.setVisible).toHaveBeenCalledWith(['body-old', 'body-new'], true);
  expect(comparison.state().configuration.mode).toBe('single');
});

const diff = (values: (number | null)[]): DifferenceField => ({ left: { ...operand('old'), step: 'static', sourceComponents: 3 }, right: { ...operand('new', 'displacement'), step: 'static', sourceComponents: 3 }, comparisonResultId: 'new', components: 1, nodeCount: 3, unit: 'm', values,
  interpolated: true, coverage: { insideNodes: values.filter(v => v !== null).length, totalNodes: 3, outsideNodes: values.flatMap((v, i) => v === null ? [i] : []) }, warnings: [] });
it('uses the engine difference on the explicit target surface with nullable coverage, rather than staged pane subtraction', async () => {
  const { comparison, left, reply, catalogue } = setup();
  reply(async (query, original) => query.query === 'query.difference' ? diff([0.001234567891, null, -0.003]) : original(query));
  await comparison.configure({ mode: 'difference', left: operand('old', 'displacement', 0), right: operand('new', 'displacement', 0), onto: 'right' });
  expect(left.setSurface.mock.lastCall?.[0].resultId).toBe('new');
  expect(comparison.state().difference?.legend?.min).toEqual(q(-3, 'mm'));
  expect(left.setFieldValidity).toHaveBeenLastCalledWith(Uint8Array.of(1, 0, 1));
  expect((await comparison.pick({ pane: 'difference', resultId: 'new', at: [q(2.001234567891), q(0), q(0)] }))?.value).toBeNull();
  comparison.preset('front'); expect(left.preset).toHaveBeenCalledWith('front', { min: [0, 0, 0], max: [2, 1, 0] });
  const before = comparison.state().catalogue;
  catalogue({ ...before, records: before.records.filter(record => record.id !== 'old') }); await comparison.refresh();
  expect(comparison.state().difference?.error).toMatchObject({ code: 'not-found', cause: expect.stringContaining('old') });
  expect(left.setSurface.mock.lastCall?.[0].positions.length).toBe(0);
});

it('leaves wholly uncovered differences neutral with no invented zero legend, and reports engine rejection unchanged', async () => {
  const { comparison, reply } = setup();
  reply(async (query, original) => query.query === 'query.difference' ? diff([null, null, null]) : original(query));
  await comparison.configure({ mode: 'difference', left: operand('old'), right: operand('new', 'displacement'), onto: 'right' });
  expect(comparison.state().difference?.legend).toBeNull();
  await comparison.legend({ pane: 'difference', resultId: 'new', range: 'auto' });
  expect(comparison.state().difference?.legend).toBeNull();
  reply(async (query, original) => { if (query.query === 'query.difference') throw new FemError('unsupported', 'element-node fields cannot be differenced'); return original(query); });
  await expect(comparison.configure({ mode: 'difference', left: operand('old'), right: operand('new'), onto: 'left' })).rejects.toMatchObject({ code: 'unsupported' });
  expect(comparison.state().error?.cause).toBe('element-node fields cannot be differenced');
});

it('uses difference amounts rather than absolute temperature offsets for contours and unit-bearing clamps', async () => {
  const { comparison, reply } = setup();
  reply(async (query, original) => {
    if (query.query === 'query.result') return { ...summaries[query.resultId!]!, extremes: [{ ...RESULT.extremes[0]!, field: 'temperature', min: q(0, 'degC'), max: q(100, 'degC') }] };
    if (query.query === 'query.field') return { ...fields(query.resultId!, 'temperature'), unit: 'K', values: [273.15, 283.15, 293.15] };
    if (query.query === 'query.difference') return { ...diff([-5, 10, null]), unit: 'K', left: { ...diff([]).left, field: 'temperature', sourceComponents: 1 }, right: { ...diff([]).right, field: 'temperature', sourceComponents: 1 } };
    return original(query);
  });
  await comparison.configure({ mode: 'difference', left: operand('old', 'temperature'), right: operand('new', 'temperature'), onto: 'right' });
  expect(comparison.state().difference?.legend?.min).toEqual(q(-5, 'degC'));
  expect(comparison.state().difference?.legend?.max).toEqual(q(10, 'degC'));
  await comparison.legend({ pane: 'difference', resultId: 'new', range: [q(-10, 'K'), q(20, 'K')] });
  expect(comparison.state().difference?.legend?.min).toEqual(q(-10, 'degC'));
  expect(comparison.state().difference?.legend?.max).toEqual(q(20, 'degC'));
});

it('fences late surface replies after a new configuration or project disposal and rejects wrong retained identities', async () => {
  const { comparison, transport, left } = setup();
  let release!: (value: Surface) => void;
  transport.surface = vi.fn(selector => selector!.resultId === 'old' ? new Promise<Surface>(resolve => { release = resolve; }) : Promise.resolve(surface('new')));
  const pending = comparison.configure(pair);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await comparison.configure({ mode: 'single' }); release(surface('old')); await pending;
  expect(comparison.state().configuration.mode).toBe('single'); expect(left.setSurface).not.toHaveBeenCalled();
  transport.surface = vi.fn(async () => surface('wrong'));
  await expect(comparison.configure(pair)).rejects.toMatchObject({ code: 'result.stale' });
  comparison.dispose(); await expect(comparison.configure(pair)).rejects.toMatchObject({ code: 'session.expired' });
});
