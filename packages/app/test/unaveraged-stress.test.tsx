import type { EngineTransport, ResultSummary, Valued } from '@femlab/registry';
import { render } from 'preact';
import { describe, expect, it, vi } from 'vitest';
import { choiceOf, displayUnitOf, fieldChoices, showFieldArgs, siUnitOf } from '../src/fields';
import { ResultsView, available, fieldKeyOf } from '../src/results';
import { Store, initialState } from '../src/store';
import { Results, extremeLabel } from '../src/ui/Results';

const point: [Valued, Valued, Valued] = [0, 0, 0].map(value => ({ value, unit: 'm' })) as [Valued, Valued, Valued];
const result: ResultSummary = {
  resultId: 'unaveraged-result', step: 'static', reactionQuantity: 'force', revision: 1,
  stale: false, solver: 'cpu-direct', iterations: 1, residual: 0, timeMs: 1,
  extremes: ['xx', 'yy', 'zz', 'xy', 'xz', 'yz'].map((_, component) => ({
    field: 'stressUnaveraged', component,
    min: { value: -2, unit: 'MPa' }, minAt: point,
    max: { value: 4, unit: 'MPa' }, maxAt: point,
  })),
  reactions: [], appliedTotal: [{ value: 0, unit: 'N' }, { value: 0, unit: 'N' }, { value: 0, unit: 'N' }], balance: 0,
};

describe('unaveraged stress choices', () => {
  it('offers all six components only when the Result contains unaveraged stress', () => {
    const choices = fieldChoices(result.extremes.map(extreme => extreme.field));
    expect(choices.map(choice => choice.label)).toEqual([
      'σxx unaveraged', 'σyy unaveraged', 'σzz unaveraged',
      'σxy unaveraged', 'σxz unaveraged', 'σyz unaveraged',
    ]);
    expect(fieldChoices(['stress']).some(choice => choice.field === 'stressUnaveraged')).toBe(false);
    expect(fieldChoices([])).toEqual([]);
    expect(siUnitOf('stressUnaveraged')).toBe('Pa');
    expect(displayUnitOf('stressUnaveraged', { stress: 'MPa' })).toBe('MPa');
    choices.forEach((choice, component) => {
      expect(showFieldArgs(choice)).toEqual({ field: 'stressUnaveraged', component });
      expect(choiceOf(fieldKeyOf('stressUnaveraged', component))).toEqual(choice);
      expect(extremeLabel({ field: 'stressUnaveraged', component })).toBe(choice.label);
    });
    expect(available(choices[3]!.key, result, false)).toBe(choices[3]!.key);
    expect(available(choices[3]!.key, { ...result, extremes: [] }, false)).toBe('vonMises');
    expect(() => fieldKeyOf('stressUnaveraged', 6)).toThrowError(expect.objectContaining({ code: 'unsupported' }));
  });

  it('shows the labelled per-component extremes with stress units', () => {
    const root = document.createElement('div');
    render(<Results s={{ ...initialState, result }} dispatch={vi.fn()} query={vi.fn()} />, root);
    const rows = [...root.querySelectorAll('.rtable tbody tr')].slice(0, 6);
    expect(rows.map(row => row.children[0]!.textContent)).toEqual([
      'σxx unaveragedstressUnaveraged', 'σyy unaveragedstressUnaveraged', 'σzz unaveragedstressUnaveraged',
      'σxy unaveragedstressUnaveraged', 'σxz unaveragedstressUnaveraged', 'σyz unaveragedstressUnaveraged',
    ]);
    rows.forEach(row => {
      expect(row.children[1]!.textContent.trim()).toBe('-2 MPa');
      expect(row.children[2]!.textContent.trim()).toBe('4 MPa');
    });
    render(null, root);
  });

  it('retains each member end value and its element-node location when contouring', async () => {
    // Two members meeting at one joint keep their own stresses; a nodal average would lose
    // the discontinuity between the first member's end and the second member's start.
    const values = new Float32Array([-2, -2, 4, 4]);
    const store = new Store({ ...initialState, result, viewMode: 'results' });
    const viewer = { current: {
      setSurface: vi.fn(), setField: vi.fn(), setDeformed: vi.fn(), setDim: vi.fn(),
      setMode: vi.fn(), autoScale: vi.fn(() => 1), animate: vi.fn(),
    } };
    const transport = {
      query: vi.fn(async () => result),
      surface: vi.fn(async () => ({ positions: new Float32Array(9), indices: new Uint32Array(), source: 'mesh' })),
      field: vi.fn(async () => ({ values, min: -2, max: 4, unit: 'Pa', per: 'elementNode' })),
    };
    const view = new ResultsView(store, transport as unknown as EngineTransport, viewer as never);
    await view.showField({ field: 'stressUnaveraged', component: 0 });
    expect(transport.field).toHaveBeenCalledExactlyOnceWith('static', 'stressUnaveraged', 0, result.resultId);
    expect(viewer.current.setField).toHaveBeenLastCalledWith(values, [-2, 4], 'elementNode');
    expect([...values]).toEqual([-2, -2, 4, 4]);
    expect(store.state.legend).toEqual({ min: -2, max: 4, unit: 'Pa' });
  });
});
