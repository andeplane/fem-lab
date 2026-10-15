import { FemError, type DifferenceField, type EngineTransport, type FrameResult, type FramesResult, type Query, type QueryResult, type ResultField, type ResultSummary, type RetainedResults, type Surface, type Valued } from '@femlab/registry';
import { expect, it, vi } from 'vitest';
import { fakeTransport, RESULT } from '../../registry/test/fakes';
import { ResultComparison, type ComparisonViewer } from '../src/result-comparison';
import { Store } from '../src/store';
import type { CameraState } from '../src/viewer/viewer';
import type { PlaybackClock } from '../src/transient';

const operand = (resultId: string, field = 'displacement', component?: number) => ({ resultId, field, ...(component === undefined ? {} : { component }) });
const pair = { mode: 'sideBySide' as const, left: operand('old'), right: operand('new', 'vonMises') };
const q = (value: number, unit = 'm'): Valued => ({ value, unit });
function viewer() {
  let camera: CameraState = { position: [3, 4, 5], target: [0, 0, 0] }, zoom = 1;
  const fake = {
    animate: vi.fn(), setField: vi.fn(), setDeformed: vi.fn(), setSurface: vi.fn(), setVisible: vi.fn(), setMode: vi.fn(),
    setDim: vi.fn(), setColormap: vi.fn(), setFieldValidity: vi.fn(), setSelection: vi.fn(), preset: vi.fn(), setProjection: vi.fn(), getProjection: () => 'perspective' as const,
    setLayer: vi.fn(() => true), setClip: vi.fn(), setTheme: vi.fn(), setHover: vi.fn(), setHighlight: vi.fn(),
    viewportAspect: vi.fn(() => 4 / 3), screenshot: vi.fn((_legend?: Parameters<ComparisonViewer['screenshot']>[0], _options?: Parameters<ComparisonViewer['screenshot']>[1]) => 'data:image/png;base64,pane'),
    setCamera: vi.fn((next: CameraState) => { camera = next; if (next.zoom !== undefined) zoom = next.zoom; }), getCamera: () => camera,
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
function setup(clock?: PlaybackClock) {
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
      const factors: Record<string, number> = { m: 1, mm: 0.001, Pa: 1, MPa: 1e6, K: 1, degC: 1, s: 1, ms: 0.001, min: 60 };
      const dimensions: Record<string, string> = { m: 'length', mm: 'length', Pa: 'pressure', MPa: 'pressure', K: 'temperature', degC: 'temperature', s: 'time', ms: 'time', min: 'time' };
      if (!(unit in factors) || !(query.to in factors) || dimensions[unit] !== dimensions[query.to])
        throw new FemError('unit.dimension', 'unit dimensions differ');
      return q((value * factors[unit]! + (unit === 'degC' ? 273.15 : 0) - (query.to === 'degC' ? 273.15 : 0)) / factors[query.to]!, query.to);
    }
    throw new Error(`unexpected ${query.query}`);
  };
  transport.query = vi.fn(async query => reply ? reply(query) : answer(query));
  const store = new Store(), left = viewer(), right = viewer();
  const lifecycle = { pauseSingle: vi.fn(), restoreSingle: vi.fn(async () => undefined) };
  const comparison = new ResultComparison(store, transport, { left: { current: left }, right: { current: right } }, lifecycle, clock);
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
  expect(left.preset).toHaveBeenCalledWith('top', { min: [0, 0, 0], max: [2, 1, 0] }, 1);
});

it('fits first entry only after the real panes mount, using their narrowest aspect exactly once', async () => {
  const { comparison, left, right } = setup(); comparison.viewers.right.current = null;
  await comparison.configure(pair);
  expect(left.preset).not.toHaveBeenCalled(); comparison.resize(); expect(left.preset).not.toHaveBeenCalled();
  left.viewportAspect.mockReturnValue(0.4); right.viewportAspect.mockReturnValue(0.5);
  comparison.viewers.right.current = right; comparison.resume();
  expect(left.preset).toHaveBeenCalledExactlyOnceWith('iso', { min: [0, 0, 0], max: [2, 1, 0] }, 0.4);
  comparison.resize(); comparison.resume(); await comparison.refresh();
  expect(left.preset).toHaveBeenCalledTimes(1);
});

