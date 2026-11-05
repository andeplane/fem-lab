import type { EngineTransport, Extreme, FieldData, FrameResult, FramesResult, ModelSummary, Query, QueryResult, ResultSummary } from '@femlab/registry';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store, type UiState } from '../src/store';
import { App } from '../src/ui/App';
import type { Dispatch } from '../src/ui/cmd';
import { ResultsView } from '../src/results';

const v = (value: number, unit: string) => ({ value, unit });
const point = [v(0, 'm'), v(0, 'm'), v(0, 'm')] as const;
const extreme = (field: string, unit: string): Extreme => ({ field, component: 0, min: v(0, unit), max: v(1, unit), minAt: [...point], maxAt: [...point] });
const thermal: ResultSummary = {
  modeCount: 0,
  resultId: 'thermal-1', step: 'retained', revision: 1, stale: false, solver: 'cpu-direct', iterations: 1, residual: 0, timeMs: 1,
  extremes: [extreme('temperature', 'K')], reactionQuantity: 'power', reactions: [], appliedTotal: [v(0, 'W'), v(0, 'W'), v(0, 'W')], balance: 0,
};
const mechanical: ResultSummary = { ...thermal, resultId: 'mechanical-1', reactionQuantity: 'force',
  extremes: [extreme('displacement', 'm'), extreme('vonMises', 'Pa'), extreme('temperature', 'K')],
  appliedTotal: [v(0, 'N'), v(0, 'N'), v(0, 'N')],
};
const model: ModelSummary = { name: 'controls', revision: 2, hash: 'h', units: {}, idealisation: 'solid3d', bodies: [{ name: 'bar', faces: [], measure: v(1, 'm^3'), bbox: [v(0, 'm'), v(0, 'm'), v(0, 'm'), v(1, 'm'), v(1, 'm'), v(1, 'm')] }], materials: [], sets: [], constraints: [], loads: [], connections: [],
  // A retained mechanical Result can survive a procedure edit; controls must use its fields.
  steps: [{ name: 'retained', procedure: 'heat-steady', constraints: [], loads: [], solved: true }], meshSettings: null, warnings: [],
};
const mounted: HTMLElement[] = [];
function mount(patch: Partial<UiState>) {
  const store = new Store();
  store.set({ ready: true, model, viewMode: 'results', tab: 'results', fieldKey: 'temperature', legend: { min: 0, max: 100, unit: 'K' }, ...patch });
  const root = document.createElement('div'); document.body.append(root); mounted.push(root);
  const dispatch = vi.fn<Dispatch>(async () => undefined);
  const query = vi.fn(async () => ({ value: { value: -100, unit: 'W/m^2' }, element: 0, interpolated: true }));
  act(() => render(<App store={store} dispatch={dispatch} viewer={{ current: null }} query={query} />, root));
  return { root, store, dispatch, query };
}
afterEach(() => { for (const root of mounted.splice(0)) { act(() => render(null, root)); root.remove(); } });

