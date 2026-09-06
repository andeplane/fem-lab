import { useRef } from 'preact/hooks';
import { formatNumber } from '../fields';
import type { ViewerRef } from '../host';
import type { Store, UiState } from '../store';
import type { TransientInput } from '../transient';
import { Cmd, type Dispatch } from './cmd';

/** Preview a scrub freely; only its final value enters the callable host command stream. */
export function TransientControls({ s, store, dispatch, viewer }: { s: UiState; store: Store; dispatch: Dispatch; viewer: ViewerRef }) {
  const state = s.transient;
  const step = s.result?.step ?? '';
  const start = useRef<TransientInput | null>(null);
  const target = `${step}:${state?.generation ?? -1}`;
  const previousTarget = useRef(target);
  if (target !== previousTarget.current) {
    previousTarget.current = target;
    start.current = null;
  }
  const cancel = (): void => {
    const restore = start.current;
    start.current = null;
    if (restore) void viewer.previewTransient?.(restore).catch(() => undefined);
  };
  const disabled = s.result?.stale === true;
  return <>
    <Cmd dispatch={dispatch} cmd="view.playTransient" class="tbutton" disabled={disabled}
      args={{ step, playing: !state?.playing }} pressed={state?.playing ?? false}
      title={state?.playing ? 'pause transient playback' : 'play retained transient frames'}>
      {state?.playing ? '❚❚' : '▶'}
    </Cmd>
    {state ? <>
      <input type="range" class="phase" min="0" max={state.catalogue.frames.length - 1} step="1"
        aria-label="retained transient frame" data-cmd="view.playTransient" disabled={disabled}
        aria-valuetext={`${formatNumber(state.frame.time.value)} ${state.frame.time.unit}`}
        value={state.frame.index}
        onInput={(event) => {
          const current = store.state.transient;
          if (!current) return;
          start.current ??= { step, playing: current.playing, speed: current.speed, sample: { kind: 'frame', index: current.frame.index } };
          const index = Number(event.currentTarget.value);
          void viewer.previewTransient?.({ step, playing: false, sample: { kind: 'frame', index } }).catch(() => undefined);
        }}
        onChange={(event) => {
          if (!start.current) return;
          const restore = start.current;
          start.current = null;
          const index = Number(event.currentTarget.value);
          void dispatch({ cmd: 'view.playTransient', step, playing: false, sample: { kind: 'frame', index } }).catch(() => {
            if (previousTarget.current === target) void viewer.previewTransient?.(restore).catch(() => undefined);
          });
        }}
        onPointerCancel={cancel}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); } }} />
      <output class="mono transient-time" aria-label="displayed transient time">{formatNumber(state.frame.time.value)} {state.frame.time.unit}</output>
      <label class="transient-speed">speed <select aria-label="transient playback speed" data-cmd="view.playTransient"
        value={state.speed} onChange={(event) => {
          void dispatch({ cmd: 'view.playTransient', step, playing: state.playing, speed: Number(event.currentTarget.value) }).catch(() => undefined);
        }}>
        {[...new Set([0.1, 0.5, 1, 2, 10, state.speed])].sort((a, b) => a - b).map((speed) => <option key={speed} value={speed}>{speed} s/s</option>)}
      </select></label>
    </> : null}
  </>;
}