it('lets a camera gesture or command during pane mounting win over the pending first fit', async () => {
  for (const action of ['gesture', 'command'] as const) {
    const { comparison, left, right } = setup(); comparison.viewers.right.current = null;
    await comparison.configure(pair);
    const chosen: CameraState = { position: [8, 7, 6], target: [1, 0, 0], zoom: 2 };
    if (action === 'gesture') { left.setCamera(chosen); comparison.cameraChanged('left'); } else comparison.setCamera(chosen);
    comparison.viewers.right.current = right; comparison.resume(); comparison.resize();
    expect(left.preset).not.toHaveBeenCalled(); expect(left.getCamera()).toEqual(chosen); expect(right.getCamera()).toEqual(chosen);
  }
});

it('preserves a camera gesture or command while the first comparison payloads are still loading', async () => {
  for (const action of ['gesture', 'command'] as const) {
    const { comparison, left, transport } = setup();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    transport.surface = vi.fn(async selector => { await gate; return surface(selector!.resultId!); });
    const loading = comparison.configure(pair);
    await vi.waitFor(() => expect(transport.surface).toHaveBeenCalledTimes(2));
    const chosen: CameraState = { position: [8, 7, 6], target: [1, 0, 0], zoom: 2 };
    if (action === 'gesture') { left.setCamera(chosen); comparison.cameraChanged('left'); } else comparison.setCamera(chosen);
    release(); await loading; comparison.resume(); comparison.resize();
    expect(left.preset).not.toHaveBeenCalled(); expect(left.getCamera()).toEqual(chosen);
  }
});

it('drops the pending layout fit after mode suspension, leaving comparison or disposal', async () => {
  for (const action of ['suspend', 'single', 'dispose'] as const) {
    const { comparison, left, right } = setup(); comparison.viewers.right.current = null;
    await comparison.configure(pair);
    if (action === 'suspend') comparison.suspend();
    else if (action === 'single') await comparison.configure({ mode: 'single' });
    else comparison.dispose();
    comparison.viewers.right.current = right; comparison.resume(); comparison.resize();
    expect(left.preset).not.toHaveBeenCalled();
  }
});

