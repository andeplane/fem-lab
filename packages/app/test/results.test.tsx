import { batchModule } from '../../../tools/checked-batch.mjs';
// The results state machine and everything it computes on the way to the screen: the design's
// states 4–7 as one word, the Solve button's label, the legend's ticks, the balance line, and
// the field→unit table both the Worker and the viewer read.
import { HOST_COMMANDS, Registry, type CostEstimate, type EngineSchema, type ModelSummary, type PathResult, type ResultSummary, type Valued } from '@femlab/registry';
import { render } from 'preact';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../registry/src/generated/engine.schema.json';
import { readHostCaps } from '../src/capabilities';
import { FIELD_CHOICES, choiceOf, displayUnitOf, fieldChoices, formatNumber, legendTicks, siUnitOf } from '../src/fields';
import { makeHostContext } from '../src/host';
import { ResultsView, fieldKeyOf, magnitude } from '../src/results';
import { fitsSurface, nice, niceTick } from '../src/viewer/scale';
import { Store, initialState, solveLabel, stageOf, verificationState, type AssistantVerification } from '../src/store';
import { exaggerationHelp, probeLine } from '../src/ui/App';
import { Checks, PathPlot, Results, balanceLine, modelSpan, peakOf, siPoint } from '../src/ui/Results';

import { specOf, unavailable } from '../src/ui/Export';
import type { EngineTransport as WorkerTransport } from '@femlab/registry';

const mm = (value: number): Valued => ({ value, unit: 'mm' });
const kN = (value: number): Valued => ({ value, unit: 'kN' });

const MODEL: ModelSummary = {
  name: 'results-test',
  revision: 0,
  hash: 'results-test',
  units: { length: 'mm' },
  idealisation: 'solid',
  bodies: [{ name: 'body', bbox: [
    { value: 0, unit: 'm' }, { value: 0, unit: 'm' }, { value: 0, unit: 'm' },
    { value: 1, unit: 'm' }, { value: 1, unit: 'm' }, { value: 1, unit: 'm' },
  ], measure: { value: 1, unit: 'm^3' }, faces: [] }],
  materials: [],
  sets: [],
  constraints: [],
  connections: [],
  loads: [],
  steps: [],
  meshSettings: null,
  warnings: [],
};

const RESULT: ResultSummary = {
  resultId: 'result-1',
  reactionQuantity: 'force',
  step: 'static',
  revision: 10,
  stale: false,
  solver: 'cpu-direct',
  iterations: 1,
  residual: 0,
  timeMs: 12,
  extremes: [
    { field: 'displacement', component: 2, min: mm(-0.1919), minAt: [mm(1000), mm(50), mm(50)], max: mm(0), maxAt: [mm(0), mm(0), mm(0)] },
    { field: 'vonMises', component: 0, min: { value: 0, unit: 'MPa' }, minAt: [mm(0), mm(0), mm(0)], max: { value: 12.4, unit: 'MPa' }, maxAt: [mm(0), mm(50), mm(100)] },
  ],
  reactions: [{ constraint: 'root', total: [kN(0), kN(0), kN(1)] }],
  appliedTotal: [kN(0), kN(0), kN(-1)],
  balance: 0,
};


describe('the solve state machine', () => {
  const base = { solving: null, result: null, lastError: null } as Parameters<typeof stageOf>[0];

  it('walks idle → solving → solved → stale, with error taking over', () => {
    expect(stageOf(base)).toBe('idle');
    expect(stageOf({ ...base, solving: 'static' })).toBe('solving');
    // A solve in flight outranks the last error: the card on screen is the solving one.
    expect(stageOf({ ...base, solving: 'static', lastError: { code: 'x', cause: 'y', where: null, suggestion: null } })).toBe('solving');
    expect(stageOf({ ...base, result: RESULT })).toBe('solved');
    expect(stageOf({ ...base, result: { ...RESULT, stale: true } })).toBe('stale');
    expect(stageOf({ ...base, lastError: { code: 'mesh.inverted', cause: 'c', where: null, suggestion: null } })).toBe('error');
  });

  it('labels the Solve button for every state', () => {
    expect(solveLabel('idle', { progress: null, result: null })).toBe('Solve');
    expect(solveLabel('solving', { progress: { phase: 'solve', fraction: 0.47 }, result: null })).toBe('Solving 47 %');
    expect(solveLabel('solving', { progress: null, result: null })).toBe('Solving 0 %');
    expect(solveLabel('solved', { progress: null, result: RESULT })).toBe('Solved · rev 10');
    expect(solveLabel('solved', { progress: null, result: null })).toBe('Solved · rev 0');
    expect(solveLabel('stale', { progress: null, result: RESULT })).toBe('Re-solve');
    expect(solveLabel('error', { progress: null, result: null })).toBe('Solve');
  });
});

