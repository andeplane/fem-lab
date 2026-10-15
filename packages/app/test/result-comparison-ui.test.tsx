import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { RESULT } from '../../registry/test/fakes';
import { FemError, type FramesResult } from '@femlab/registry';
import { ComparisonControls, ComparisonPaneChrome } from '../src/ui/ResultComparison';
import { Store } from '../src/store';
import { afterEffects, waitFor } from './wait-for';
import type { Query } from '../src/ui/SchemaForm';
import type { ComparisonPaneState } from '@femlab/registry';

afterEach(async () => { await act(async () => { for (const root of [...document.body.children]) render(null, root); }); document.body.replaceChildren(); });
function setup() {
  const store = new Store(), dispatch = vi.fn(async () => undefined);
  const catalogue = { limit: 8, records: ['old', 'new'].map((id, i) => ({ id, step: 'static', solvedRevision: i, modelName: id, modelHash: id, inputHash: id, stale: i === 0, nodes: i ? 9 : 3, elements: i ? 4 : 1, fieldBytes: 72, meshBytes: 100, modelJsonBytes: 100 })) };
  store.set({ resultComparison: { ...store.state.resultComparison, catalogue } });
  const root = document.createElement('div'); document.body.append(root);
  const query = vi.fn(async (input: Parameters<Query>[0]) => {
    if (input['query'] === 'query.frames') throw new FemError('unsupported', 'final-only History');
    return { ...RESULT, resultId: input['resultId'], extremes: [RESULT.extremes[0]!, { ...RESULT.extremes[0]!, field: 'vonMises' }] };
  });
  return { store, dispatch, root, query };
}
it('keeps the empty comparison strip mounted as the first retained Result fills its disabled controls', async () => {
  const { store, dispatch, root, query } = setup();
  const catalogue = store.state.resultComparison.catalogue;
  store.set({ resultComparison: { ...store.state.resultComparison, catalogue: { ...catalogue, records: [] } } });
  await act(async () => render(<ComparisonControls s={store.state} dispatch={dispatch} query={query} />, root));
  await afterEffects();
  const strip = root.querySelector('.comparison-controls');
  const operands = [...root.querySelectorAll('.comparison-operands fieldset')];
  expect(strip).not.toBeNull(); expect(operands).toHaveLength(2);
  expect(root.querySelector<HTMLButtonElement>('.comparison-actions .apply')?.disabled).toBe(true);
  expect(root.querySelector('[aria-label="left Result"]')?.textContent).toContain('Select Result');
  expect(query).not.toHaveBeenCalled();

  const first = catalogue.records[1]!;
  store.set({ resultComparison: { ...store.state.resultComparison, catalogue: { ...catalogue, records: [first] } } });
  await act(async () => render(<ComparisonControls s={store.state} dispatch={dispatch} query={query} />, root));
  await waitFor(() => root.querySelector<HTMLSelectElement>('[aria-label="left field"]')?.options.length === 5);
  expect(root.querySelector('.comparison-controls')).toBe(strip);
  expect([...root.querySelectorAll('.comparison-operands fieldset')]).toEqual(operands);
  expect(root.querySelector<HTMLButtonElement>('.comparison-actions .apply')?.disabled).toBe(false);
  expect(query.mock.calls).toEqual([
    [{ query: 'query.result', resultId: first.id }],
    [{ query: 'query.frames', resultId: first.id }],
  ]);
  root.querySelector<HTMLButtonElement>('.comparison-actions [aria-pressed="true"]')!.click();
  expect(dispatch).toHaveBeenLastCalledWith({ cmd: 'view.compareResults', mode: 'single' });
});
it('submits two explicit solve identities and independent engine field components, with an explicit difference target', async () => {
  const { store, dispatch, root, query } = setup();
  await act(async () => render(<ComparisonControls s={store.state} dispatch={dispatch} query={query} />, root));
  await waitFor(() => root.querySelector<HTMLSelectElement>('[aria-label="left field"]')?.options.length === 5);
  const select = (label: string, value: string) => {
    const element = root.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!; element.value = value; element.dispatchEvent(new Event('change', { bubbles: true }));
  };
  await act(async () => { select('left field', 'ux'); select('right field', 'vonMises'); select('comparison presentation', 'difference'); });
  await act(async () => select('difference target mesh', 'right'));
  root.querySelector<HTMLButtonElement>('.comparison-actions .apply')!.click();
  expect(dispatch).toHaveBeenLastCalledWith({ cmd: 'view.compareResults', mode: 'difference', onto: 'right', left: { resultId: 'old', field: 'displacement', component: 0 }, right: { resultId: 'new', field: 'vonMises', component: 0 } });
  expect(query).toHaveBeenCalledWith({ query: 'query.result', resultId: 'old' });
  expect(query).toHaveBeenCalledWith({ query: 'query.result', resultId: 'new' });
});
it('scopes all pane controls to a retained id and shows honest stale, units, coverage and missing picks', async () => {
  const { store, dispatch, root } = setup();
  const pane = { operand: { resultId: 'old', field: 'temperature' }, summary: { ...RESULT, stale: true }, label: 'temperature left − temperature right',
    legend: { min: { value: -10, unit: 'degC' }, max: { value: 10, unit: 'degC' }, colormap: 'viridis' as const, automatic: true, difference: true },
    bodyNames: ['old-body'], hiddenBodies: [], canDeform: false, frames: null, sample: null, pick: { resultId: 'old', pane: 'difference' as const, field: 'temperature', component: null, at: [{ value: 0, unit: 'm' }, { value: 0, unit: 'm' }, { value: 0, unit: 'm' }] as [{ value: number; unit: string }, { value: number; unit: string }, { value: number; unit: string }], body: 'old-body', face: null, node: 2, value: null, difference: true, samples: { left: null, right: null } }, error: null };
  store.set({ resultComparison: { ...store.state.resultComparison, coverage: { insideNodes: 2, totalNodes: 3, outsideNodes: [2] }, interpolated: true } });
  await act(async () => render(<ComparisonPaneChrome pane={pane} name="difference" s={store.state} dispatch={dispatch} />, root));
  expect(root.textContent).toContain('stale'); expect(root.textContent).toContain('2/3 nodes covered'); expect(root.textContent).toContain('interpolated'); expect(root.textContent).toContain('Δ degC'); expect(root.textContent).toContain('unavailable coverage');
  root.querySelector<HTMLButtonElement>('[data-cmd="view.setComparisonVisible"]')!.click();
  expect(dispatch).toHaveBeenLastCalledWith({ cmd: 'view.setComparisonVisible', pane: 'difference', resultId: 'old', bodies: ['old-body'], on: false });
  const minimum = root.querySelector<HTMLInputElement>('[aria-label="difference legend minimum"]')!;
  await act(async () => { minimum.value = '-5'; minimum.dispatchEvent(new Event('input', { bubbles: true })); });
  root.querySelector<HTMLButtonElement>('.comparison-legend form button')!.click();
  expect(dispatch).toHaveBeenLastCalledWith({ cmd: 'view.setComparisonLegend', pane: 'difference', resultId: 'old', range: [{ value: -5, unit: 'degC' }, { value: 10, unit: 'degC' }] });
  await act(async () => render(<ComparisonPaneChrome pane={{ ...pane, legend: null }} name="difference" s={store.state} dispatch={dispatch} />, root)); await afterEffects();
  expect(root.textContent).toContain('No covered data'); expect(root.querySelector('.comparison-gradient')).toBeNull();
});

