import { FemError, type ComparisonPlaybackSpec, type FramesResult } from '@femlab/registry';
import { useEffect, useRef, useState } from 'preact/hooks';
import { formatNumber } from '../fields';
import type { ResultComparison, ComparisonScrubTicket } from '../result-comparison';
import type { Store, UiState } from '../store';
import { Cmd, type Dispatch } from './cmd';
import type { Query } from './SchemaForm';

type Side = 'left' | 'right';
type SharedInput = Extract<ComparisonPlaybackSpec, { mode: 'synchronized' }>;
type Preview = Pick<ResultComparison, 'beginScrub' | 'ownsScrub' | 'previewScrub' | 'cancelScrub'>;
const speeds = (speed: number) => [...new Set([0.1, 0.5, 1, 2, 10, speed])].sort((a, b) => a - b);

/** Retained indices and physical playheads are separate. A gesture previews checked fields
 * locally; exactly its final selection enters the registered host Command stream. */
export function ComparisonPlaybackControls({ s, store, query, dispatch, preview }: { s: UiState; store: Store; query: Query; dispatch: Dispatch; preview?: Preview }) {
  const configuration = s.resultComparison.configuration, state = s.resultComparison.playback;
  const ids = configuration.mode === 'single' ? ['', ''] : [configuration.left.resultId, configuration.right.resultId];
  const [histories, setHistories] = useState<Record<string, FramesResult>>({});
  const [times, setTimes] = useState({ left: '', right: '', common: '' });
  const [policies, setPolicies] = useState({ left: 'exact' as 'exact' | 'nearest', right: 'exact' as 'exact' | 'nearest', common: 'nearest' as 'exact' | 'nearest' });
  const gesture = useRef<{ ticket: ComparisonScrubTicket; input: ComparisonPlaybackSpec } | null>(null);
  useEffect(() => {
    let gone = false;
    void Promise.allSettled([...new Set(ids.filter(Boolean))].map(async resultId => {
      try { return await query({ query: 'query.frames', resultId }) as FramesResult; }
      catch (error) { if (error instanceof FemError && error.code === 'unsupported') return null; throw error; }
    })).then(results => {
      if (gone) return;
      setHistories(Object.fromEntries(results.flatMap(result => result.status === 'fulfilled' && result.value && ids.includes(result.value.resultId) ? [[result.value.resultId, result.value]] : [])));
      setTimes({ left: '', right: '', common: '' });
    });
    return () => { gone = true; };
  }, [ids[0], ids[1], query]);
  useEffect(() => () => { const active = gesture.current; gesture.current = null; if (active) void preview?.cancelScrub(active.ticket).catch(() => undefined); }, [preview]);
  useEffect(() => { if (state?.sampling) setPolicies(previous => ({ ...previous, common: state.sampling! })); }, [state?.sampling]);
  if (configuration.mode === 'single') return null;
  const panes = { left: s.resultComparison.left, right: s.resultComparison.right };
  const frames = (side: Side) => panes[side]?.frames ?? histories[configuration[side].resultId];
  const capable = (side: Side) => frames(side)?.field === configuration[side].field && !panes[side]?.error;
  const mode = state?.mode ?? 'independent', disabled = s.viewMode !== 'results' || s.resultComparison.loading;
  const commonSpeed = state?.left?.speed ?? state?.right?.speed ?? 1;
  const commonPlaying = Boolean(state?.left?.playing || state?.right?.playing);
  const shared = (playing: boolean, time?: SharedInput['time']): SharedInput => ({ mode: 'synchronized', leftResultId: configuration.left.resultId, rightResultId: configuration.right.resultId, playing, speed: commonSpeed, sampling: policies.common, ...(time !== undefined ? { time } : {}) });
  const selection = (side: Side, index: number): ComparisonPlaybackSpec | null => {
    const live = store.state.resultComparison.configuration;
    if (live.mode === 'single') return null;
    const catalogue = frames(side), stamp = catalogue?.frames[index];
    if (!stamp || catalogue.resultId !== live[side].resultId) return null;
    return store.state.resultComparison.playback?.mode === 'synchronized'
      ? { mode: 'synchronized', leftResultId: live.left.resultId, rightResultId: live.right.resultId, playing: false, time: stamp.time, sampling: policies.common }
      : { mode: 'independent', pane: side, resultId: live[side].resultId, playing: false, sample: { kind: 'frame', index } };
  };
  const cancel = () => {
    const active = gesture.current; gesture.current = null;
    if (active) void preview?.cancelScrub(active.ticket).catch(() => undefined);
  };
  const seek = (side: Side | 'common'): ComparisonPlaybackSpec => {
    if (side === 'common') return { ...shared(false), time: times.common || `${state?.playheadSi ?? state?.interval?.startSi ?? 0} s`, sampling: policies.common };
    const sample = panes[side]?.sample?.frame ?? frames(side)?.frames[0];
    return { mode: 'independent', pane: side, resultId: configuration[side].resultId, playing: false, sample: { kind: 'time', time: times[side] || `${sample?.time.value ?? 0} ${sample?.time.unit ?? 's'}`, sampling: policies[side] } };
  };
  const timeForm = (side: Side | 'common') => <form class="comparison-time-seek" onSubmit={event => {
    event.preventDefault(); void dispatch({ cmd: 'view.playComparison', ...seek(side) }).catch(() => undefined);
  }}>
    <input aria-label={`${side} comparison physical time`} data-cmd="view.playComparison" placeholder={side === 'common' ? `${state?.playheadSi ?? 0} s` : `${panes[side]?.sample?.frame.time.value ?? 0} ${panes[side]?.sample?.frame.time.unit ?? 's'}`} value={times[side]} onInput={event => setTimes({ ...times, [side]: event.currentTarget.value })} />
    <select aria-label={`${side} comparison seek policy`} data-cmd="view.playComparison" value={policies[side]} onChange={event => setPolicies({ ...policies, [side]: event.currentTarget.value === 'nearest' ? 'nearest' : 'exact' })}>
      <option value="exact">Exact retained time</option><option value="nearest">Nearest retained time</option>
    </select>
    <Cmd cmd="view.playComparison" dispatch={dispatch} args={seek(side)} disabled={disabled || (side === 'common' ? !capable('left') || !capable('right') : !capable(side))}>Seek</Cmd>
  </form>;
  return <div class="comparison-playback" aria-label="retained comparison playback">
    <label>clocks <select aria-label="comparison playback mode" data-cmd="view.playComparison" value={mode} disabled={disabled || !capable('left') || !capable('right')} onChange={event => {
      const input: ComparisonPlaybackSpec = event.currentTarget.value === 'synchronized' ? shared(false)
        : { mode: 'independent', pane: 'left', resultId: configuration.left.resultId, playing: false };
      void dispatch({ cmd: 'view.playComparison', ...input }).catch(() => undefined);
    }}><option value="independent">Independent clocks</option><option value="synchronized">Shared physical playhead</option></select></label>
    {mode === 'synchronized' ? <div class="comparison-shared-clock">
      <Cmd cmd="view.playComparison" dispatch={dispatch} args={shared(!commonPlaying)} disabled={disabled || !capable('left') || !capable('right')} pressed={commonPlaying}>{commonPlaying ? 'Pause both' : 'Play both'}</Cmd>
      <label>speed <select aria-label="shared comparison playback speed" data-cmd="view.playComparison" value={commonSpeed} disabled={disabled} onChange={event => {
        void dispatch({ cmd: 'view.playComparison', ...shared(commonPlaying), speed: Number(event.currentTarget.value) }).catch(() => undefined);
      }}>{speeds(commonSpeed).map(speed => <option value={speed}>{speed} s/s</option>)}</select></label>
      <output aria-label="shared physical playhead">playhead {formatNumber(state?.playheadSi ?? 0)} s · actual retained times are shown in each pane</output>
      {timeForm('common')}
      {state?.interval ? <span>Shared interval {formatNumber(state.interval.startSi)}–{formatNumber(state.interval.endSi)} s. Playback stops at the shorter endpoint; independent clocks can explore the longer remainder.</span> : null}
    </div> : null}
    <div class="comparison-frame-controls">
      {(['left', 'right'] as const).map(side => {
        const catalogue = frames(side), pane = panes[side], run = state?.[side], speed = run?.speed ?? 1;
        const sample = pane?.sample?.frame ?? catalogue?.frames.at(-1);
        if (!catalogue) return <span>{side}: no retained primary History</span>;
        if (!capable(side)) return <span>{side}: History retains only {catalogue.field}; select that primary field for playback.</span>;
        return <fieldset><legend>{side} · {configuration[side].resultId}</legend>
          {mode === 'independent' ? <>
            <Cmd cmd="view.playComparison" dispatch={dispatch} args={{ mode: 'independent', pane: side, resultId: configuration[side].resultId, playing: !run?.playing }} disabled={disabled} pressed={Boolean(run?.playing)}>{run?.playing ? `Pause ${side}` : `Play ${side}`}</Cmd>
            <label>speed <select aria-label={`${side} comparison playback speed`} data-cmd="view.playComparison" value={speed} disabled={disabled} onChange={event => {
              void dispatch({ cmd: 'view.playComparison', mode: 'independent', pane: side, resultId: configuration[side].resultId, playing: Boolean(run?.playing), speed: Number(event.currentTarget.value) }).catch(() => undefined);
            }}>{speeds(speed).map(value => <option value={value}>{value} s/s</option>)}</select></label>
          </> : null}
          <input type="range" min={0} max={catalogue.frames.length - 1} step={1} value={sample?.index ?? 0} disabled={disabled || !preview}
            aria-label={`${side} comparison frame scrub`} aria-valuetext={`${sample?.time.value ?? 0} ${sample?.time.unit ?? 's'}`} data-cmd="view.playComparison"
            onInput={event => {
              const input = selection(side, Number(event.currentTarget.value)); if (!input || !preview) return;
              gesture.current ??= { ticket: preview.beginScrub(mode === 'synchronized' ? 'synchronized' : side), input };
              gesture.current.input = input;
              if (preview.ownsScrub(gesture.current.ticket)) void preview.previewScrub(gesture.current.ticket, input).catch(() => undefined);
            }}
            onChange={() => {
              const active = gesture.current; gesture.current = null;
              if (!active || !preview?.ownsScrub(active.ticket)) return;
              // A pause/preview render can reset the controlled range before native
              // change. The last input receipt is the actual user selection.
              void dispatch({ cmd: 'view.playComparison', ...active.input }).catch(() => undefined);
            }}
            onPointerCancel={cancel} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); } }} />
          <output aria-label={`${side} actual retained comparison time`}>frame {sample?.index ?? 0} · {formatNumber(sample?.time.value ?? 0)} {sample?.time.unit ?? 's'}</output>
          {mode === 'independent' ? timeForm(side) : null}
        </fieldset>;
      })}
    </div>
  </div>;
}