describe('fields and the legend', () => {
  it('knows the SI unit a raw field arrives in and the unit the Model shows it in', () => {
    expect(siUnitOf('displacement')).toBe('m');
    expect(siUnitOf('vonMises')).toBe('Pa');
    expect(siUnitOf('strain')).toBe('');
    expect(displayUnitOf('displacement', { length: 'mm' })).toBe('mm');
    expect(displayUnitOf('vonMises', { length: 'mm' })).toBe('Pa');
    expect(displayUnitOf('reaction', undefined)).toBe('N');
  });

  it('formats numbers the way the mono tables do', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(-0.1919619)).toBe('-0.192');
    expect(formatNumber(12.4)).toBe('12.4');
    expect(formatNumber(1234567)).toBe('1.235e+6');
    expect(formatNumber(1e-6)).toBe('1.000e-6');
    expect(formatNumber(NaN)).toBe('—');
  });

  it('reads six ticks down the gradient bar, max first', () => {
    expect(legendTicks(0, 10)).toEqual(['10', '8', '6', '4', '2', '0']);
    expect(legendTicks(5, 5)).toEqual(['5', '5', '5', '5', '5', '5']);
    expect(legendTicks(0, 1, 2)).toEqual(['1', '0']);
  });

  it('offers only the fields the Step actually computed', () => {
    expect(fieldChoices(['vonMises', 'displacement']).map((c) => c.key)).toEqual(['vonMises', 'umag', 'ux', 'uy', 'uz']);
    expect(fieldChoices([])).toEqual([]);
    expect(FIELD_CHOICES.find((c) => c.key === 'temperature')?.field).toBe('temperature');
  });

  it('maps supported `view.showField` fields and rejects unsupported requests', () => {
    expect(fieldKeyOf('displacement', 2)).toBe('uz');
    expect(fieldKeyOf('displacement', null)).toBe('umag');
    expect(fieldKeyOf('stress', 0)).toBe('sxx');
    expect(() => fieldKeyOf('stress', 99)).toThrowError(expect.objectContaining({ code: 'unsupported', where: 'view.showField', suggestion: expect.stringContaining('query.result') }));
    expect(() => fieldKeyOf('reaction', 0)).toThrowError(expect.objectContaining({ code: 'unsupported', where: 'view.showField' }));
    expect(() => fieldKeyOf('nonsense', 0)).toThrowError(expect.objectContaining({ code: 'unsupported', where: 'view.showField' }));
    expect(choiceOf('nope').key).toBe('vonMises');
  });

  it('collapses a vector to its magnitude, and leaves a scalar alone', () => {
    expect([...magnitude(Float32Array.from([3, 4, 0, 0, 0, 2]), true)]).toEqual([5, 2]);
    const scalar = Float32Array.from([1, 2]);
    expect(magnitude(scalar, false)).toBe(scalar);
  });
});