describe('retained Result deformation capabilities', () => {
  it('keeps steady temperature scalar without a deformation bar or scale copy', () => {
    const { root } = mount({ result: thermal, deformScale: 1000 });
    expect(root.querySelector('.legend-sub')?.textContent).toBe('retained');
    expect(root.querySelector('.legend-sub')?.getAttribute('title')).toBeNull();
    expect(root.querySelector('.deform-bar')).toBeNull();
    expect(root.querySelector('.result-header')?.textContent).not.toMatch(/drawn|exaggerat|true scale/);
  });

  it('retains temperature frame/time controls and their explicit registry target', () => {
    const history = [{ time: v(0, 's'), min: v(0, 'K'), max: v(0, 'K') }, { time: v(10, 's'), min: v(0, 'K'), max: v(100, 'K') }];
    const catalogue = { resultId: thermal.resultId, step: thermal.step, modelHash: 'h', stale: false, nodeCount: 1, field: 'temperature', components: 1, storedComponents: 1, retainedBytes: 16,
      frames: history.map((row, index) => ({ index, timeSi: row.time.value, time: row.time })) } as const;
    const { root, dispatch } = mount({ result: { ...thermal, history }, transient: { generation: 1, catalogue, frame: catalogue.frames[1]!, playing: false, speed: 1 } });
    expect(root.querySelector('.legend-sub')?.textContent).toBe('retained · 10 s');
    expect(root.querySelector('.legend-sub')?.getAttribute('title')).toBeNull();
    expect(root.querySelector('[aria-label="retained transient frame"]')).not.toBeNull();
    expect(root.querySelector('[aria-label="displayed transient time"]')?.textContent).toBe('10 s');
    expect(root.querySelector('[data-cmd="view.animate"]')).toBeNull();
    expect(root.querySelector('[aria-label="exaggeration"]')).toBeNull();
    expect(root.querySelector('.result-header')?.textContent).not.toMatch(/drawn|exaggerat|true scale/);
    root.querySelector<HTMLButtonElement>('.deform-bar [data-cmd="view.playTransient"]')!.click();
    expect(dispatch).toHaveBeenCalledWith({ cmd: 'view.playTransient', step: 'retained', playing: true });
  });

  it.each(['vonMises', 'temperature'])('keeps displacement controls under the mechanical %s contour, even after a procedure edit', fieldKey => {
    const { root, dispatch } = mount({ result: { ...mechanical, stale: true }, fieldKey, deformScale: 20, legend: { min: 0, max: 1, unit: fieldKey === 'temperature' ? 'K' : 'Pa' } });
    expect(root.querySelector('[aria-label="exaggeration"]')).not.toBeNull();
    expect(root.querySelector('.legend-sub')?.textContent).toContain('exaggerated ×20');
    expect(root.querySelector('.result-header')?.textContent).toContain('drawn exaggerated ×20');
    root.querySelector<HTMLButtonElement>('.deform-bar button[data-cmd="view.setDeformScale"]')!.click();
    expect(dispatch).toHaveBeenCalledWith({ cmd: 'view.setDeformScale', scale: 'true' });
  });

  it('offers a retained mode shape without requiring a static displacement extreme', () => {
    const { root } = mount({ result: { ...mechanical, modeCount: 1, extremes: [], frequencies: [v(40, 'Hz')] }, fieldKey: 'mode:1', legend: { min: 0, max: 1, unit: 'm' } });
    expect(root.querySelector('[aria-label="animation phase"]')).not.toBeNull();
    expect(root.querySelector('[aria-label="exaggeration"]')).not.toBeNull();
    expect(root.querySelector('.result-header')?.textContent).toContain('drawn at true scale');
  });

  it('removes displacement controls when the selected solve becomes temperature-only', async () => {
    const { root, store } = mount({ result: mechanical });
    expect(root.querySelector('[aria-label="exaggeration"]')).not.toBeNull();
    await act(async () => store.set({ result: thermal, transient: null }));
    expect(root.querySelector('.deform-bar')).toBeNull();
    expect(root.querySelector('.legend-sub')?.textContent).toBe('retained');
    expect(root.querySelector('.result-header')?.textContent).not.toMatch(/drawn|exaggerat|true scale/);
  });

  it('leaves actual retained playback for endpoint vectors and labels the final time in UI and exports', async () => {
    const history = [0, 1, 2].map(time => ({ time: v(time, 's'), min: v(300 + 10 * time, 'K'), max: v(300 + 10 * time, 'K') }));
    const result: ResultSummary = { ...thermal, step: 'warm', history,
      extremes: [extreme('temperature', 'K'), extreme('temperatureGradient', 'K/m'), extreme('heatFlux', 'W/m^2')] };
    const catalogue: FramesResult = { resultId: result.resultId, step: result.step, modelHash: 'h', stale: false,
      field: 'temperature', components: 3, storedComponents: 1, nodeCount: 1, retainedBytes: 48,
      frames: history.map((row, index) => ({ index, timeSi: row.time.value, time: row.time })) };
    const frame = (index: number): FrameResult => ({ field: 'temperature', components: 3, nodeCount: 1, unit: 'K',
      sample: { resultId: result.resultId, step: result.step, modelHash: 'h', frame: catalogue.frames[index]! },
      values: [300 + index * 10, 0, 0] });
    const { root, store, query: sampleQuery } = mount({ result });
    const drawing = { setSurface: vi.fn(), setField: vi.fn(), setDeformed: vi.fn(), setMode: vi.fn(),
      setDim: vi.fn(), animate: vi.fn(), autoScale: vi.fn(() => 1) };
    const clock = { now: () => 0, schedule: vi.fn(() => 'owned-timer'), cancel: vi.fn() };
    const field = vi.fn(async (_step: string | undefined, name: string): Promise<FieldData> => ({
      values: Float32Array.from([name === 'heatFlux' ? -100 : name === 'temperatureGradient' ? 20 : 320]),
      min: -100, max: 320, unit: '', per: name === 'temperature' ? 'node' : 'elementNode',
    }));
    const transport = {
      query: vi.fn(async (q: Query): Promise<QueryResult> => {
        if (q.query === 'query.result') return result;
        if (q.query === 'query.frames') return catalogue;
        if (q.query === 'query.frame') return frame(q.index ?? (q.sample?.kind === 'frame' ? q.sample.index : 0));
        throw new Error(`unexpected query ${q.query}`);
      }), field,
      surface: vi.fn(async () => ({ positions: new Float32Array([0, 0, 0]), indices: new Uint32Array(), source: 'mesh' as const })),
    };
    const view = new ResultsView(store, transport as unknown as EngineTransport, { current: drawing } as never, clock);
    // Follow the actual solve-completion path, which initially opens the last temperature frame.
    await act(async () => view.onAck({ output: { type: 'solve' } }));
    expect(store.state.transient?.frame.index).toBe(2);
    await act(async () => view.playTransient({ step: 'warm', playing: true, sample: { kind: 'frame', index: 0 } }));
    expect(root.querySelector('[aria-label="displayed transient time"]')?.textContent).toBe('0 s');
    expect(store.state.transient?.playing).toBe(true);
    await act(async () => view.showField({ field: 'heatFlux', component: 0 }));
    expect(clock.cancel).toHaveBeenCalledWith('owned-timer');
    expect(store.state.transient).toBeNull();
    expect(field).toHaveBeenLastCalledWith('warm', 'heatFlux', 0, result.resultId);
    expect(drawing.setField).toHaveBeenLastCalledWith(Float32Array.from([-100]), [-100, -100], 'elementNode');
    expect(root.querySelector('[aria-label="displayed transient time"]')).toBeNull();
    expect(root.querySelector('.legend-sub')?.textContent).toBe('warm · final endpoint 2 s');
    expect(view.legendBurn()?.title).toBe('qx · final endpoint 2 s');
    await act(async () => root.querySelector<HTMLButtonElement>('[data-cmd="query.probe"]')!.click());
    expect(sampleQuery).toHaveBeenLastCalledWith({ query: 'query.probe', step: 'warm', field: 'heatFlux', component: 0, at: ['0 mm', '0 mm', '0 mm'] });
    await act(async () => view.showField({ field: 'temperatureGradient', component: 0 }));
    expect(view.legendBurn()?.title).toBe('∇Tx · final endpoint 2 s');
    // Re-entering history restores the primary temperature field and its real selected time.
    await act(async () => view.playTransient({ step: 'warm', playing: false, sample: { kind: 'frame', index: 1 } }));
    expect(store.state.fieldKey).toBe('temperature');
    expect(root.querySelector('[aria-label="displayed transient time"]')?.textContent).toBe('1 s');
    expect(view.legendBurn()?.title).toBe('T · 1 s');
  });
});
