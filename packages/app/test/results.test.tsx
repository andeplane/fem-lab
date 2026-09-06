// The results state machine and everything it computes on the way to the screen: the design's
// states 4–7 as one word, the Solve button's label, the legend's ticks, the balance line, and
// the field→unit table both the Worker and the viewer read.
import type { PathResult, ResultSummary, Valued } from '@femlab/registry';
import { render } from 'preact';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { FIELD_CHOICES, choiceOf, displayUnitOf, fieldChoices, formatNumber, legendTicks, siUnitOf } from '../src/fields';
import { ResultsView, fieldKeyOf, magnitude } from '../src/results';
import { Store, initialState, solveLabel, stageOf } from '../src/store';
import { probeLine } from '../src/ui/App';
import { PathPlot, Results, balanceLine, modelSpan, peakOf, siPoint } from '../src/ui/Results';
import { specOf, unavailable } from '../src/ui/Export';
import type { WorkerTransport } from '../src/worker-transport';

const mm = (value: number): Valued => ({ value, unit: 'mm' });
const kN = (value: number): Valued => ({ value, unit: 'kN' });

const RESULT: ResultSummary = {
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

  it('maps a `view.showField` back to the picker key it names, falling back to the field', () => {
    expect(fieldKeyOf('displacement', 2)).toBe('uz');
    expect(fieldKeyOf('displacement', null)).toBe('umag');
    expect(fieldKeyOf('stress', 99)).toBe('sxx');
    expect(fieldKeyOf('nonsense', 0)).toBe('vonMises');
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
  const has = { hasMesh: true, hasResult: true };
  it('says why a row cannot run yet', () => {
    expect(unavailable({ needs: 'none' } as never, has)).toBeNull();
    expect(unavailable({ needs: 'soon' } as never, has)).toBe('not written yet');
    expect(unavailable({ needs: 'mesh' } as never, { ...has, hasMesh: false })).toContain('Mesh');
    expect(unavailable({ needs: 'mesh' } as never, has)).toBeNull();
    expect(unavailable({ needs: 'result' } as never, { ...has, hasResult: false })).toContain('solved Step');
    expect(unavailable({ needs: 'result' } as never, has)).toBeNull();
  });

  it('builds the spec each row exports', () => {
    expect(specOf({ format: 'csv' } as never, 'static')).toEqual({ format: 'csv', table: 'extremes', step: 'static' });
    expect(specOf({ format: 'csv' } as never, undefined)).toEqual({ format: 'csv', table: 'extremes' });
    expect(specOf({ format: 'vtu' } as never, 'static')).toEqual({ format: 'vtu', step: 'static' });
    expect(specOf({ format: 'vtu' } as never, undefined)).toEqual({ format: 'vtu' });
    expect(specOf({ format: 'stl' } as never, 'static')).toEqual({ format: 'stl' });
    expect(specOf({ format: 'png' } as never, 'static', { width: 1280, height: 720 })).toEqual({ format: 'png', width: 1280, height: 720 });
  });
});

/** A viewer stub: the four calls `ResultsView` makes, recorded. */
function fakeViewer() {
  return { setField: vi.fn(), setDeformed: vi.fn(), setDim: vi.fn(), setMode: vi.fn(), setColormap: vi.fn(), autoScale: vi.fn(() => 120), animate: vi.fn() };
}

function harness(result: ResultSummary | null = RESULT) {
  const store = new Store({ ...initialState, model: { units: { length: 'mm' } } as never });
  const viewer = { current: fakeViewer() };
  const transport = {
    query: vi.fn(async (q: { query: string; quantity?: { value: number } }) => {
      if (q.query === 'query.convert') return { value: q.quantity!.value * 1000, unit: 'mm' };
      if (result) return result;
      throw { code: 'not-found', cause: 'no Step has been solved yet' };
    }),
    field: vi.fn(async (_s: string, field: string) => ({ values: field === 'displacement' ? Float32Array.from([0, 0, 0, 0, 0, -0.0001919]) : Float32Array.from([0, 12.4e6]), min: 0, max: 1, unit: '' })),
  };
  return { store, viewer, results: new ResultsView(store, transport as unknown as WorkerTransport, viewer as never), transport };
}

describe('ResultsView', () => {
  it('animates the explicitly requested Step and mode with speed and phase, updating the same UI state', async () => {
    const { store, viewer, results, transport } = harness({ ...RESULT, step: 'modes', frequencies: [{ value: 10, unit: 'Hz' }, { value: 20, unit: 'Hz' }] });
    await results.animate({ step: 'modes', mode: 2, playing: false, speed: 0.5, frame: 75 });
    expect(transport.query).toHaveBeenCalledWith({ query: 'query.result', step: 'modes' });
    expect(transport.field).toHaveBeenCalledWith('modes', 'mode:2', undefined);
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

  it('reports missing displacement without pretending a thermal field can be animated', async () => {
    const { results, viewer } = harness({ ...RESULT, extremes: [] });
    await expect(results.animate({ step: 'heat', playing: true })).rejects.toThrow('has no displacement');
    expect(viewer.current.animate).not.toHaveBeenCalled();
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
    store.set({ model: { units: { temperature: 'degC', length: 'm' } } as never });
    const { Engine } = createRequire(import.meta.url)('../../../tools/wasm-node/femlab_engine_wasm.js') as { Engine: new (threads: number) => { query(json: string): string } };
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
    store.set({ model: { units: { temperature: 'K', length: 'm' } } as never });
    await results.refresh(true);
    expect(viewer.current.setField.mock.calls.at(-1)![0]).toEqual(Float32Array.from([273.15, 293.15, 373.15]));
    expect(store.state.legend?.unit).toBe('K');
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
    await results.showField({ field: 'displacement', component: 2 });
    expect(store.state.fieldKey).toBe('uz');
    expect((viewer.current.setField.mock.calls.at(-1)![0] as Float32Array)[5]).toBeCloseTo(-0.1919, 5);
    expect(store.state.viewMode).toBe('results');
    await results.showField({ field: null });
    expect(store.state.viewMode).toBe('geometry');
    expect(viewer.current.setField).toHaveBeenLastCalledWith(null, [0, 1]);
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
});