describe('the Results tab', () => {
  it('writes the balance as a percentage and passes at zero', () => {
    expect(balanceLine(RESULT)).toEqual({ pass: true, text: 'Σ reactions = −Σ loads · 0.0000 %' });
    expect(balanceLine({ ...RESULT, balance: 0.0123 })).toEqual({ pass: false, text: 'Σ reactions = −Σ loads · 1.2300 %' });
  });

  it('keeps thermal reactions as power through the legend and reaction table', () => {
    expect(siUnitOf('reaction', 'power')).toBe('W');
    expect(displayUnitOf('reaction', { force: 'kN' }, 'power')).toBe('W');
    expect(displayUnitOf('reaction', { force: 'N', power: 'kW' }, 'power')).toBe('kW');
    expect(displayUnitOf('reaction', { force: 'kN', power: 'W' }, 'force')).toBe('kN');
    const kw = (value: number): Valued => ({ value, unit: 'kW' });
    const result: ResultSummary = { ...RESULT, reactionQuantity: 'power', storagePower: kw(0.005),
      reactions: [{ constraint: 'cold', total: [kw(0.01), kw(0), kw(0)] }],
      appliedTotal: [kw(0.01), kw(0), kw(0)], extremes: [] };
    const root = document.createElement('div');
    render(<Results s={{ ...initialState, result }} dispatch={vi.fn()} query={vi.fn()} />, root);
    expect(root.textContent).toContain('Power kW');
    expect(root.textContent).not.toContain('Fx');
    const table = [...root.querySelectorAll('table')].find((t) => t.textContent?.includes('Power kW'))!;
    expect([...table.querySelectorAll('tbody tr')].map((r) => r.children.length)).toEqual([2, 2, 2, 2]);
    expect(table.textContent).toContain('cold0.01');
    expect(table.textContent).toContain('Storage rate0.005');
    expect(root.textContent).toContain('Net applied = removed + storage');
    expect(balanceLine({ ...result, balance: 1e-9 }).pass).toBe(true);
    expect(balanceLine({ ...result, balance: 2e-9 }).pass).toBe(false);
  });

  it('leads with the extreme of the largest magnitude', () => {
    expect(peakOf(RESULT.extremes)?.field).toBe('vonMises');
    expect(peakOf([])).toBeUndefined();
  });

  it('turns a display-unit location into the metres the camera speaks', () => {
    expect(siPoint([mm(1000), mm(50), mm(50)], 1000)).toEqual([1, 0.05, 0.05]);
  });

  it('measures the Model span from the body boxes, and 1 when there are none', () => {
    const bbox = [mm(0), mm(0), mm(0), mm(300), mm(400), mm(0)] as never;
    expect(modelSpan({ ...initialState, model: { bodies: [{ bbox }] } } as never)).toBe(500);
    expect(modelSpan(initialState)).toBe(1);
  });

  it('puts field units on values and length units on extreme locations', () => {
    const m = (value: number): Valued => ({ value, unit: 'm' });
    const result = {
      ...RESULT,
      extremes: [
        { field: 'stress', component: 0, min: { value: 0, unit: 'Pa' }, minAt: [m(0), m(0), m(0)], max: { value: 1e6, unit: 'Pa' }, maxAt: [m(1), m(0.05), m(0.05)] },
        { field: 'reaction', component: 0, min: { value: 0, unit: 'N' }, minAt: [m(0), m(0), m(0)], max: { value: 1e4, unit: 'N' }, maxAt: [m(0), m(0.05), m(0.05)] },
        { field: 'strain', component: 0, min: { value: 0, unit: 'SI' }, minAt: [m(0), m(0), m(0)], max: { value: 5e-6, unit: 'SI' }, maxAt: [m(0.5), m(0.05), m(0.05)] },
        { field: 'displacement', component: 2, min: mm(-0.2), minAt: [mm(1000), mm(50), mm(50)], max: mm(0), maxAt: [mm(0), mm(50), mm(50)] },
      ],
    } as ResultSummary;
    const root = document.createElement('div');
    render(<Results s={{ ...initialState, result }} dispatch={async () => undefined} query={async () => undefined} />, root);
    const rows = [...root.querySelectorAll('.rtable tbody tr')].slice(0, 4);

    expect(rows.map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent.trim()))).toEqual([
      ['σxxstress', '0 Pa', '1.000e+6 Pa', '1 0.05 0.05 m', 'go to'],
      ['reaction 0reaction', '0 N', '10000 N', '0 0.05 0.05 m', 'go to'],
      ['strain 0strain', '0 (1)', '5.000e-6 (1)', '0.5 0.05 0.05 m', 'go to'],
      ['uzdisplacement', '-0.2 mm', '0 mm', '0 50 50 mm', 'go to'],
    ]);
  });

  it('plots a path, and says so when every sample missed the mesh', () => {
    const root = document.createElement('div');
    const path: PathResult = { s: [0, 1, 2], values: [0, 1, 2], unit: 'MPa' };
    render(<PathPlot path={path} />, root);
    // Left axis at x = 46, right margin 8, top 10, bottom 20 of a 260 x 108 viewBox.
    expect(root.querySelector('polyline')?.getAttribute('points')).toBe('46,88 149,49 252,10');
    expect(root.textContent).toContain('hover to read a point');
    render(<PathPlot path={{ s: [0, 1], values: [null, null], unit: 'MPa' }} />, root);
    expect(root.textContent).toContain('Not enough points to plot');
  });
});

describe('the probe readout', () => {
  it('names the value, the node and the point in Results, and the face otherwise', () => {
    expect(probeLine(null)).toBe('');
    expect(probeLine({ face: 'beam.top', body: 'beam', point: [0, 0.412, 1.388], node: null, value: null })).toBe('beam.top · x 0.000 y 0.412 z 1.388 m');
    expect(probeLine({ face: null, body: null, point: [0, 0, 0], node: 1342, value: 12.4 })).toBe('12.4 · node 1342 · x 0.000 y 0.000 z 0.000 m');
  });
});

describe('the Export dialog', () => {
  const has = { hasMesh: true, hasResult: true, hasAnimation: true };
  it('says why a row cannot run yet', () => {
    expect(unavailable({ needs: 'none' } as never, has)).toBeNull();
    expect(unavailable({ needs: 'soon' } as never, has)).toBe('not written yet');
    expect(unavailable({ needs: 'mesh' } as never, { ...has, hasMesh: false })).toContain('Mesh');
    expect(unavailable({ needs: 'mesh' } as never, has)).toBeNull();
    expect(unavailable({ needs: 'result' } as never, { ...has, hasResult: false })).toContain('solved Step');
    expect(unavailable({ needs: 'result' } as never, has)).toBeNull();
    expect(unavailable({ needs: 'animation' } as never, { ...has, hasAnimation: false })).toContain('mode shape');
    expect(unavailable({ needs: 'animation' } as never, has)).toBeNull();
  });

  it('builds the spec each row exports', () => {
    expect(specOf({ format: 'csv' } as never, 'static')).toEqual({ format: 'csv', table: 'extremes', step: 'static' });
    expect(specOf({ format: 'csv' } as never, undefined)).toEqual({ format: 'csv', table: 'extremes' });
    expect(specOf({ format: 'vtu' } as never, 'static')).toEqual({ format: 'vtu', step: 'static' });
    expect(specOf({ format: 'vtu' } as never, undefined)).toEqual({ format: 'vtu' });
    expect(specOf({ format: 'webm' } as never, 'modes')).toEqual({ format: 'webm', width: 1280, height: 720 });
    expect(specOf({ format: 'stl' } as never, 'static')).toEqual({ format: 'stl' });
    expect(specOf({ format: 'png' } as never, 'static', { width: 1280, height: 720 })).toEqual({ format: 'png', width: 1280, height: 720 });
  });
});

