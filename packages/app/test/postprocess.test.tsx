// The post-processing the design's Results tab asks for: the history plot and the frequencies
// table, the mode-shape sweep on the deformation bar, and the two derived checks. Each piece is
// a pure function or a component over one `query.result` fixture, so none of this needs wasm.
import type { ResultSummary, StudyReport } from '@femlab/registry';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DERIVED_CHOICES, choiceOf, displayUnitOf, fieldChoices, modeChoice, showFieldArgs, siUnitOf } from '../src/fields';
import { SAFETY_CAP, available, derive, derivedRange, extent, fieldKeyOf, magnitude } from '../src/results';
import { Store, initialState, type UiState } from '../src/store';
import { App } from '../src/ui/App';
import type { Dispatch } from '../src/ui/cmd';
import { Frequencies, History, LineChart, axisTicks, extremeLabel } from '../src/ui/Results';
import { resultItems } from '../src/ui/Tree';

const v = (value: number, unit: string) => ({ value, unit });

const RESULT = {
  step: 'modal',
  revision: 9,
  stale: false,
  solver: 'cpu-direct',
  iterations: 1,
  residual: 0,
  timeMs: 12,
  extremes: [{ field: 'vonMises', component: 0, min: v(0.1, 'MPa'), minAt: [v(0, 'mm'), v(0, 'mm'), v(0, 'mm')], max: v(12.4, 'MPa'), maxAt: [v(1, 'mm'), v(2, 'mm'), v(3, 'mm')] }],
  reactions: [],
  appliedTotal: [v(0, 'kN'), v(0, 'kN'), v(0, 'kN')],
  balance: 0,
} as unknown as ResultSummary;

const modal = { ...RESULT, frequencies: [v(41.2, 'Hz'), v(258.1, 'Hz'), v(0, 'Hz')] } as ResultSummary;
const transient = {
  ...RESULT,
  step: 'heat',
  extremes: [{ field: 'temperature', component: 0, min: v(293.1, 'K'), minAt: [], max: v(295.1, 'K'), maxAt: [] }],
  history: [
    { time: v(0, 's'), min: v(20, 'degC'), max: v(20, 'degC') },
    { time: v(10, 's'), min: v(20, 'degC'), max: v(48, 'degC') },
    { time: v(20, 's'), min: v(21, 'degC'), max: v(63, 'degC') },
  ],
} as unknown as ResultSummary;

const state = (patch: Partial<UiState>): UiState => ({ ...initialState, ...patch });

describe('the field table, once a Result has modes and a yield', () => {
  it('names a mode shape by the wire name Engine::field_named takes', () => {
    expect(modeChoice(3)).toMatchObject({ key: 'mode:3', field: 'mode:3', label: 'mode 3', magnitude: true, mode: 3 });
    expect(choiceOf('mode:3')).toEqual(modeChoice(3));
    expect(choiceOf('nonsense').key).toBe('vonMises');
  });

  it('gives a mode shape the length dimension and the derived checks none', () => {
    expect(siUnitOf('mode:2')).toBe('m');
    expect(displayUnitOf('mode:2', { length: 'mm' } as never)).toBe('mm');
    expect(siUnitOf('utilisation')).toBe('');
    expect(displayUnitOf('safety', { length: 'mm' } as never)).toBe('');
  });

  it('offers one row per mode and the two derived checks only when a yield is known', () => {
    expect(fieldChoices(['vonMises'], 0, false).map((c) => c.key)).toEqual(['vonMises']);
    expect(fieldChoices(['vonMises'], 2, false).map((c) => c.key)).toEqual(['vonMises', 'mode:1', 'mode:2']);
    expect(fieldChoices(['vonMises'], 0, true).map((c) => c.key)).toEqual(['vonMises', 'safety', 'utilisation']);
    // Both derived rows read the von Mises array; nothing new is asked of the engine.
    expect(DERIVED_CHOICES.every((c) => c.field === 'vonMises')).toBe(true);
    // No von Mises, no check to derive from.
    expect(fieldChoices(['displacement'], 0, true).map((c) => c.key)).toEqual(['umag', 'ux', 'uy', 'uz']);
  });

  it('names a derived choice by its own key, not by the array it reads', () => {
    expect(showFieldArgs(choiceOf('utilisation'))).toEqual({ field: 'utilisation' });
    expect(showFieldArgs(choiceOf('safety'))).toEqual({ field: 'safety' });
    expect(showFieldArgs(choiceOf('uz'))).toEqual({ field: 'displacement', component: 2 });
    expect(showFieldArgs(choiceOf('umag'))).toEqual({ field: 'displacement' });
    expect(showFieldArgs(modeChoice(2))).toEqual({ field: 'mode:2' });
  });

  it('contours a Result by a field it actually has', () => {
    // A modal Step computes displacement and no stress at all.
    const modes = { ...modal, extremes: [{ field: 'displacement', component: 0, min: v(-1, 'mm'), minAt: [], max: v(1, 'mm'), maxAt: [] }] } as unknown as ResultSummary;
    expect(available('vonMises', modes, false)).toBe('mode:1');
    expect(available('mode:3', modes, false)).toBe('mode:3');
    // Beyond the modes it found, back to the first.
    expect(available('mode:9', modes, false)).toBe('mode:1');
    // A static Step keeps what was chosen, and falls back to what it did compute.
    expect(available('vonMises', RESULT, false)).toBe('vonMises');
    expect(available('uz', RESULT, false)).toBe('vonMises');
    // A derived choice survives only while a yield is known.
    expect(available('utilisation', RESULT, true)).toBe('utilisation');
    expect(available('utilisation', RESULT, false)).toBe('vonMises');
    // A heat Step has neither.
    expect(available('vonMises', transient, false)).toBe('temperature');
  });

  it('round-trips a showField argument back to a picker key', () => {
    expect(fieldKeyOf('mode:4', null)).toBe('mode:4');
    expect(fieldKeyOf('utilisation', null)).toBe('utilisation');
    expect(fieldKeyOf('displacement', 2)).toBe('uz');
    expect(fieldKeyOf('displacement', null)).toBe('umag');
  });
});

