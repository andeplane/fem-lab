import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import type { ComparisonPaneState, ComparisonPlaybackState, FramesResult } from '@femlab/registry';
import { RESULT } from '../../registry/test/fakes';
import type { ComparisonScrubTicket, ResultComparison } from '../src/result-comparison';
import { ComparisonPlaybackControls } from '../src/ui/ComparisonPlayback';
import { useStore } from '../src/ui/cmd';
import type { Query } from '../src/ui/SchemaForm';
import { Store } from '../src/store';
import { afterEffects, waitFor } from './wait-for';

afterEach(async () => { await act(async () => { for (const root of [...document.body.children]) render(null, root); }); document.body.replaceChildren(); });
function setup(synchronized = false) {
  const store = new Store(), root = document.createElement('div'); document.body.append(root);
  const catalogue = (id: string): FramesResult => ({ resultId: id, step: 'heat', modelHash: id, stale: id === 'left', field: 'temperature', nodeCount: 1, components: 3, storedComponents: 1, retainedBytes: 64,
    frames: (id === 'left' ? [0, 0.2, 0.7, 0.9] : [0, 0.3, 0.6, 1.2]).map((timeSi, index) => ({ index, timeSi, time: { value: timeSi * 1000, unit: 'ms' } })) });
  const pane = (id: string): ComparisonPaneState => ({ operand: { resultId: id, field: 'temperature', component: 0, sample: { kind: 'frame', index: 1 } }, summary: { ...RESULT, resultId: id }, label: 'T', legend: null, bodyNames: [], hiddenBodies: [], canDeform: false, frames: catalogue(id),
    sample: { resultId: id, step: 'heat', modelHash: id, frame: catalogue(id).frames[1]! }, pick: null, error: null });
  const left = pane('left'), right = pane('right');
  const playback: ComparisonPlaybackState = { mode: synchronized ? 'synchronized' : 'independent',
    left: { resultId: 'left', sample: left.sample!, playing: false, speed: 1, playheadSi: 0.45 }, right: { resultId: 'right', sample: right.sample!, playing: false, speed: 1, playheadSi: 0.45 },
    playheadSi: synchronized ? 0.45 : null, interval: synchronized ? { startSi: 0, endSi: 0.9 } : null, sampling: synchronized ? 'nearest' : null };
  store.set({ viewMode: 'results', resultComparison: { ...store.state.resultComparison, configuration: { mode: 'sideBySide', left: left.operand, right: right.operand }, left, right, playback } });
  const dispatch = vi.fn(async () => undefined), query: Query = vi.fn(async input => catalogue(String(input['resultId'])));
  const ticket: ComparisonScrubTicket = { id: 1 };
  let owned = true;
  const preview = { beginScrub: vi.fn<ResultComparison['beginScrub']>(() => ticket), ownsScrub: vi.fn<ResultComparison['ownsScrub']>(() => owned), previewScrub: vi.fn<ResultComparison['previewScrub']>(async () => undefined), cancelScrub: vi.fn<ResultComparison['cancelScrub']>(async () => undefined) } satisfies Pick<ResultComparison, 'beginScrub' | 'ownsScrub' | 'previewScrub' | 'cancelScrub'>;
  const Harness = () => <ComparisonPlaybackControls s={useStore(store)} store={store} dispatch={dispatch} query={query} preview={preview} />;
  const mount = async () => { await act(async () => render(<Harness />, root)); await afterEffects(); };
  const select = async (label: string, value: string) => {
    await act(async () => { const element = root.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!; element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); });
  };
  return { store, root, dispatch, query, preview, ticket, mount, select, retire: () => { owned = false; } };
}