/** A viewer stub: the four calls `ResultsView` makes, recorded. */
function fakeViewer() {
  return { hasSurface: true, setSurface: vi.fn(), setField: vi.fn(), setDeformed: vi.fn(), setDim: vi.fn(), setMode: vi.fn(), setColormap: vi.fn(), animate: vi.fn(), autoScale: vi.fn(() => 120) };
}

function harness(result: ResultSummary | null = RESULT) {
  const store = new Store({ ...initialState, model: MODEL });
  const viewer = { current: fakeViewer() };
  const transport = {
    surface: vi.fn(async () => ({})),
    query: vi.fn(async (q: { query: string; quantity?: { value: number } }) => {
      if (q.query === 'query.convert') return { value: q.quantity!.value * 1000, unit: 'mm' };
      if (result) return result;
      throw { code: 'not-found', cause: 'no Step has been solved yet' };
    }),
    field: vi.fn(async (_s: string, field: string) => ({ values: field === 'displacement' ? Float32Array.from([0, 0, 0, 0, 0, -0.0001919]) : Float32Array.from([0, 12.4e6]), min: 0, max: 1, unit: '' })),
  };
  return { store, viewer, results: new ResultsView(store, transport as unknown as WorkerTransport, viewer as never), transport };
}

function registryHarness(result: ResultSummary) {
  const { store, viewer, results, transport } = harness(result);
  store.set({ result });
  const host = readHostCaps({ navigator: { userAgent: 'Chrome/140.0.0.0', hardwareConcurrency: 8, gpu: {} }, crossOriginIsolated: true });
  const registry = new Registry({
    schema: schema as unknown as EngineSchema,
    host: makeHostContext(store, transport as unknown as WorkerTransport, viewer as never, host, undefined, results),
    hostCommands: HOST_COMMANDS,
  });
  return { registry, store, transport };
}