describe('the derived fields', () => {
  it('is the utilisation against yield, and its reciprocal as a safety factor', () => {
    const vm = Float32Array.from([0, 100e6, 355e6, 710e6]);
    expect([...derive(vm, 355e6, 'utilisation')]).toEqual([0, expect.closeTo(0.2817, 4), 1, 2]);
    const safety = [...derive(vm, 355e6, 'safety')];
    // Nil stress is infinite safety, which no legend can draw: it is capped, and so is the top.
    expect(safety[0]).toBe(SAFETY_CAP);
    expect(safety[2]).toBe(1);
    expect(safety[3]).toBeCloseTo(0.5, 6);
    expect(Math.max(...safety)).toBeLessThanOrEqual(SAFETY_CAP);
  });

  it('signs do not matter: a compressive von Mises is still a magnitude', () => {
    expect([...derive(Float32Array.from([-355e6]), 355e6, 'utilisation')]).toEqual([1]);
  });

  it('opens a utilisation legend against the limit and a factor against the cap', () => {
    expect(derivedRange('utilisation', 0.3)).toEqual([0, 1]);
    expect(derivedRange('utilisation', 2.4)).toEqual([0, 2.4]);
    expect(derivedRange('safety', 40)).toEqual([0, SAFETY_CAP]);
    expect(derivedRange('safety', 0.2)).toEqual([0, 1]);
  });

  it('finds the extent of an array, and says 0..1 for an empty one', () => {
    expect(extent(Float32Array.from([3, -1, 7]))).toEqual([-1, 7]);
    expect(extent(new Float32Array(0))).toEqual([0, 1]);
    expect([...magnitude(Float32Array.from([3, 4, 0]), true)]).toEqual([5]);
  });
});

describe('the line chart', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('puts round ticks on both axes', () => {
    expect(axisTicks(0, 100, 5).map((t) => t.text)).toEqual(['0', '25', '50', '75', '100']);
    expect(axisTicks(2, 2, 3).map((t) => t.text)).toEqual(['2', '2', '2']);
  });

  it('plots the points and names the axes with their units until one is hovered', () => {
    const root = document.createElement('div');
    render(<LineChart x={[0, 1, 2]} y={[0, 5, 10]} xUnit="s" yUnit="degC" xLabel="t" yLabel="max" />, root);
    expect(root.querySelector('polyline')!.getAttribute('points')!.split(' ')).toHaveLength(3);
    expect(root.textContent).toContain('max (degC) against t (s)');
    expect(root.querySelectorAll('text')).toHaveLength(8); // five on y, three on x
  });

  it('draws a reference line when one is given, and skips samples with no value', () => {
    const root = document.createElement('div');
    render(<LineChart x={[0, 1, 2]} y={[0, null, 10]} xUnit="" yUnit="" xLabel="s" yLabel="v" mark={5} />, root);
    expect(root.querySelector('line[stroke-dasharray]')).not.toBeNull();
    expect(root.querySelector('polyline')!.getAttribute('points')!.split(' ')).toHaveLength(2);
  });

  it('says how many samples it had rather than drawing a line through one point', () => {
    const root = document.createElement('div');
    render(<LineChart x={[0, 1]} y={[null, 3]} xUnit="" yUnit="" xLabel="s" yLabel="v" />, root);
    expect(root.textContent).toContain('1 of 2 samples');
  });
});