it('keeps an available pane field picker usable when the other retained id has been evicted', async () => {
  const { store, dispatch, root, query } = setup();
  const read = async (input: Parameters<Query>[0]) => {
    if (input['resultId'] === 'old') throw new Error('evicted Result');
    return query(input);
  };
  await act(async () => render(<ComparisonControls s={store.state} dispatch={dispatch} query={read} />, root));
  await waitFor(() => root.querySelector<HTMLSelectElement>('[aria-label="right field"]')?.options.length === 5);
  expect(root.querySelector('[aria-label="left field"]')?.textContent).toContain('No available fields');
  expect(root.querySelector<HTMLButtonElement>('.comparison-actions .apply')?.disabled).toBe(true);
});

it('shows each exact retained Mesh count and preserves an evicted pane diagnostic without inventing counts', async () => {
  const { store, dispatch, root } = setup();
  const pane = (resultId: string): ComparisonPaneState => ({ operand: { resultId, field: 'displacement', component: 0 }, summary: RESULT, label: 'ux', legend: null, bodyNames: [], hiddenBodies: [], canDeform: false, frames: null, sample: null, pick: null, error: null });
  const left = pane('old'), right = pane('new');
  await act(async () => render(<><ComparisonPaneChrome pane={left} name="left" s={store.state} dispatch={dispatch} /><ComparisonPaneChrome pane={right} name="right" s={store.state} dispatch={dispatch} /></>, root));
  expect([...root.querySelectorAll('.comparison-mesh')].map(element => element.textContent)).toEqual(['Mesh · nodes 3 · elements 1', 'Mesh · nodes 9 · elements 4']);
  store.set({ resultComparison: { ...store.state.resultComparison, catalogue: { ...store.state.resultComparison.catalogue, records: store.state.resultComparison.catalogue.records.filter(record => record.id !== 'old') } } });
  const evicted: ComparisonPaneState = { ...left, error: { code: 'not-found', cause: "retained Result 'old' is unavailable or evicted", where: 'resultId', suggestion: 'select an available id from query.results' } };
  await act(async () => render(<><ComparisonPaneChrome pane={evicted} name="left" s={store.state} dispatch={dispatch} /><ComparisonPaneChrome pane={right} name="right" s={store.state} dispatch={dispatch} /></>, root));
  expect(root.querySelector('.comparison-pane-title')?.textContent).toContain('unavailable or evicted');
  expect([...root.querySelectorAll('.comparison-mesh')].map(element => element.textContent)).toEqual(['Mesh · nodes 9 · elements 4']);
});