describe('ResultsView', () => {
  it('animates the explicitly requested Step and mode with speed and phase, updating the same UI state', async () => {
    const { store, viewer, results, transport } = harness({ ...RESULT, step: 'modes', frequencies: [{ value: 10, unit: 'Hz' }, { value: 20, unit: 'Hz' }] });
    await results.animate({ step: 'modes', mode: 2, playing: false, speed: 0.5, frame: 75 });
    expect(transport.query).toHaveBeenCalledWith({ query: 'query.result', step: 'modes' });
    expect(transport.field).toHaveBeenCalledWith('modes', 'mode:2', undefined, RESULT.resultId);
    expect(viewer.current.animate).toHaveBeenLastCalledWith(false, 0.5, 0.75);
    expect(store.state).toMatchObject({ playing: false, phase: 0.75, animationSpeed: 0.5, fieldKey: 'mode:2', viewMode: 'results' });
    await results.animate({ step: 'modes', mode: 2, playing: true, speed: 2 });
    expect(viewer.current.animate).toHaveBeenLastCalledWith(true, 2, undefined);
    expect(store.state.playing).toBe(true);
    await results.refresh();
    expect(transport.query).toHaveBeenCalledWith({ query: 'query.result', step: 'modes' });
    await expect(results.animate({ step: 'modes', mode: 3, playing: true })).rejects.toThrow('has no mode 3');
    expect(store.state.fieldKey).toBe('mode:2');
  });

  it('keeps a newer pause when an older play finishes loading afterward', async () => {
    const modal = { ...RESULT, step: 'modes', frequencies: [{ value: 10, unit: 'Hz' }] };
    const { store, viewer, results, transport } = harness(modal);
    let finishLoad!: () => void;
    const loadPending = new Promise<void>((resolve) => { finishLoad = resolve; });
    transport.field.mockImplementationOnce(async () => {
      await loadPending;
      return { values: Float32Array.from([0, 0, 0, 0, 0, -0.0001919]), min: 0, max: 1, unit: '' };
    });

    const play = results.animate({ step: 'modes', mode: 1, playing: true });
    await vi.waitFor(() => expect(transport.field).toHaveBeenCalledWith('modes', 'mode:1', undefined, RESULT.resultId));
    await results.animate({ step: 'modes', mode: 1, playing: false });
    finishLoad();
    await play;

    expect(viewer.current.animate).toHaveBeenCalledTimes(1);
    expect(viewer.current.animate).toHaveBeenLastCalledWith(false, 1, undefined);
    expect(store.state.playing).toBe(false);
  });

  it('reports missing displacement without pretending a thermal field can be animated', async () => {
    const { results, viewer } = harness({ ...RESULT, extremes: [] });
    await expect(results.animate({ step: 'heat', playing: true })).rejects.toThrow('has no displacement');
    expect(viewer.current.animate).not.toHaveBeenCalled();
  });
  it('uses current material yields in display units, independent of historical Journal entries', async () => {
    const { store, results, transport } = harness();
    transport.query.mockImplementation(async (q) => {
      if (q.query !== 'query.convert') return RESULT;
      const { quantity, to } = q as unknown as { quantity: { value: number; unit: string }; to: string };
      return { value: to === 'Pa' ? quantity.value * (quantity.unit === 'MPa' ? 1e6 : 1) : 1000, unit: to } as never;
    });
    store.set({
      journal: { revision: 2, entries: [{ cmd: { cmd: 'material.add', yield: '1 Pa' } }] } as never,
      model: { units: { length: 'mm' }, materials: [
        { name: 'renamed-steel', yield: { value: 355, unit: 'MPa' } },
        { name: 'other', yield: { value: 400e6, unit: 'Pa' } },
        { name: 'no-yield' },
      ] } as never,
    });
    await results.refresh(true);
    expect(store.state.yieldStress).toBe(355e6);
    // Editing/removing material state takes effect even while old commands remain in history.
    store.set({ model: { ...store.state.model, materials: [{ name: 'other', yield: { value: 400e6, unit: 'Pa' } }] } as never });
    await results.refresh(true);
    expect(store.state.yieldStress).toBe(400e6);
    store.set({ model: { ...store.state.model, materials: [{ name: 'no-yield' }] } as never });
    await results.refresh(true);
    expect(store.state.yieldStress).toBeNull();
  });

  it('loads the contoured scalar in display units and the displacement in SI', async () => {
    const { store, viewer, results } = harness();
    await results.refresh();
    expect(store.state.result).toEqual(RESULT);
    // The Model names no stress unit, so the von Mises array stays in Pa and no conversion runs.
    expect(store.state.legend).toEqual({ min: 0, max: 12.4e6, unit: 'Pa' });
    expect(store.state.lengthFactor).toBe(1000);
    expect(viewer.current.setDim).toHaveBeenCalledWith(false);
    // The displacement reaches the viewer untouched: the mesh it deforms is in metres.
    expect(viewer.current.setDeformed.mock.calls.at(-1)![0]).toEqual(Float32Array.from([0, 0, 0, 0, 0, -0.0001919]));
  });

  it('converts Kelvin contours and legends using scale plus offset, cached by unit pair', async () => {
    const heat = { ...RESULT, extremes: [{ ...RESULT.extremes[0]!, field: 'temperature' }] };
    const { store, viewer, results, transport } = harness(heat);
    store.set({ model: { ...MODEL, units: { temperature: 'degC', length: 'm' } } });
    const { Engine } = batchModule(createRequire(import.meta.url)('../../../tools/wasm-node/femlab_engine_wasm.js')) as { Engine: new (threads: number) => { query(json: string): string } };
    const engine = new Engine(1);
    const conversions = vi.fn(async (q: { query: string; quantity?: { value: number }; to?: string }) => {
      if (q.query !== 'query.convert') return heat;
      expect(q.to).toBe('degC');
      return JSON.parse(engine.query(JSON.stringify(q))) as { value: number; unit: string };
    });
    transport.query.mockImplementation(conversions);
    transport.field.mockImplementation(async () => ({ values: Float32Array.from([273.15, 293.15, 373.15]), min: 273.15, max: 373.15, unit: 'K' }));
    await results.refresh();
    const [values, range] = viewer.current.setField.mock.calls.at(-1)! as [Float32Array, [number, number]];
    for (const [index, expected] of [0, 20, 100].entries()) expect(values[index]).toBeCloseTo(expected, 4);
    expect(range[0]).toBeCloseTo(0, 4);
    expect(range[1]).toBeCloseTo(100, 4);
    expect(store.state.legend?.unit).toBe('degC');
    expect(conversions.mock.calls.filter(([q]) => q.query === 'query.convert')).toHaveLength(2);
    await results.refresh(true);
    expect(conversions.mock.calls.filter(([q]) => q.query === 'query.convert')).toHaveLength(2);
    store.set({ model: { ...MODEL, units: { temperature: 'K', length: 'm' } } });
    await results.refresh(true);
    expect(viewer.current.setField.mock.calls.at(-1)![0]).toEqual(Float32Array.from([273.15, 293.15, 373.15]));
    expect(store.state.legend?.unit).toBe('K');
  });

  it('uses the thermal result quantity when converting a reaction contour', async () => {
    const thermal = { ...RESULT, reactionQuantity: 'power' as const };
    const { store, results, transport } = harness(thermal);
    store.set({ result: thermal, model: { ...MODEL, units: { power: 'kW', length: 'm' } } });
    transport.query.mockImplementation(async (q: { query: string; quantity?: { value: number; unit?: string }; to?: string }) => {
      if (q.query !== 'query.convert') return thermal;
      expect(q.quantity?.unit).toBe('W');
      expect(q.to).toBe('kW');
      return { value: q.quantity!.value / 1000, unit: 'kW' };
    });
    type Contour = { values: Float32Array; range: [number, number]; unit: string };
    const contour = (results as unknown as {
      contour: (choice: { field: string; component: number | null }, raw: Float32Array) => Promise<Contour>;
    }).contour;
    const output = await contour.call(results, { field: 'reaction', component: 0 }, Float32Array.from([1000, 2000]));
    expect(output.values).toEqual(Float32Array.from([1, 2]));
    expect(output.range).toEqual([1, 2]);
    expect(output.unit).toBe('kW');
  });

  it('does the second refresh without refetching, and a forced one with', async () => {
    const { results, transport } = harness();
    await results.refresh();
    const after = transport.field.mock.calls.length;
    await results.refresh();
    expect(transport.field.mock.calls.length).toBe(after);
    await results.refresh(true);
    expect(transport.field.mock.calls.length).toBeGreaterThan(after);
  });

  it('clears the viewer when no Step has been solved', async () => {
    const { store, viewer, results } = harness(null);
    await results.refresh();
    expect(store.state.result).toBeNull();
    expect(store.state.legend).toBeNull();
    expect(viewer.current.setField).toHaveBeenCalledWith(null, [0, 1]);
  });

  it('dims a stale Result rather than throwing its contours away', async () => {
    const { viewer, results } = harness({ ...RESULT, stale: true });
    await results.refresh();
    expect(viewer.current.setDim).toHaveBeenCalledWith(true);
  });

  it('showField picks a scalar, and `{ field: null }` turns contours off', async () => {
    const { store, viewer, results } = harness();
    store.set({ result: RESULT });
    await results.showField({ field: 'displacement', component: 2 });
    expect(store.state.fieldKey).toBe('uz');
    expect((viewer.current.setField.mock.calls.at(-1)![0] as Float32Array)[5]).toBeCloseTo(-0.1919, 5);
    expect(store.state.viewMode).toBe('results');
    await results.showField({ field: null });
    expect(store.state.viewMode).toBe('geometry');
    expect(viewer.current.setField).toHaveBeenLastCalledWith(null, [0, 1]);
  });

  it('routes structural and thermal field requests through the registry without fallback', async () => {
    const structural = registryHarness(RESULT);
    await structural.registry.dispatch({ cmd: 'view.showField', field: 'displacement', component: 2 });
    expect(structural.store.state.fieldKey).toBe('uz');
    const structuralQueries = structural.transport.query.mock.calls.length;
    await expect(structural.registry.dispatch({ cmd: 'view.showField', field: 'reaction', component: 0 })).rejects.toMatchObject({ code: 'unsupported', where: 'view.showField' });
    await expect(structural.registry.dispatch({ cmd: 'view.showField', field: 'stress', component: 99 })).rejects.toMatchObject({ code: 'unsupported', where: 'view.showField' });
    await expect(structural.registry.dispatch({ cmd: 'view.showField', field: 'temperature', component: 0 })).rejects.toMatchObject({ code: 'unsupported', where: 'view.showField' });
    await expect(structural.registry.dispatch({ cmd: 'view.showField', field: 'mode:999' })).rejects.toMatchObject({ code: 'unsupported', where: 'view.showField' });
    await expect(structural.registry.dispatch({ cmd: 'view.showField', field: '' })).rejects.toMatchObject({ code: 'unsupported', where: 'view.showField' });
    expect(structural.store.state.fieldKey).toBe('uz');
    expect(structural.transport.query.mock.calls.length).toBe(structuralQueries);

    const thermal: ResultSummary = {
      ...RESULT,
      extremes: [{
        field: 'temperature', component: 0, min: { value: 0, unit: 'K' },
        minAt: [mm(0), mm(0), mm(0)], max: { value: 100, unit: 'K' }, maxAt: [mm(0), mm(0), mm(0)],
      }],
    };
    const thermalRegistry = registryHarness(thermal);
    await thermalRegistry.registry.dispatch({ cmd: 'view.showField', field: 'temperature', component: 0 });
    expect(thermalRegistry.store.state.fieldKey).toBe('temperature');
    await expect(thermalRegistry.registry.dispatch({ cmd: 'view.showField', field: 'reaction', component: 0 })).rejects.toMatchObject({ code: 'unsupported', where: 'view.showField' });
    await expect(thermalRegistry.registry.dispatch({ cmd: 'view.showField', field: 'temperature', component: 1 })).rejects.toMatchObject({ code: 'unsupported', where: 'view.showField' });
    expect(thermalRegistry.store.state.fieldKey).toBe('temperature');
  });

  it('setLegend takes the colour map and the clamp', async () => {
    const { store, viewer, results } = harness();
    await results.setLegend({ colormap: 'turbo' });
    expect(store.state.colormap).toBe('turbo');
    expect(viewer.current.setColormap).toHaveBeenCalledWith('turbo');
    await results.setLegend({ range: [0, 1] });
    expect(store.state.clamp).toEqual([0, 1]);
    expect(store.state.legend).toMatchObject({ min: 0, max: 1 });
    await results.setLegend({ range: 'auto' });
    expect(store.state.clamp).toBeNull();
    await results.setLegend({});
    expect(store.state.clamp).toBeNull();
  });

  it('scales the deformed shape by a number, by 1 for true scale, or automatically', async () => {
    const { store, viewer, results } = harness();
    await results.refresh();
    results.setDeformScale(120);
    expect(store.state.deformScale).toBe(120);
    results.setDeformScale('true');
    expect(store.state.deformScale).toBe(1);
    results.setDeformScale('auto');
    expect(store.state.deformScale).toBe(120);
    expect(viewer.current.setDeformed).toHaveBeenLastCalledWith(expect.any(Float32Array), 120);
  });

  it('hands the legend to a screenshot only in Results mode', async () => {
    const { store, results } = harness();
    await results.refresh();
    expect(results.legendBurn()).toBeNull();
    store.set({ viewMode: 'results' });
    expect(results.legendBurn()).toMatchObject({ title: 'σ_vM', unit: 'Pa' });
  });

  it('opens the Results tab on a solve and keeps a study report', async () => {
    const { store, results } = harness();
    await results.onAck({ output: { type: 'solve' }, warnings: [{ code: 'W-1', text: 'assumed a default', where: null }] });
    expect(store.state.tab).toBe('results');
    // A fresh Result opens exaggerated; ×1 would look undeformed.
    expect(store.state.deformScale).toBe(120);
    expect(store.state.viewMode).toBe('results');
    expect(store.state.assumptions).toHaveLength(1);
    await results.onAck({ output: { type: 'study', report: { rows: [], unit: 'mm' } } });
    expect(store.state.study).toEqual({ rows: [], unit: 'mm' });
    await results.onAck({ output: { type: 'none' } });
    await results.onAck(undefined);
    expect(store.state.study).toEqual({ rows: [], unit: 'mm' });
  });

  // Issue #42: the shape a person sees must not depend on which chain got there first.
  it('pushes the same exaggeration for every field, memoised path and forced path alike', async () => {
    const { viewer, results } = harness();
    await results.refresh(); // Hydrate the current Result before requesting one of its fields.
    await results.showField({ field: 'vonMises' });
    const first = viewer.current.setDeformed.mock.calls.at(-1)![1];
    await results.showField({ field: 'displacement', component: null });
    expect(viewer.current.setDeformed.mock.calls.at(-1)![1]).toBe(first);
    await results.showField({ field: 'vonMises' });
    expect(viewer.current.setDeformed.mock.calls.at(-1)![1]).toBe(first);
    expect(first).not.toBe(1);
  });

  it('preserves an explicitly requested exaggeration when a solve completes', async () => {
    const { store, viewer, results } = harness();
    results.setDeformScale(200);
    await results.onAck({ output: { type: 'solve' } });
    expect(store.state.deformScale).toBe(200);
    expect(viewer.current.setDeformed.mock.calls.at(-1)![1]).toBe(200);
  });

  it('recomputes an `auto` that had no Viewer to compute it with when one arrives', async () => {
    const { store, viewer, results } = harness();
    const arriving = viewer.current;
    // The three.js chunk has not landed: `load` cannot read a scale off a Viewer that is not there.
    viewer.current = null as never;
    await results.onAck({ output: { type: 'solve' } });
    expect(store.state.deformScale).toBe(1);
    // It lands, and the host's un-forced refresh is all that follows.
    viewer.current = arriving;
    await results.refresh();
    expect(store.state.deformScale).toBe(120);
    expect(viewer.current.setDeformed).toHaveBeenLastCalledWith(expect.any(Float32Array), 120);
  });

  it('waits for the surface before scaling: a placeholder bounding box would exaggerate wildly', async () => {
    const { store, viewer, results } = harness();
    // The Viewer is mounted but the host has not pushed a surface yet, so its box is the
    // constructor's unit cube and `autoScale` would measure the model against that.
    (viewer.current as { hasSurface: boolean }).hasSurface = false;
    await results.onAck({ output: { type: 'solve' } });
    expect(store.state.deformScale).toBe(1);
    expect(viewer.current.setDeformed).not.toHaveBeenCalled();
    (viewer.current as { hasSurface: boolean }).hasSurface = true;
    await results.refresh();
    expect(store.state.deformScale).toBe(120);
  });

  it('keeps a typed exaggeration across a field switch and a re-solve', async () => {
    const { store, viewer, results } = harness();
    await results.refresh();
    results.setDeformScale(200);
    await results.showField({ field: 'displacement', component: 2 });
    expect(store.state.deformScale).toBe(200);
    await results.onAck({ output: { type: 'solve' } });
    expect(store.state.deformScale).toBe(200);
    expect(viewer.current.setDeformed).toHaveBeenLastCalledWith(expect.any(Float32Array), 200);
  });
});

