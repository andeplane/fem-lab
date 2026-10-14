import type { Extreme, ModelSummary, ResultSummary } from '@femlab/registry';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store, type UiState } from '../src/store';
import { App } from '../src/ui/App';
import type { Dispatch } from '../src/ui/cmd';

const v = (value: number, unit: string) => ({ value, unit });
const point = [v(0, 'm'), v(0, 'm'), v(0, 'm')] as const;
const extreme = (field: string, unit: string): Extreme => ({ field, component: 0, min: v(0, unit), max: v(1, unit), minAt: [...point], maxAt: [...point] });
const thermal: ResultSummary = {
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
  act(() => render(<App store={store} dispatch={dispatch} viewer={{ current: null }} query={async () => ({ value: 1, unit: 'K' })} />, root));
  return { root, store, dispatch };
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
    const { root } = mount({ result: { ...mechanical, extremes: [], frequencies: [v(40, 'Hz')] }, fieldKey: 'mode:1', legend: { min: 0, max: 1, unit: 'm' } });
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
});