it('shows primary-only sampled choices and dispatches explicit unequal frame/time selectors without derived fallback', async () => {
  const { store, dispatch, root, query } = setup();
  const read: Query = async input => {
    if (input['query'] !== 'query.frames') return query(input);
    const frames: FramesResult = { resultId: String(input['resultId']), step: 'static', modelHash: String(input['resultId']), stale: false, nodeCount: 3, field: 'displacement', components: 3, storedComponents: 3, retainedBytes: 240,
      frames: [0, 0.4, 0.8].map((timeSi, index) => ({ index, timeSi, time: { value: timeSi * 1000, unit: 'ms' } })) };
    return frames;
  };
  await act(async () => render(<ComparisonControls s={store.state} dispatch={dispatch} query={read} />, root));
  await waitFor(() => root.querySelector<HTMLSelectElement>('[aria-label="left field"]')?.options.length === 5);
  const select = (label: string, value: string) => {
    const element = root.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!; element.value = value; element.dispatchEvent(new Event('change', { bubbles: true }));
  };
  await act(async () => { select('left sample selection', 'frame'); select('right sample selection', 'time'); });
  expect(root.querySelector('[aria-label="left field"]')?.textContent).not.toContain('von Mises');
  await act(async () => { select('left retained frame', '1'); select('right time sampling', 'nearest'); });
  const time = root.querySelector<HTMLInputElement>('[aria-label="right physical time"]')!;
  await act(async () => { time.value = '450 ms'; time.dispatchEvent(new Event('input', { bubbles: true })); });
  root.querySelector<HTMLButtonElement>('.comparison-actions .apply')!.click();
  expect(dispatch).toHaveBeenLastCalledWith({ cmd: 'view.compareResults', mode: 'sideBySide', left: { resultId: 'old', field: 'displacement', sample: { kind: 'frame', index: 1 } }, right: { resultId: 'new', field: 'displacement', sample: { kind: 'time', time: '450 ms', sampling: 'nearest' } } });
});