describe('the exaggeration, said in words', () => {
  it('explains the number wherever it appears, and says what ×1 means', () => {
    const help = exaggerationHelp(1000);
    expect(help).toContain('1000× larger');
    expect(help).toContain('The Result itself is unchanged');
    expect(help).toContain('the faint outline is the undeformed body');
    expect(exaggerationHelp(1)).toContain('true scale');
  });
});

describe("the viewer's rounding and its stale-displacement guard", () => {
  it('rounds down to a round 1/2/5·10^k, and gives up on nothing', () => {
    expect([1311, 999, 640, 21, 7, 1, 0.037].map(nice)).toEqual([1000, 500, 500, 20, 5, 1, 0.02]);
    expect(nice(0)).toBe(1);
    expect(nice(-3)).toBe(1);
    expect(niceTick(200)).toBe(10);
    expect(niceTick(0)).toBe(1);
  });

  it('keeps a displacement that still spans the surface and drops one that no longer does', () => {
    const positions = new Float32Array(9);
    expect(fitsSurface(new Float32Array(9), positions)).toBe(true);
    expect(fitsSurface(new Float32Array(12), positions)).toBe(true);
    // A re-mesh or a new body: re-applying this would index past the end and write NaN.
    expect(fitsSurface(new Float32Array(6), positions)).toBe(false);
    expect(fitsSurface(null, positions)).toBe(false);
  });
});