it('routes independent play/pause/speed and unit-bearing time seeks to the current explicit Result identity', async () => {
  const s = setup(); await s.mount();
  await waitFor(() => s.root.querySelector('[aria-label="left comparison frame scrub"]') !== null);
  [...s.root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Play right')!.click();
  expect(s.dispatch).toHaveBeenLastCalledWith({ cmd: 'view.playComparison', mode: 'independent', pane: 'right', resultId: 'right', playing: true });
  await s.select('left comparison playback speed', '2');
  expect(s.dispatch).toHaveBeenLastCalledWith({ cmd: 'view.playComparison', mode: 'independent', pane: 'left', resultId: 'left', playing: false, speed: 2 });
  const time = s.root.querySelector<HTMLInputElement>('[aria-label="right comparison physical time"]')!;
  await act(async () => { time.value = '650 ms'; time.dispatchEvent(new Event('input', { bubbles: true })); });
  await s.select('right comparison seek policy', 'nearest');
  time.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  expect(s.dispatch).toHaveBeenLastCalledWith({ cmd: 'view.playComparison', mode: 'independent', pane: 'right', resultId: 'right', playing: false, sample: { kind: 'time', time: '650 ms', sampling: 'nearest' } });
});

it('keeps shared playhead and unequal actual held timestamps visible, and maps a pane index to physical time', async () => {
  const s = setup(true); await s.mount();
  expect(s.root.querySelector('[aria-label="shared physical playhead"]')?.textContent).toContain('0.45 s');
  expect(s.root.querySelector('[aria-label="left actual retained comparison time"]')?.textContent).toContain('200 ms');
  expect(s.root.querySelector('[aria-label="right actual retained comparison time"]')?.textContent).toContain('300 ms');
  expect(s.root.textContent).toContain('shorter endpoint'); expect(s.root.textContent).toContain('longer remainder');
  const slider = s.root.querySelector<HTMLInputElement>('[aria-label="right comparison frame scrub"]')!;
  await act(async () => { slider.value = '2'; slider.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(s.preview.beginScrub).toHaveBeenCalledWith('synchronized');
  expect(s.preview.previewScrub).toHaveBeenLastCalledWith(s.ticket, { mode: 'synchronized', leftResultId: 'left', rightResultId: 'right', playing: false, time: { value: 600, unit: 'ms' }, sampling: 'nearest' });
  expect(s.dispatch).not.toHaveBeenCalled();
  slider.dispatchEvent(new Event('change', { bubbles: true }));
  expect(s.dispatch).toHaveBeenCalledTimes(1);
  expect(s.dispatch).toHaveBeenLastCalledWith({ cmd: 'view.playComparison', mode: 'synchronized', leftResultId: 'left', rightResultId: 'right', playing: false, time: { value: 600, unit: 'ms' }, sampling: 'nearest' });
});

it('previews repeated range input but emits only its final Command, and cancels Escape/pointer gestures without dispatch', async () => {
  for (const cancel of ['Escape', 'pointercancel', 'commit'] as const) {
    const s = setup(); await s.mount();
    const slider = s.root.querySelector<HTMLInputElement>('[aria-label="left comparison frame scrub"]')!;
    await act(async () => { for (const index of ['2', '3']) { slider.value = index; slider.dispatchEvent(new Event('input', { bubbles: true })); } });
    expect(s.preview.beginScrub).toHaveBeenCalledTimes(1); expect(s.preview.previewScrub).toHaveBeenCalledTimes(2); expect(s.dispatch).not.toHaveBeenCalled();
    if (cancel === 'Escape') slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    else {
      // The captured pause receipt can rerender a controlled range before Chromium's
      // native change event. Commit the final user input, not this older DOM value.
      if (cancel === 'commit') slider.value = '1';
      slider.dispatchEvent(new Event(cancel === 'commit' ? 'change' : cancel, { bubbles: true }));
    }
    if (cancel === 'commit') expect(s.dispatch).toHaveBeenCalledExactlyOnceWith({ cmd: 'view.playComparison', mode: 'independent', pane: 'left', resultId: 'left', playing: false, sample: { kind: 'frame', index: 3 } });
    else { expect(s.dispatch).not.toHaveBeenCalled(); expect(s.preview.cancelScrub).toHaveBeenCalledExactlyOnceWith(s.ticket); }
    await act(async () => render(null, s.root)); s.root.remove();
  }
});

it('drops a retired gesture final value and disables playback outside Results or for a final derived field', async () => {
  const s = setup(); await s.mount();
  const slider = s.root.querySelector<HTMLInputElement>('[aria-label="left comparison frame scrub"]')!;
  await act(async () => { slider.value = '2'; slider.dispatchEvent(new Event('input', { bubbles: true })); });
  s.retire(); slider.dispatchEvent(new Event('change', { bubbles: true })); expect(s.dispatch).not.toHaveBeenCalled();
  await act(async () => s.store.set({ viewMode: 'mesh' }));
  expect(s.root.querySelector<HTMLInputElement>('[aria-label="left comparison frame scrub"]')?.disabled).toBe(true);
  const configuration = s.store.state.resultComparison.configuration;
  if (configuration.mode === 'single') throw new Error('fixture requires two panes');
  await act(async () => s.store.set({ viewMode: 'results', resultComparison: { ...s.store.state.resultComparison, configuration: { ...configuration, left: { resultId: 'left', field: 'heatFlux', component: 0 } } } }));
  expect(s.root.textContent).toContain('History retains only temperature');
  expect(s.root.querySelector('[aria-label="left comparison frame scrub"]')).toBeNull();
  expect(s.root.querySelector('[aria-label="right comparison frame scrub"]')).not.toBeNull();
});