describe('the history and the frequencies', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('draws nothing at all for a Step with no history', () => {
    const root = document.createElement('div');
    render(<History s={state({ result: RESULT })} />, root);
    expect(root.textContent).toBe('');
  });

  it('plots the max and the min of a transient Step against time', () => {
    const root = document.createElement('div');
    render(<History s={state({ result: transient })} />, root);
    expect(root.textContent).toContain('History · heat');
    expect(root.querySelectorAll('polyline')).toHaveLength(2);
    expect(root.textContent).toContain('max (degC) against t (s)');
  });

  it('lists a modal Step\'s frequencies with their periods and one Command each', () => {
    const root = document.createElement('div');
    render(<Frequencies s={state({ result: modal, fieldKey: 'mode:2' })} dispatch={async () => undefined} />, root);
    const cells = [...root.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent!.trim()));
    expect(cells[0]!.slice(0, 3)).toEqual(['1', '41.2 Hz', '0.02427 s']);
    // A rigid-body mode has no period to write.
    expect(cells[2]![2]).toBe('—');
    expect([...root.querySelectorAll('[data-cmd]')].map((e) => e.getAttribute('data-cmd'))).toEqual(['view.showField', 'view.showField', 'view.showField']);
    expect(root.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
    expect(root.querySelector('tr.peak')!.textContent).toContain('258.1');
  });

  it('shows nothing for a Step that found no frequencies', () => {
    const root = document.createElement('div');
    render(<Frequencies s={state({ result: RESULT })} dispatch={async () => undefined} />, root);
    expect(root.textContent).toBe('');
  });

  it('names an extreme the way the field picker does', () => {
    expect(extremeLabel({ field: 'displacement', component: 2 })).toBe('uz');
    expect(extremeLabel({ field: 'strain', component: 4 })).toBe('strain 4');
  });
});

describe('the Results group of the tree', () => {
  it('is empty until a Result exists, then is one row per contourable scalar', () => {
    expect(resultItems(state({}))).toEqual([]);
    const rows = resultItems(state({ result: modal, fieldKey: 'mode:1', yieldStress: 355e6 }));
    expect(rows.map((r) => r.name)).toEqual(['σ_vM', 'mode 1', 'mode 2', 'mode 3', 'n_y', 'σ/f_y']);
    expect(rows.every((r) => r.cmd === 'view.showField')).toBe(true);
    expect(rows[1]).toMatchObject({ args: { field: 'mode:1' }, active: true, summary: '41.2 Hz · mode shape' });
    expect(rows[0]!.summary).toBe('0.1 MPa … 12.4 MPa on modal');
    expect(rows[4]!.summary).toContain("Material's yield");
    // A Result is not edited by re-issuing a Command, so its rows run rather than fill the form.
    expect(rows.every((r) => r.run === true)).toBe(true);
    expect(rows[4]!.args).toEqual({ field: 'safety' });
  });

  it('does not lend one component\'s extremes to a magnitude that has none', () => {
    const withU = { ...RESULT, extremes: [{ field: 'displacement', component: 0, min: v(-1, 'mm'), minAt: [], max: v(1, 'mm'), maxAt: [] }] } as unknown as ResultSummary;
    const rows = resultItems(state({ result: withU }));
    expect(rows.map((r) => r.name)).toEqual(['|u|', 'ux', 'uy', 'uz']);
    // A magnitude has no extreme of its own, and uy and uz were not among the extremes.
    expect(rows[0]!.summary).toBe('on modal');
    expect(rows[1]!.summary).toBe('-1 mm … 1 mm on modal');
    expect(rows[2]!.summary).toBe('on modal');
  });
});