it('fits portrait panes with one shared world span, preserves camera on resize, and captures each pane with its own identity/legend', async () => {
  const { comparison, left, right } = setup();
  left.viewportAspect.mockReturnValue(0.25); right.viewportAspect.mockReturnValue(0.5);
  await comparison.configure(pair);
  expect(left.setComparisonFrameHeight.mock.lastCall?.[0]).toBeCloseTo(Math.sqrt(5) * 0.7 / 0.25);
  const before = left.getCamera();
  left.viewportAspect.mockReturnValue(0.5); right.viewportAspect.mockReturnValue(0.75); comparison.resize();
  expect(left.getCamera()).toEqual(before);
  expect(left.setComparisonFrameHeight.mock.lastCall?.[0]).toBeCloseTo(Math.sqrt(5) * 0.7 / 0.5);
  expect(left.setComparisonFrameHeight.mock.lastCall).toEqual(right.setComparisonFrameHeight.mock.lastCall);
  expect(comparison.capture({ width: 901, height: 500 })).toHaveLength(2);
  expect(left.screenshot).toHaveBeenLastCalledWith(expect.objectContaining({ unit: 'mm', max: 2 }), expect.objectContaining({ width: 451, height: 500, title: 'left · old · stale' }));
  expect(right.screenshot).toHaveBeenLastCalledWith(expect.objectContaining({ unit: 'MPa', max: 6 }), expect.objectContaining({ width: 450, height: 500, title: 'right · new · current' }));
  expect(() => comparison.capture({ width: 1 })).toThrowError(expect.objectContaining({ code: 'schema' }));
  const guard = comparison.captureGuard(); comparison.suspend();
  expect(guard).toThrowError(expect.objectContaining({ code: 'result.stale' }));
  const closed = comparison.captureGuard(); comparison.dispose();
  expect(closed).toThrowError(expect.objectContaining({ code: 'session.expired' }));
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
  expect(comparison.state().difference?.summary.stale).toBe(true);
  expect(comparison.state().difference?.legend?.min).toEqual(q(-3, 'mm'));
  expect(left.setFieldValidity).toHaveBeenLastCalledWith(Uint8Array.of(1, 0, 1));
  expect((await comparison.pick({ pane: 'difference', resultId: 'new', at: [q(2.001234567891), q(0), q(0)] }))?.value).toBeNull();
  comparison.preset('front'); expect(left.preset).toHaveBeenCalledWith('front', { min: [0, 0, 0], max: [2, 1, 0] }, 1);
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
  expect(comparison.state().difference?.canDeform).toBe(false);
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

it('allows independent concurrent pane clamps and merges late updates without undoing later body visibility', async () => {
  const { comparison, reply } = setup(); await comparison.configure(pair);
  const releases: (() => Promise<void>)[] = [];
  reply(async (query, original) => {
    if (query.query === 'query.convert' && [4, 12].includes((query.quantity as Valued).value))
      return new Promise(resolve => { releases.push(async () => resolve(await original(query))); });
    return original(query);
  });
  const pending = Promise.all([
    comparison.legend({ pane: 'left', resultId: 'old', range: [q(0, 'mm'), q(4, 'mm')] }),
    comparison.legend({ pane: 'right', resultId: 'new', range: [q(0, 'MPa'), q(12, 'MPa')] }),
  ]);
  await vi.waitFor(() => expect(releases).toHaveLength(2));
  comparison.visible({ pane: 'left', resultId: 'old', bodies: ['body-old'], on: false });
  await Promise.all(releases.map(release => release())); await pending;
  expect(comparison.state().left?.legend?.max).toEqual(q(4, 'mm'));
  expect(comparison.state().right?.legend?.max).toEqual(q(12, 'MPa'));
  expect(comparison.state().left?.hiddenBodies).toEqual(['body-old']);
});

it('uses the latest hidden bodies when a delayed pick finishes and never reopens that body', async () => {
  const { comparison, reply } = setup(); await comparison.configure(pair);
  let release!: () => Promise<void>;
  reply(async (query, original) => {
    if (query.query === 'query.convert' && (query.quantity as Valued).value === 1)
      return new Promise(resolve => { release = async () => resolve(await original(query)); });
    return original(query);
  });
  const pending = comparison.pick({ pane: 'left', resultId: 'old', at: [q(1), q(0), q(0)] });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  comparison.visible({ pane: 'left', resultId: 'old', bodies: ['body-old'], on: false });
  await release(); expect(await pending).toBeNull();
  expect(comparison.state().left?.hiddenBodies).toEqual(['body-old']);
});

it('cancels a first comparison load when the user explicitly switches to current geometry or mesh', async () => {
  for (const mode of ['geometry', 'mesh'] as const) {
    const { comparison, store, transport, left } = setup();
    let release!: (value: Surface) => void;
    transport.surface = vi.fn(selector => selector!.resultId === 'old' ? new Promise<Surface>(resolve => { release = resolve; }) : Promise.resolve(surface('new')));
    const pending = comparison.configure(pair);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    store.set({ viewMode: mode }); comparison.suspend(); release(surface('old')); await pending;
    expect(store.state.viewMode).toBe(mode); expect(comparison.state().loading).toBe(false);
    expect(comparison.state().configuration.mode).toBe('single'); expect(left.setSurface).not.toHaveBeenCalled();
  }
});

it('does not overwrite a concurrent Model edit or eviction with status captured before deferred payload reads', async () => {
  for (const evicted of [false, true]) {
    const { comparison, catalogue, transport } = setup(); await comparison.configure(pair);
    let release!: (value: Surface) => void;
    transport.surface = vi.fn(selector => selector!.resultId === 'old' ? new Promise<Surface>(resolve => { release = resolve; }) : Promise.resolve(surface('new')));
    const pending = comparison.configure({ ...pair, left: operand('old', 'displacement', 0) });
    const rejected = evicted ? expect(pending).rejects.toMatchObject({ code: 'not-found' }) : pending;
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const current = comparison.state().catalogue;
    catalogue({ ...current, records: current.records.filter(r => !evicted || r.id !== 'new').map(r => ({ ...r, stale: true })) });
    await comparison.refresh(); release(surface('old')); await rejected;
    expect(comparison.state().catalogue.records.every(record => record.stale)).toBe(true);
    if (evicted) expect(comparison.state().right?.error?.code).toBe('not-found');
    else expect(comparison.state().right?.summary.stale).toBe(true);
  }
});

function history(id: string, field: 'temperature' | 'displacement' = 'displacement'): FramesResult {
  return { resultId: id, step: 'static', modelHash: id, stale: id === 'old', nodeCount: 3, field, components: 3, storedComponents: field === 'temperature' ? 1 : 3, retainedBytes: 240,
    frames: [0, 0.4, 0.8].map((timeSi, index) => ({ index, timeSi, time: q(timeSi * 1000, 'ms') })) };
}
function retainedFrame(id: string, index: number, field: 'temperature' | 'displacement' = 'displacement'): FrameResult {
  const frame = history(id, field).frames[index]!;
  return { sample: { resultId: id, step: 'static', modelHash: id, frame }, field, components: 3, nodeCount: 3, unit: field === 'temperature' ? 'K' : 'm',
    values: field === 'temperature' ? [273.15 + frame.timeSi, 0, 0, 273.15 + frame.timeSi, 0, 0, 273.15 + frame.timeSi, 0, 0] : [0, 0, 0, 0.001 * frame.timeSi, 0, 0, 0, 0.002 * frame.timeSi, 0] };
}
it('uses independently retained primary arrays for contour, deformation, legends, scientific picks and capture times', async () => {
  const { comparison, left, right, reply } = setup();
  reply(async (query, original) => {
    if (query.query === 'query.frames') return history(query.resultId!);
    if (query.query === 'query.frame') return retainedFrame(query.resultId!, query.sample?.kind === 'frame' ? query.sample.index : 2);
    return original(query);
  });
  await comparison.configure({ mode: 'sideBySide', left: { ...operand('old', 'displacement', 0), sample: { kind: 'frame', index: 1 } }, right: { ...operand('new', 'displacement', 1), sample: { kind: 'time', time: '800 ms', sampling: 'exact' } } });
  expect(comparison.state().left?.sample?.frame.time).toEqual(q(400, 'ms'));
  expect(comparison.state().right?.sample?.frame.index).toBe(2);
  expect(left.setDeformed).toHaveBeenLastCalledWith(Float32Array.from(retainedFrame('old', 1).values), 1);
  expect(right.setDeformed).toHaveBeenLastCalledWith(Float32Array.from(retainedFrame('new', 2).values), 1);
  expect(comparison.state().left?.legend?.max).toEqual(q(0.4, 'mm'));
  const pick = await comparison.pick({ pane: 'left', resultId: 'old', at: [q(1.0004), q(0), q(0)] });
  expect(pick?.value).toEqual(q(0.0004));
  expect(pick?.samples.left?.frame.index).toBe(1);
  expect(pick?.samples.right?.frame.index).toBe(2);
  comparison.capture({ width: 900 });
  expect(left.screenshot.mock.lastCall?.[1]?.title).toContain('frame 1 · 400 ms');
  expect(right.screenshot.mock.lastCall?.[1]?.title).toContain('frame 2 · 800 ms');
});

it('uses a sampled thermal scalar without final-summary displacement, and verifies both engine difference sample receipts', async () => {
  const { comparison, left, reply } = setup();
  reply(async (query, original) => {
    if (query.query === 'query.result') return { ...summaries[query.resultId!]!, extremes: [...summaries[query.resultId!]!.extremes, { ...RESULT.extremes[0]!, field: 'temperature', min: q(0, 'degC'), max: q(1, 'degC') }] };
    if (query.query === 'query.frames') return history(query.resultId!, 'temperature');
    if (query.query === 'query.frame') return retainedFrame(query.resultId!, query.sample?.kind === 'frame' ? query.sample.index : 2, 'temperature');
    if (query.query === 'query.difference') return { ...diff([-0.4, -0.4, null]), unit: 'K', left: { ...diff([]).left, field: 'temperature', sample: retainedFrame('old', 1, 'temperature').sample }, right: { ...diff([]).right, field: 'temperature', sample: retainedFrame('new', 2, 'temperature').sample } };
    return original(query);
  });
  const configuration = { mode: 'difference' as const, left: { ...operand('old', 'temperature', 0), sample: { kind: 'frame' as const, index: 1 } }, right: { ...operand('new', 'temperature', 0), sample: { kind: 'frame' as const, index: 2 } }, onto: 'right' as const };
  await comparison.configure(configuration);
  expect(comparison.state().left?.canDeform).toBe(false);
  expect(comparison.state().difference?.canDeform).toBe(false);
  expect(left.setDeformed).toHaveBeenLastCalledWith(null, 1);
  expect(comparison.state().difference?.legend?.min.value).toBeCloseTo(-0.4);
  expect(comparison.state().difference?.legend?.min.unit).toBe('degC');
  comparison.capture({ width: 900 });
  expect(left.screenshot.mock.lastCall?.[1]?.title).toContain('left old frame 1 · 400 ms · right new frame 2 · 800 ms');
  const before = comparison.state().configuration;
  reply(async (query, original) => {
    if (query.query === 'query.frames') return history(query.resultId!, 'temperature');
    if (query.query === 'query.frame') return retainedFrame(query.resultId!, query.sample?.kind === 'frame' ? query.sample.index : 2, 'temperature');
    if (query.query === 'query.difference') return { ...diff([0, 0, 0]), left: { ...diff([]).left, sample: retainedFrame('old', 0, 'temperature').sample } };
    return original(query);
  });
  await expect(comparison.configure(configuration)).rejects.toMatchObject({ code: 'result.stale', where: 'sample' });
  expect(comparison.state().configuration).toEqual(before);
});

it('refuses historical derived fields and a wrong catalogue, and fences delayed frame completion after leaving Results', async () => {
  const { comparison, left, reply, store } = setup();
  reply(async (query, original) => query.query === 'query.frames' ? history(query.resultId!) : original(query));
  await expect(comparison.configure({ ...pair, right: { ...pair.right, sample: { kind: 'frame', index: 0 } } })).rejects.toMatchObject({ code: 'unsupported', where: 'field' });
  expect(left.setSurface).not.toHaveBeenCalled();
  reply(async (query, original) => query.query === 'query.frames' ? history('different-engine-id') : original(query));
  await expect(comparison.configure({ ...pair, left: { ...pair.left, sample: { kind: 'frame', index: 0 } } })).rejects.toMatchObject({ code: 'result.stale' });
  let release!: (value: FrameResult) => void;
  reply(async (query, original) => {
    if (query.query === 'query.frames') return history(query.resultId!);
    if (query.query === 'query.frame') return new Promise<FrameResult>(resolve => { release = resolve; });
    return original(query);
  });
  const pending = comparison.configure({ ...pair, left: { ...pair.left, sample: { kind: 'frame', index: 1 } } });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  store.set({ viewMode: 'mesh' }); comparison.suspend();
  release(retainedFrame('old', 1)); await pending;
  expect(store.state.viewMode).toBe('mesh');
  expect(left.setSurface).not.toHaveBeenCalled();
});

it('merges simultaneous independent sampled selections without restoring the other pane or its controls', async () => {
  const { comparison, left, right, reply, transport } = setup();
  let hold = false, release!: (value: RetainedResults) => void, receipt: RetainedResults | null = null;
  reply(async (query, original) => {
    if (query.query === 'query.frames') return history(query.resultId!);
    if (query.query === 'query.frame') return retainedFrame(query.resultId!, query.sample?.kind === 'frame' ? query.sample.index : 0);
    if (hold && query.query === 'query.results') {
      hold = false; receipt = await original(query) as RetainedResults;
      return new Promise<RetainedResults>(resolve => { release = resolve; });
    }
    return original(query);
  });
  await comparison.configure({ mode: 'sideBySide', left: { ...operand('old', 'displacement', 0), sample: { kind: 'frame', index: 0 } }, right: { ...operand('new', 'displacement', 1), sample: { kind: 'frame', index: 0 } } });
  await comparison.legend({ pane: 'right', resultId: 'new', range: [q(0), q(0.003)] });
  comparison.visible({ pane: 'right', resultId: 'new', bodies: ['body-new'], on: false });
  hold = true;
  const pending = comparison.play({ mode: 'independent', pane: 'left', resultId: 'old', playing: false, sample: { kind: 'frame', index: 1 } });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await comparison.play({ mode: 'independent', pane: 'right', resultId: 'new', playing: false, sample: { kind: 'frame', index: 2 } });
  release(receipt!); await pending;
  expect(comparison.state().left?.sample?.frame.index).toBe(1); expect(comparison.state().right?.sample?.frame.index).toBe(2);
  expect(comparison.state().right?.legend?.max).toEqual(q(3, 'mm')); expect(comparison.state().right?.hiddenBodies).toEqual(['body-new']);
  expect(left.setDeformed).toHaveBeenLastCalledWith(Float32Array.from(retainedFrame('old', 1).values), 1);
  expect(right.setDeformed).toHaveBeenLastCalledWith(Float32Array.from(retainedFrame('new', 2).values), 1);
  expect(transport.dispatch).not.toHaveBeenCalled();
});

it('recomputes a sampled thermal difference and its scientific pick for the actual newly selected pair', async () => {
  const { comparison, left, reply } = setup();
  reply(async (query, original) => {
    if (query.query === 'query.result') return { ...summaries[query.resultId!]!, extremes: [{ ...RESULT.extremes[0]!, field: 'temperature', min: q(0, 'degC'), max: q(1, 'degC') }] };
    if (query.query === 'query.frames') return history(query.resultId!, 'temperature');
    if (query.query === 'query.frame') return retainedFrame(query.resultId!, query.sample?.kind === 'frame' ? query.sample.index : 0, 'temperature');
    if (query.query === 'query.difference') {
      const lf = retainedFrame('old', query.left.sample?.kind === 'frame' ? query.left.sample.index : 0, 'temperature');
      const rf = retainedFrame('new', query.right.sample?.kind === 'frame' ? query.right.sample.index : 0, 'temperature');
      const value = lf.sample.frame.timeSi - rf.sample.frame.timeSi;
      return { ...diff([value, value, null]), comparisonResultId: query.onto === 'left' ? 'old' : 'new', unit: 'K', left: { ...diff([]).left, field: 'temperature', sample: lf.sample }, right: { ...diff([]).right, field: 'temperature', sample: rf.sample } };
    }
    return original(query);
  });
  await comparison.configure({ mode: 'difference', onto: 'left', left: { ...operand('old', 'temperature', 0), sample: { kind: 'frame', index: 0 } }, right: { ...operand('new', 'temperature', 0), sample: { kind: 'frame', index: 0 } } });
  await comparison.play({ mode: 'independent', pane: 'left', resultId: 'old', playing: false, sample: { kind: 'frame', index: 1 } });
  await comparison.play({ mode: 'independent', pane: 'right', resultId: 'new', playing: false, sample: { kind: 'frame', index: 2 } });
  expect(comparison.state().difference?.legend?.min).toEqual(q(-0.4, 'degC'));
  expect(comparison.state().difference?.canDeform).toBe(false);
  expect(left.setFieldValidity).toHaveBeenLastCalledWith(Uint8Array.of(1, 1, 0));
  const pick = await comparison.pick({ pane: 'difference', resultId: 'old', at: [q(0), q(0), q(0)] });
  expect(pick?.value).toEqual(q(-0.4, 'K'));
  expect(pick?.samples.left?.frame.index).toBe(1); expect(pick?.samples.right?.frame.index).toBe(2);
});

it('drops delayed playback drawings after mode/session changes and refuses an evicted final status receipt', async () => {
  for (const action of ['suspend', 'dispose', 'evict'] as const) {
    const { comparison, left, reply, store, catalogue } = setup();
    let release!: (value: FrameResult) => void, hold = false;
    reply(async (query, original) => {
      if (query.query === 'query.frames') return history(query.resultId!);
      if (query.query === 'query.frame') {
        if (hold && query.resultId === 'old' && query.sample?.kind === 'frame' && query.sample.index === 2) return new Promise<FrameResult>(resolve => { release = resolve; });
        return retainedFrame(query.resultId!, query.sample?.kind === 'frame' ? query.sample.index : 0);
      }
      return original(query);
    });
    await comparison.configure({ mode: 'sideBySide', left: operand('old', 'displacement', 0), right: operand('new', 'displacement', 0) });
    const drawing = left.setField.mock.calls.length;
    hold = true;
    const pending = comparison.play({ mode: 'independent', pane: 'left', resultId: 'old', playing: false, sample: { kind: 'frame', index: 2 } });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    if (action === 'suspend') { store.set({ viewMode: 'mesh' }); comparison.suspend(); }
    else if (action === 'dispose') comparison.dispose();
    else catalogue({ ...comparison.state().catalogue, records: comparison.state().catalogue.records.filter(record => record.id !== 'old') });
    release(retainedFrame('old', 2));
    if (action === 'evict') await expect(pending).rejects.toMatchObject({ code: 'not-found', where: 'left.resultId' });
    else await pending;
    if (action === 'evict') {
      await vi.waitFor(() => expect(comparison.state().left?.error?.code).toBe('not-found'));
      expect(left.setField).toHaveBeenLastCalledWith(null, [0, 1]);
      expect(left.setSurface.mock.lastCall?.[0].positions).toHaveLength(0);
    } else expect(left.setField.mock.calls).toHaveLength(drawing);
    expect(comparison.state().left?.sample).toBeNull();
    expect(comparison.state().playback).toBeNull();
  }
});

it('keeps a newer status receipt when an older concurrent catalogue refresh arrives last', async () => {
  const s = setup(); await s.comparison.configure(pair);
  let release!: (value: RetainedResults) => void, first = true;
  const old = s.comparison.state().catalogue;
  s.reply(async (query, original) => query.query === 'query.results' && first
    ? (first = false, new Promise<RetainedResults>(resolve => { release = resolve; })) : original(query));
  const pending = s.comparison.refresh();
  const evicted = { ...old, records: old.records.filter(record => record.id !== 'old').map(record => ({ ...record, stale: true })) };
  s.catalogue(evicted); await s.comparison.refresh();
  expect(s.comparison.state().left?.error?.code).toBe('not-found');
  release(old); await pending;
  expect(s.comparison.state().catalogue).toEqual(evicted);
  expect(s.comparison.state().left?.error?.code).toBe('not-found');
  expect(s.comparison.state().right?.summary.stale).toBe(true);
  expect(s.left.setField).toHaveBeenLastCalledWith(null, [0, 1]);
});

function scrubSetup() {
  let now = 0, next = 0;
  const scheduled = new Map<number, () => void>();
  const clock: PlaybackClock = { now: () => now, schedule: callback => { scheduled.set(++next, callback); return next; }, cancel: handle => { scheduled.delete(handle as number); } };
  const s = setup(clock);
  const answer = async (query: Query, original: EngineTransport['query']): Promise<QueryResult> => {
    if (query.query === 'query.frames') return history(query.resultId!);
    if (query.query === 'query.frame') {
      let index = query.sample?.kind === 'frame' ? query.sample.index : 0;
      if (query.sample?.kind === 'time') {
        const quantity = query.sample.time as Valued;
        const time = quantity.value * (quantity.unit === 'ms' ? 0.001 : quantity.unit === 'min' ? 60 : 1);
        index = history(query.resultId!).frames.findIndex(frame => Math.abs(frame.timeSi - time) < 1e-12);
        if (index < 0) throw new FemError('not-found', 'exact time is not retained', 'sample.time');
      }
      return retainedFrame(query.resultId!, index);
    }
    return original(query);
  };
  s.reply(answer);
  const configuration = { mode: 'sideBySide' as const, left: { ...operand('old', 'displacement', 0), sample: { kind: 'frame' as const, index: 0 } }, right: { ...operand('new', 'displacement', 0), sample: { kind: 'frame' as const, index: 0 } } };
  const advance = async (ms: number) => {
    now += ms; const callbacks = [...scheduled.values()]; scheduled.clear(); callbacks.forEach(callback => callback());
    for (let i = 0; i < 50; i++) await Promise.resolve();
  };
  return { ...s, answer, configuration, scheduled, advance };
}

it('cancels an independent preview to its captured field/clock while preserving the other advancing pane and controls', async () => {
  const s = scrubSetup(); await s.comparison.configure(s.configuration);
  await s.comparison.play({ mode: 'independent', pane: 'left', resultId: 'old', playing: true, speed: 2 });
  await s.comparison.play({ mode: 'independent', pane: 'right', resultId: 'new', playing: true });
  await s.advance(150);
  const ticket = s.comparison.beginScrub('left');
  await s.comparison.previewScrub(ticket, { mode: 'independent', pane: 'left', resultId: 'old', playing: false, sample: { kind: 'frame', index: 2 } });
  await s.comparison.legend({ pane: 'right', resultId: 'new', range: [q(0), q(0.003)] });
  s.comparison.visible({ pane: 'right', resultId: 'new', bodies: ['body-new'], on: false });
  await s.advance(450);
  expect(s.comparison.state().left?.sample?.frame.index).toBe(2); expect(s.comparison.state().right?.sample?.frame.index).toBe(1);
  await s.comparison.cancelScrub(ticket);
  expect(s.comparison.state().left?.sample?.frame.index).toBe(0); expect(s.comparison.state().right?.sample?.frame.index).toBe(1);
  expect(s.comparison.state().playback?.left).toMatchObject({ playing: true, speed: 2, playheadSi: 0.3 });
  expect(s.comparison.state().right?.hiddenBodies).toEqual(['body-new']); expect(s.comparison.state().right?.legend?.max).toEqual(q(3, 'mm'));
  await s.advance(60); expect(s.comparison.state().left?.sample?.frame.index).toBe(1);
  s.comparison.pausePlayback(); expect(s.scheduled.size).toBe(0); expect(s.transport.dispatch).not.toHaveBeenCalled();
});

it('restores both samples, shared physical playhead and playing state on a synchronized preview cancel', async () => {
  const s = scrubSetup(); await s.comparison.configure(s.configuration);
  await s.comparison.play({ mode: 'synchronized', leftResultId: 'old', rightResultId: 'new', playing: true, time: q(0, 's'), sampling: 'exact' });
  await s.advance(250);
  const ticket = s.comparison.beginScrub('synchronized');
  await s.comparison.previewScrub(ticket, { mode: 'synchronized', leftResultId: 'old', rightResultId: 'new', playing: false, time: q(800, 'ms'), sampling: 'exact' });
  expect(s.comparison.state().left?.sample?.frame.index).toBe(2); expect(s.comparison.state().right?.sample?.frame.index).toBe(2);
  await s.comparison.cancelScrub(ticket);
  expect(s.comparison.state().left?.sample?.frame.index).toBe(0); expect(s.comparison.state().right?.sample?.frame.index).toBe(0);
  expect(s.comparison.state().playback).toMatchObject({ mode: 'synchronized', playheadSi: 0.25, sampling: 'exact', left: { playing: true }, right: { playing: true } });
  await s.advance(160); expect(s.comparison.state().left?.sample?.frame.index).toBe(1); expect(s.comparison.state().right?.sample?.frame.index).toBe(1);
  s.comparison.pausePlayback(); expect(s.scheduled.size).toBe(0);
});

it('restores a final field after scrub cancellation and drops its still-pending preview frame', async () => {
  const s = scrubSetup(); await s.comparison.configure({ mode: 'sideBySide', left: operand('old', 'displacement', 0), right: operand('new', 'displacement', 0) });
  const before = s.comparison.state(), ticket = s.comparison.beginScrub('left');
  let release!: (value: FrameResult) => void;
  s.reply(async (query, original) => query.query === 'query.frame' && query.resultId === 'old' && query.sample?.kind === 'frame' && query.sample.index === 2 ? new Promise(resolve => { release = resolve; }) : s.answer(query, original));
  const pending = s.comparison.previewScrub(ticket, { mode: 'independent', pane: 'left', resultId: 'old', playing: false, sample: { kind: 'frame', index: 2 } });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await s.comparison.cancelScrub(ticket); release(retainedFrame('old', 2)); await pending;
  expect(s.comparison.state().configuration).toEqual(before.configuration); expect(s.comparison.state().left?.sample).toBeNull(); expect(s.comparison.state().playback).toBeNull();
  expect(s.left.setDeformed).toHaveBeenLastCalledWith(Float32Array.from(fields('old', 'displacement').values), 1);
});

it('refuses copied or retired gesture receipts and never cancels newer selections, Model edits or projects', async () => {
  for (const action of ['selection', 'modelWrite', 'suspend', 'project'] as const) {
    const s = scrubSetup(); await s.comparison.configure(s.configuration);
    const ticket = s.comparison.beginScrub('left');
    await s.comparison.previewScrub(ticket, { mode: 'independent', pane: 'left', resultId: 'old', playing: false, sample: { kind: 'frame', index: 1 } });
    expect(s.comparison.ownsScrub({ ...ticket })).toBe(false);
    if (action === 'selection') await s.comparison.play({ mode: 'independent', pane: 'left', resultId: 'old', playing: false, sample: { kind: 'frame', index: 2 } });
    else if (action === 'modelWrite') s.comparison.pausePlayback();
    else if (action === 'suspend') { s.store.set({ viewMode: 'mesh' }); s.comparison.suspend(); }
    else s.comparison.dispose();
    const before = s.comparison.state(), reads = vi.mocked(s.transport.query).mock.calls.length;
    await s.comparison.cancelScrub(ticket);
    expect(s.comparison.state()).toEqual(before); expect(vi.mocked(s.transport.query).mock.calls).toHaveLength(reads);
    if (action === 'project') {
      const replacement = scrubSetup(); await replacement.comparison.configure(replacement.configuration);
      const newer = replacement.comparison.beginScrub('left'); expect(newer.id).toBe(ticket.id);
      expect(replacement.comparison.ownsScrub(ticket)).toBe(false); await replacement.comparison.cancelScrub(ticket);
      expect(replacement.comparison.ownsScrub(newer)).toBe(true); await replacement.comparison.cancelScrub(newer);
    }
  }
});

it('does not let a deferred cancellation receipt restore an older sample over a newer explicit selection', async () => {
  const s = scrubSetup(); await s.comparison.configure(s.configuration);
  const ticket = s.comparison.beginScrub('left');
  await s.comparison.previewScrub(ticket, { mode: 'independent', pane: 'left', resultId: 'old', playing: false, sample: { kind: 'frame', index: 1 } });
  let release!: (value: RetainedResults) => void, hold = true, receipt: RetainedResults | null = null;
  s.reply(async (query, original) => {
    if (hold && query.query === 'query.results') { hold = false; receipt = await original(query) as RetainedResults; return new Promise(resolve => { release = resolve; }); }
    return s.answer(query, original);
  });
  const cancelled = s.comparison.cancelScrub(ticket); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await s.comparison.play({ mode: 'independent', pane: 'left', resultId: 'old', playing: false, sample: { kind: 'frame', index: 2 } });
  release(receipt!); await cancelled;
  expect(s.comparison.state().left?.sample?.frame.index).toBe(2); expect(s.comparison.state().playback?.left?.sample.frame.index).toBe(2);
});
