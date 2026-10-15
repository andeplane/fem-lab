import { FemError, type ComparisonConfiguration, type ComparisonOperandInput, type ComparisonPaneName, type ComparisonPaneState, type FramesResult, type ResultSummary } from '@femlab/registry';
import { useEffect, useState } from 'preact/hooks';
import { fieldChoices, formatNumber, legendTicks, type FieldChoice } from '../fields';
import type { UiState } from '../store';
import { COLORMAPS, cssGradient } from '../viewer/colormap';
import { Cmd, type Dispatch } from './cmd';
import type { Query } from './SchemaForm';

function operandChoice(choice: FieldChoice, resultId: string, sample?: ComparisonOperandInput['sample']): ComparisonOperandInput {
  return { resultId, field: choice.field, ...(choice.component == null ? {} : { component: choice.component }), ...(sample ? { sample } : {}) };
}
function sameChoice(choice: FieldChoice, operand: ComparisonOperandInput): boolean {
  return choice.field === operand.field && (choice.component ?? undefined) === operand.component;
}
/** Draft form values become one explicit comparison Command, never implicit newest solves. */
export function ComparisonControls({ s, dispatch, query }: { s: UiState; dispatch: Dispatch; query: Query }) {
  const state = s.resultComparison, records = state.catalogue.records;
  const configuration = state.configuration;
  const [mode, setMode] = useState<'sideBySide' | 'difference'>('sideBySide');
  const [onto, setOnto] = useState<'left' | 'right'>('left');
  const [left, setLeft] = useState<ComparisonOperandInput>({ resultId: '', field: '' });
  const [right, setRight] = useState<ComparisonOperandInput>({ resultId: '', field: '' });
  const [summaries, setSummaries] = useState<Record<string, ResultSummary>>({});
  const [histories, setHistories] = useState<Record<string, FramesResult | null>>({});
  const [fieldsLoading, setFieldsLoading] = useState(false);
  useEffect(() => {
    if (configuration.mode !== 'single') {
      setMode(configuration.mode); setLeft(configuration.left); setRight(configuration.right);
      if (configuration.mode === 'difference') setOnto(configuration.onto);
    } else {
      setLeft(previous => previous.resultId ? previous : { resultId: records[0]?.id ?? '', field: '' });
      setRight(previous => previous.resultId ? previous : { resultId: records.at(-1)?.id ?? '', field: '' });
    }
  }, [configuration, records]);
  useEffect(() => {
    let gone = false;
    const ids = [...new Set([left.resultId, right.resultId].filter(Boolean))];
    setFieldsLoading(ids.length > 0);
    void Promise.allSettled(ids.map(async resultId => {
      const [summary, frames] = await Promise.all([query({ query: 'query.result', resultId }) as Promise<ResultSummary>,
        (query({ query: 'query.frames', resultId }) as Promise<FramesResult>).catch(error => {
          if (error instanceof FemError && error.code === 'unsupported') return null;
          throw error;
        })]);
      return [resultId, summary, frames] as const;
    }))
      .then(results => {
        if (gone) return;
        setSummaries(Object.fromEntries(results.flatMap(result => result.status === 'fulfilled' && result.value[0] === result.value[1].resultId ? [[result.value[0], result.value[1]]] : [])));
        setHistories(Object.fromEntries(results.flatMap(result => result.status === 'fulfilled' && result.value[0] === result.value[1].resultId ? [[result.value[0], result.value[2]]] : [])));
        setFieldsLoading(false);
      });
    return () => { gone = true; };
  }, [left.resultId, right.resultId, query]);
  const choices = (operand: ComparisonOperandInput): FieldChoice[] => {
    const summary = summaries[operand.resultId];
    // Derived safety fields require solved Material metadata; only retained engine fields enter comparison.
    return summary ? fieldChoices(operand.sample ? histories[operand.resultId] ? [histories[operand.resultId]!.field] : [] : summary.extremes.map(e => e.field), summary) : [];
  };
  const resolve = (operand: ComparisonOperandInput): ComparisonOperandInput | null => {
    const available = choices(operand);
    const choice = available.find(c => sameChoice(c, operand)) ?? available[0];
    return choice ? operandChoice(choice, operand.resultId, operand.sample) : null;
  };
  const a = resolve(left), b = resolve(right);
  const input: ComparisonConfiguration | null = a && b ? mode === 'difference' ? { mode, left: a, right: b, onto } : { mode, left: a, right: b } : null;
  // Keep this strip mounted before the first solve: filling the retained catalogue must
  // not move or resize the single-Result canvas and invalidate its framing and picks.
  const operandForm = (side: 'left' | 'right', operand: ComparisonOperandInput, set: (next: ComparisonOperandInput) => void) => {
    const options = choices(operand), selected = resolve(operand), frames = histories[operand.resultId];
    return <fieldset>
      <legend>{side}</legend>
      <select aria-label={`${side} Result`} data-cmd="view.compareResults" value={operand.resultId} onChange={e => set({ resultId: e.currentTarget.value, field: '' })}>
        {!records.some(r => r.id === operand.resultId) ? <option value={operand.resultId}>{operand.resultId || 'Select Result'}</option> : null}
        {records.map(record => <option key={record.id} value={record.id}>{record.step} · rev {record.solvedRevision} · {record.id} · {record.stale ? 'stale' : 'current'}</option>)}
      </select>
      <select aria-label={`${side} field`} data-cmd="view.compareResults" value={options.find(c => selected && sameChoice(c, selected))?.key ?? ''} onChange={e => {
        const choice = options.find(c => c.key === e.currentTarget.value); if (choice) set(operandChoice(choice, operand.resultId, operand.sample));
      }}>
        {!options.length ? <option value="">{fieldsLoading ? 'Loading fields…' : 'No available fields'}</option> : null}
        {options.map(choice => <option key={choice.key} value={choice.key}>{choice.label}</option>)}
      </select>
      <select aria-label={`${side} sample selection`} data-cmd="view.compareResults" value={operand.sample?.kind ?? 'final'} onChange={e => {
        const kind = e.currentTarget.value;
        if (kind === 'final') { set({ ...operand, sample: undefined }); return; }
        if (!frames) return;
        const primary = fieldChoices([frames.field], summaries[operand.resultId])[0];
        if (!primary) return;
        set(operandChoice(primary, operand.resultId, kind === 'frame' ? { kind, index: 0 } : { kind: 'time', time: `${frames.frames[0]!.time.value} ${frames.frames[0]!.time.unit}`, sampling: 'exact' }));
      }}>
        <option value="final">Final field</option>
        {frames ? <><option value="frame">Retained index</option><option value="time">Physical time</option></> : null}
      </select>
      {operand.sample?.kind === 'frame' && frames ? <select aria-label={`${side} retained frame`} data-cmd="view.compareResults" value={operand.sample.index} onChange={e => set({ ...operand, sample: { kind: 'frame', index: Number(e.currentTarget.value) } })}>
        {frames.frames.map(frame => <option key={frame.index} value={frame.index}>{frame.index} · {formatNumber(frame.time.value)} {frame.time.unit}</option>)}
      </select> : null}
      {operand.sample?.kind === 'time' ? <>
        <input aria-label={`${side} physical time`} data-cmd="view.compareResults" value={typeof operand.sample.time === 'string' ? operand.sample.time : `${operand.sample.time.value} ${operand.sample.time.unit}`} onInput={e => set({ ...operand, sample: { kind: 'time', time: e.currentTarget.value, sampling: operand.sample?.kind === 'time' ? operand.sample.sampling : 'exact' } })} />
        <select aria-label={`${side} time sampling`} data-cmd="view.compareResults" value={operand.sample.sampling} onChange={e => {
          if (operand.sample?.kind === 'time') set({ ...operand, sample: { ...operand.sample, sampling: e.currentTarget.value === 'nearest' ? 'nearest' : 'exact' } });
        }}><option value="exact">Exact retained time</option><option value="nearest">Nearest retained time</option></select>
      </> : null}
    </fieldset>;
  };
  return <div class="comparison-controls" aria-label="Result comparison workspace">
    <div class="comparison-actions">
      <strong>Compare Results</strong>
      <select aria-label="comparison presentation" data-cmd="view.compareResults" value={mode} onChange={e => setMode(e.currentTarget.value as typeof mode)}>
        <option value="sideBySide">Side by side</option><option value="difference">Left − right</option>
      </select>
      {mode === 'difference' ? <label>onto <select aria-label="difference target mesh" data-cmd="view.compareResults" value={onto} onChange={e => setOnto(e.currentTarget.value as typeof onto)}><option value="left">Left mesh</option><option value="right">Right mesh</option></select></label> : null}
      <Cmd cmd="view.compareResults" dispatch={dispatch} args={input ?? { mode: 'single' }} disabled={!input || state.loading} class="apply">{state.loading ? 'Loading…' : 'Compare'}</Cmd>
      <Cmd cmd="view.compareResults" dispatch={dispatch} args={{ mode: 'single' }} pressed={configuration.mode === 'single'}>Single Result</Cmd>
    </div>
    <div class="comparison-operands">{operandForm('left', left, setLeft)}{operandForm('right', right, setRight)}</div>
    {state.error ? <div class="comparison-error" role="alert">{state.error.code} · {state.error.cause}{state.error.suggestion ? ` · ${state.error.suggestion}` : ''}</div> : null}
    {configuration.mode !== 'single' && s.viewMode !== 'results' ? <p>Comparison is pinned. Geometry and Mesh show the current Model; return to Results to resume.</p> : null}
  </div>;
}