describe('the deformation bar', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  const mount = (patch: Partial<UiState>, dispatch: Dispatch = async () => undefined): { root: HTMLElement; store: Store } => {
    const store = new Store();
    store.set({ ready: true, model: { name: 'm', units: { length: 'mm' }, bodies: [{ name: 'b', faces: [], measure: v(1, 'm^3'), bbox: [v(0, 'mm'), v(0, 'mm'), v(0, 'mm'), v(1, 'mm'), v(1, 'mm'), v(1, 'mm')] }], materials: [], sets: [], constraints: [], loads: [], steps: [], warnings: [] } as never, revision: 3, viewMode: 'results', ...patch });
    const root = document.createElement('div');
    document.body.append(root);
    render(<App store={store} dispatch={dispatch} viewer={{ current: null }} query={async () => ({ value: 1, unit: 'Pa' })} />, root);
    return { root, store };
  };

  it('offers play, and no scrub, for a plain static Result', () => {
    const { root } = mount({ result: RESULT });
    const bar = root.querySelector('.deform-bar')!;
    expect(bar.querySelector('[data-cmd="view.animate"]')!.textContent).toBe('▶');
    expect(bar.querySelector('input.phase')).toBeNull();
  });

  it('offers the scrub once the Result is a mode shape or has a history', () => {
    expect(mount({ result: modal, fieldKey: 'mode:2' }).root.querySelector('.deform-bar input.phase')).not.toBeNull();
    document.body.innerHTML = '';
    const catalogue = { step: 'heat', modelHash: 'h', stale: false, nodeCount: 1, field: 'temperature', components: 3, storedComponents: 1, retainedBytes: 48, frames: transient.history!.map((row, index) => ({ index, timeSi: row.time.value, time: row.time })) } as const;
    const shown = { generation: 1, catalogue, frame: catalogue.frames[1]!, playing: false, speed: 1 };
    expect(mount({ result: transient, transient: shown }).root.querySelector('.deform-bar [aria-label="retained transient frame"]')).not.toBeNull();
  });

  it('requests playback through the registry and reflects the acknowledged host state', () => {
    const { root, store } = mount({ result: modal, fieldKey: 'mode:2' });
    const dispatch = vi.fn(async () => undefined);
    render(<App store={store} dispatch={dispatch} viewer={{ current: null }} query={async () => ({ value: 1, unit: 'Pa' })} />, root);
    const play = root.querySelector<HTMLButtonElement>('.deform-bar [data-cmd="view.animate"]')!;
    expect(play.title).toBe('sweep mode 2');
    play.click();
    expect(dispatch).toHaveBeenCalledWith({ cmd: 'view.animate', step: modal.step, mode: 2, playing: true });
    expect(store.state.playing).toBe(false);
    store.set({ playing: true }); // ResultsView owns this acknowledgement, tested through its host path.
    render(<App store={store} dispatch={async () => undefined} viewer={{ current: null }} query={async () => ({ value: 1, unit: 'Pa' })} />, root);
    expect(root.querySelector('.deform-bar [data-cmd="view.animate"]')!.textContent).toBe('❚❚');
  });

  it('offers actual retained-frame playback instead of a transient amplitude sweep', () => {
    const { root } = mount({ result: transient });
    expect(root.querySelector<HTMLButtonElement>('.deform-bar [data-cmd="view.playTransient"]')!.title).toBe('play retained transient frames');
    expect(root.querySelector('.deform-bar [data-cmd="view.animate"]')).toBeNull();
  });

  it('previews phase movement and records only a completed gesture, not cancellation', () => {
    const { root, store } = mount({ result: modal, fieldKey: 'mode:2', phase: 0.25 });
    const dispatch = vi.fn(async () => undefined);
    render(<App store={store} dispatch={dispatch} viewer={{ current: null }} query={async () => ({ value: 1, unit: 'Pa' })} />, root);
    const phase = root.querySelector<HTMLInputElement>('input.phase')!;
    for (const value of ['40', '75']) {
      phase.value = value;
      phase.dispatchEvent(new Event('input', { bubbles: true }));
    }
    expect(store.state.phase).toBe(0.75);
    expect(dispatch).not.toHaveBeenCalled();
    phase.dispatchEvent(new Event('change', { bubbles: true }));
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ cmd: 'view.animate', step: modal.step, mode: 2, playing: false, frame: 75 });
    dispatch.mockClear();
    phase.value = '30';
    phase.dispatchEvent(new Event('input', { bubbles: true }));
    phase.dispatchEvent(new Event('pointercancel', { bubbles: true }));
    phase.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.state.phase).toBe(0.75);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('rolls a rejected phase preview back to the acknowledged state', async () => {
    const { root, store } = mount({ result: modal, fieldKey: 'mode:2', phase: 0.25 });
    const viewer = { current: { animate: vi.fn(), setPhase: vi.fn() } };
    const dispatch = vi.fn(async () => { throw new Error('rejected'); });
    render(<App store={store} dispatch={dispatch} viewer={viewer as never} query={async () => ({ value: 1, unit: 'Pa' })} />, root);
    const phase = root.querySelector<HTMLInputElement>('input.phase')!;
    phase.value = '80';
    phase.dispatchEvent(new Event('input', { bubbles: true }));
    phase.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(store.state.phase).toBe(0.25));
    expect(store.state.playing).toBe(false);
    expect(viewer.current.animate).toHaveBeenLastCalledWith(false, 1, 0.25);
  });

  it('offers explicit WebM resolutions and a registry-callable cancel while recording', () => {
    const first = mount({ result: modal, fieldKey: 'mode:2', panels: { export: true } });
    const row = [...first.root.querySelectorAll('.export-row')].find((el) => el.textContent?.includes('Viewer animation'))!;
    expect([...row.querySelectorAll('[data-cmd="file.export"]')].map((el) => el.textContent?.trim())).toEqual(['720p', '1080p', 'export']);
    document.body.innerHTML = '';
    const active = mount({ result: modal, fieldKey: 'mode:2', panels: { export: true }, capturingAnimation: true });
    const cancel = active.root.querySelector('[data-cmd="file.cancelAnimationCapture"]');
    expect(cancel?.textContent?.trim()).toBe('cancel recording');
  });

  it('waits for a selected WebM export before starting the next selected file', async () => {
    let finishRecording = (): void => {
      throw new Error('recording did not start');
    };
    const recording = new Promise<void>((resolve) => {
      finishRecording = resolve;
    });
    const calls: { cmd: string; spec?: { format?: string } }[] = [];
    const dispatch: Dispatch = async (cmd): Promise<void> => {
      calls.push({ cmd: cmd.cmd, spec: cmd['spec'] as { format?: string } | undefined });
      if (calls.length === 1) await recording;
    };
    const { root } = mount({ result: modal, fieldKey: 'mode:2', panels: { export: true } }, dispatch);
    const rows = [...root.querySelectorAll('.export-row')];
    const animation = rows.find((row) => row.textContent?.includes('Viewer animation'))!;
    const image = rows.find((row) => row.textContent?.includes('Viewer image'))!;
    await act(async () => {
      animation.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
      image.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    });

    root.querySelector<HTMLButtonElement>('.export-foot .apply')!.click();
    await Promise.resolve();
    expect(calls.map((call) => call.spec?.format)).toEqual(['webm']);

    finishRecording();
    await act(async () => {
      await recording;
      await Promise.resolve();
    });
    expect(calls.map((call) => call.spec?.format)).toEqual(['webm', 'png']);
  });
});