it.each([null, false] as const)('shows honest cost bounds and %s feasibility in Checks', async (feasible) => {
  const { waitForText } = await import('./wait-for');
  const root = document.createElement('div');
  const cost: CostEstimate = {
    dofs: 36, nnzLower: 576, nnz: 1296, bytes: 1_728_000_000, assemblyBytes: 1_727_000_000, residentResultBytes: 0, resultMeshBytes: 0,
    retainedFrames: 3, retainedBytes: 900_000, transientWorkBytes: 50_000, transportStagingBytes: 864,
    wasmTransportStagingBytes: 1728, wasmTransportStagingComplete: false,
    budgetBytes: 1_610_612_736,
    feasible, note: 'Excludes direct-factor fill/workspace.',
  };
  const model = { bodies: [], warnings: [], meshSettings: {}, steps: [{ name: 'static' }] } as unknown as ModelSummary;
  const query = vi.fn(async (q: { query: string }) => q.query === 'query.cost' ? cost : null);
  render(<Checks s={{ ...initialState, model }} dispatch={async () => undefined} query={query} />, root);
  try {
    const text = await waitForText(() => root, feasible === false ? 'over budget' : 'not established');
    expect(query).toHaveBeenCalledWith({ query: 'query.cost', step: 'static' });
    expect(text).toContain('matrix non-zeros (upper bound)1296');
    expect(text).toContain('counted peak memory estimate1.7 GB');
    expect(text).toContain('retained frames3');
    expect(text).toContain('retained primary fields900 kB');
    expect(text).toContain('native frame staging1 kB');
    expect(text).toContain('browser frame staging≥ 2 kB + JSON/JS overhead');
    expect(text).toContain('planning budget1.6 GB');
    expect(text).toContain('Excludes direct-factor fill/workspace.');
    expect(text).not.toContain('feasible here');
  } finally {
    render(null, root);
  }
});

describe('Assistant observations remain distinct from engine checks', () => {
  it('marks history changes, result changes and missing history as stale or unconfirmed', () => {
    const record: AssistantVerification = { rows: [], model: null, revision: 10, journalHash: 'saved-history', result: { step: 'static', revision: 10 } };
    const state = { ...initialState, revision: 10, journal: { hash: 'saved-history', entries: [], revision: 10, canUndo: true, canRedo: false }, result: RESULT };
    expect(verificationState(record, state)).toContain('Result static rev 10');
    expect(verificationState({ ...record, result: null }, state)).toContain('Stale');
    expect(verificationState(record, { ...state, journal: { ...state.journal, hash: 'same-revision-other-history' } })).toContain('Stale');
    expect(verificationState(record, { ...state, result: { ...RESULT, stale: true } })).toContain('Stale');
    expect(verificationState(record, { ...state, result: { ...RESULT, step: 'other' } })).toContain('Stale');
    expect(verificationState(record, { ...state, result: { ...RESULT, revision: 11 } })).toContain('Stale');
    expect(verificationState(record, { ...state, result: null })).toContain('Stale');
    expect(verificationState({ ...record, journalHash: null }, state)).toContain('unconfirmed');
  });
});