export function ComparisonPaneChrome({ pane, name, s, dispatch }: { pane: ComparisonPaneState; name: ComparisonPaneName; s: UiState; dispatch: Dispatch }) {
  const legend = pane.legend;
  const [lower, setLower] = useState(''), [upper, setUpper] = useState('');
  useEffect(() => { setLower(String(legend?.min.value ?? '')); setUpper(String(legend?.max.value ?? '')); }, [legend]);
  const target = { pane: name, resultId: pane.operand.resultId };
  const record = s.resultComparison.catalogue.records.find(r => r.id === pane.operand.resultId);
  return <>
    <div class={`comparison-pane-title ${pane.summary.stale ? 'stale' : ''}`}>
      <strong>{name === 'difference' ? 'Left − right' : name} · {pane.summary.step}</strong>
      <span class="mono">{pane.operand.resultId}</span>
      {pane.sample ? <span>frame {pane.sample.frame.index} · {formatNumber(pane.sample.frame.time.value)} {pane.sample.frame.time.unit}</span> : <span>final field</span>}
      {name === 'difference' ? <span>left {s.resultComparison.left?.sample ? `${s.resultComparison.left.sample.frame.index} · ${formatNumber(s.resultComparison.left.sample.frame.time.value)} ${s.resultComparison.left.sample.frame.time.unit}` : 'final'} · right {s.resultComparison.right?.sample ? `${s.resultComparison.right.sample.frame.index} · ${formatNumber(s.resultComparison.right.sample.frame.time.value)} ${s.resultComparison.right.sample.frame.time.unit}` : 'final'}</span> : null}
      <span>{record?.modelName ?? ''} · rev {pane.summary.revision} · {pane.summary.stale ? 'stale' : 'current'}</span>
      {record ? <span class="comparison-mesh">Mesh · nodes {record.nodes} · elements {record.elements}</span> : null}
      {name === 'difference' && s.resultComparison.coverage ? <span>onto {pane.operand.resultId} · {s.resultComparison.coverage.insideNodes}/{s.resultComparison.coverage.totalNodes} nodes covered{s.resultComparison.interpolated ? ' · interpolated' : ''}</span> : null}
      {pane.error ? <span role="alert">{pane.error.code} · {pane.error.cause}</span> : null}
    </div>
    <div class="comparison-body-controls" aria-label={`${name} retained bodies`}>
      {pane.bodyNames.map(body => <Cmd key={body} cmd="view.setComparisonVisible" dispatch={dispatch} args={{ ...target, bodies: [body], on: pane.hiddenBodies.includes(body) }} pressed={!pane.hiddenBodies.includes(body)} title={`Toggle ${body} in ${name} Result ${pane.operand.resultId}`}>{body}</Cmd>)}
    </div>
    {!pane.error ? <div class="comparison-legend" aria-label={`${name} legend`}>
      <strong>{pane.label}</strong><span>{legend?.difference ? 'Δ ' : ''}{legend?.min.unit ?? ''}</span>
      {legend ? <>
        <div class="comparison-gradient" style={`background:${cssGradient(legend.colormap)}`} />
        <div class="comparison-ticks">{legendTicks(legend.min.value, legend.max.value, 3).map(tick => <span>{tick}</span>)}</div>
        <div class="comparison-colormaps">{COLORMAPS.map(colormap => <Cmd key={colormap} cmd="view.setComparisonLegend" dispatch={dispatch} args={{ ...target, colormap }} pressed={legend.colormap === colormap} title={colormap}><i style={`background:${cssGradient(colormap)}`} /></Cmd>)}</div>
        <form onSubmit={e => { e.preventDefault(); if (Number.isFinite(Number(lower)) && Number.isFinite(Number(upper))) void dispatch({ cmd: 'view.setComparisonLegend', ...target, range: [{ value: Number(lower), unit: legend.min.unit }, { value: Number(upper), unit: legend.max.unit }] }).catch(() => undefined); }}>
          <input aria-label={`${name} legend minimum`} data-cmd="view.setComparisonLegend" type="number" step="any" value={lower} onInput={e => setLower(e.currentTarget.value)} />
          <input aria-label={`${name} legend maximum`} data-cmd="view.setComparisonLegend" type="number" step="any" value={upper} onInput={e => setUpper(e.currentTarget.value)} />
          <Cmd cmd="view.setComparisonLegend" dispatch={dispatch} args={{ ...target, range: [{ value: Number(lower), unit: legend.min.unit }, { value: Number(upper), unit: legend.max.unit }] }} disabled={!lower || !upper || !Number.isFinite(Number(lower)) || !Number.isFinite(Number(upper))}>Clamp</Cmd>
        </form>
      </> : <span>No covered data · neutral surface</span>}
      <Cmd cmd="view.setComparisonLegend" dispatch={dispatch} args={{ ...target, range: 'auto' }} pressed={legend?.automatic}>Auto</Cmd>
    </div> : null}
    {pane.pick ? <div class="probe mono">{pane.operand.resultId} · node {pane.pick.node} · {pane.pick.value ? `${formatNumber(pane.pick.value.value)} ${pane.pick.difference ? 'Δ ' : ''}${pane.pick.value.unit}` : 'unavailable coverage'}{pane.sample ? ` · frame ${pane.sample.frame.index} · ${formatNumber(pane.sample.frame.time.value)} ${pane.sample.frame.time.unit}` : ''}</div> : null}
    {name === 'difference' && s.resultComparison.warnings.length ? <div class="comparison-warnings" role="status">{s.resultComparison.warnings.map(w => <span>{w.code} · {w.text}</span>)}</div> : null}
  </>;
}