describe('the convergence study, through the same chart', () => {
  it('plots the value against the element size and marks where it landed', () => {
    const study = { rows: [{ size: v(100, 'mm'), value: -1.2 }, { size: v(50, 'mm'), value: -1.39 }, { size: v(25, 'mm'), value: -1.42 }], unit: 'mm', observedRate: 2.01 } as StudyReport;
    const root = document.createElement('div');
    document.body.append(root);
    const store = new Store();
    store.set({ ready: true, model: { name: 'm', units: {}, bodies: [], materials: [], sets: [], constraints: [], loads: [], steps: [], warnings: [] } as never, revision: 3, result: RESULT, study, tab: 'results' });
    render(<App store={store} dispatch={async () => undefined} viewer={{ current: null }} query={async () => ({ value: 1, unit: 'Pa' })} />, root);
    const bottom = root.querySelector('.bottom-body')!;
    expect(bottom.textContent).toContain('Mesh convergence');
    expect(bottom.querySelector('.chart line[stroke-dasharray]')).not.toBeNull();
    expect(bottom.textContent).toContain('rate 2.01');
    expect(root.querySelector('.stale-banner')).toBeNull();
    store.set({ result: { ...RESULT, stale: true } });
    render(<App store={store} dispatch={async () => undefined} viewer={{ current: null }} query={async () => ({ value: 1, unit: 'Pa' })} />, root);
    expect(root.querySelector('.stale-banner')?.textContent).toContain('convergence table reports separate study solves');
    expect(root.querySelector('.stale-banner')?.textContent).toContain('does not refresh these stale contours');
    expect(root.querySelector('.stale-banner button')?.getAttribute('data-cmd')).toBe('solve.run');
    store.set({ study: null });
    render(<App store={store} dispatch={async () => undefined} viewer={{ current: null }} query={async () => ({ value: 1, unit: 'Pa' })} />, root);
    expect(root.querySelector('.stale-banner')?.textContent).toContain('Model changed');
    expect(root.querySelector('.stale-banner')?.textContent).not.toContain('convergence table');
  });
});
