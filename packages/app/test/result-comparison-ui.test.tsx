import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { RESULT } from '../../registry/test/fakes';
import { ComparisonControls, ComparisonPaneChrome } from '../src/ui/ResultComparison';
import { Store } from '../src/store';
import { afterEffects, waitFor } from './wait-for';
import type { Query } from '../src/ui/SchemaForm';

afterEach(async () => { await act(async () => { for (const root of [...document.body.children]) render(null, root); }); document.body.replaceChildren(); });
function setup() {
  const store = new Store(), dispatch = vi.fn(async () => undefined);
  const catalogue = { limit: 8, records: ['old', 'new'].map((id, i) => ({ id, step: 'static', solvedRevision: i, modelName: id, modelHash: id, inputHash: id, stale: i === 0, nodes: 3, elements: 1, fieldBytes: 72, meshBytes: 100, modelJsonBytes: 100 })) };
  store.set({ resultComparison: { ...store.state.resultComparison, catalogue } });
  const root = document.createElement('div'); document.body.append(root);
  const query = vi.fn(async (input: Parameters<Query>[0]) => ({ ...RESULT, resultId: input['resultId'], extremes: [RESULT.extremes[0]!, { ...RESULT.extremes[0]!, field: 'vonMises' }] }));
  return { store, dispatch, root, query };
}
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
    bodyNames: ['old-body'], hiddenBodies: [], pick: { resultId: 'old', pane: 'difference' as const, field: 'temperature', component: null, at: [{ value: 0, unit: 'm' }, { value: 0, unit: 'm' }, { value: 0, unit: 'm' }] as [{ value: number; unit: string }, { value: number; unit: string }, { value: number; unit: string }], body: 'old-body', face: null, node: 2, value: null, difference: true }, error: null };
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
