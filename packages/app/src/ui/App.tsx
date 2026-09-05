// The shell of docs/design/README.md: top bar, blocker banner, Model tree, viewer, Properties,
// bottom panel, and the three overlays. Rule (ADR 0003): everything a person can click dispatches
// one registry Command and carries its name in `data-cmd`, so `test/data-cmd.test.tsx` and the
// Playwright smoke can hold the DOM against `registry.list()`.
import type { CommandDef, EngineSchema, JsonSchema, Registry } from '@femlab/registry';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import schema from '../../../registry/src/generated/engine.schema.json';
import { AssistantPanel } from '../ai';
import { engineChip } from '../capabilities';
import { fieldChoices, formatNumber, legendTicks } from '../fields';
import type { ViewerRef } from '../host';
import { solveLabel, stageOf, type Store, type UiState } from '../store';
import { COLORMAPS, cssGradient } from '../viewer/colormap';
import { Viewer } from '../viewer/viewer';
import { Bottom } from './Bottom';
import { ExportModal } from './Export';
import { Examples, Palette, Start } from './Overlays';
import { Tour, TutorialPanel } from '../tutorial';
import { SchemaForm, type Query } from './SchemaForm';
import { ModelTree } from './Tree';
import { Cmd, useStore, type Dispatch } from './cmd';
import { blockers, type Defs } from './schema';

export type { Dispatch } from './cmd';

export interface AppProps {
  store: Store;
  dispatch: Dispatch;
  viewer: ViewerRef;
  /** Reads for the live parts of the form (`query.convert`); defaults to a no-op for tests. */
  query?: Query;
  /** `registry.list().commands`, which is what the ⌘K palette is a view of. */
  commands?: CommandDef[];
  /**
   * The Assistant and the tutorial runner dispatch through whatever Registry they are handed;
   * `main.tsx` hands them the app's own wrapped `dispatch`, so a tool call and a "do it for me"
   * repaint the viewer exactly like a click does.
   */
  registry?: Registry;
}

const doc = schema as unknown as EngineSchema;
const DEFS: Defs = { ...doc.commands.$defs, ...doc.queries.$defs };
const VARIANTS = new Map<string, JsonSchema>(doc.commands.oneOf.map((v) => [v.properties['cmd']!.const!, v as unknown as JsonSchema]));

const MM = { length: 'mm', force: 'N', stress: 'MPa' };
const SI = { length: 'm', force: 'N', stress: 'Pa' };

function TopBar({ s, dispatch }: { s: UiState; dispatch: Dispatch }) {
  const list = blockers(s.model?.warnings ?? [], Boolean(s.model?.meshSettings), (s.model?.bodies.length ?? 0) > 0);
  const step = s.model?.steps[0]?.name ?? '';
  const reason = !s.ready ? 'the engine is still loading' : list[0] ? `${list[0].code} ${list[0].text}` : '';
  const mm = s.model?.units.length === 'mm';
  const stage = stageOf(s);
  return (
    <header class="topbar">
      <div class="logo">
        <i /> FEM Lab
      </div>
      <span class="mono model-name">{s.model?.name ?? 'no model'}</span>
      <Cmd dispatch={dispatch} cmd="panel.toggle" class="palette-field" args={{ panel: 'palette', open: true }} title="Search commands (⌘K)">
        <span>Search commands or ask in plain words</span>
        <span class="key">⌘K</span>
      </Cmd>
      <span class="spacer" />
      <div class="segmented" role="group" aria-label="display units">
        <Cmd dispatch={dispatch} cmd="model.setUnits" args={{ units: MM }} pressed={mm} title="mm N MPa">
          mm N MPa
        </Cmd>
        <Cmd dispatch={dispatch} cmd="model.setUnits" args={{ units: SI }} pressed={!mm} title="m N Pa">
          m N Pa
        </Cmd>
      </div>
      <Cmd dispatch={dispatch} cmd="journal.undo" class="tbutton" args={{ steps: 1 }} disabled={!s.journal?.canUndo} title="journal.undo (⌘Z)">
        ↶
      </Cmd>
      <Cmd dispatch={dispatch} cmd="journal.redo" class="tbutton" args={{ steps: 1 }} disabled={!s.journal?.canRedo} title="journal.redo (⇧⌘Z)">
        ↷
      </Cmd>
      <span class="chip" title={s.notes.join('\n') || 'everything available'}>
        <span class={s.notes.length > 0 ? 'dot warn' : 'dot'} />
        {s.hostCaps ? engineChip(s.hostCaps, s.engineCaps) : 'starting…'}
      </span>
      <Cmd dispatch={dispatch} cmd="solve.run" class={`solve ${stage}`} args={{ step }} disabled={reason !== '' || step === '' || stage === 'solving'} title={reason || `solve.run ${step}`}>
        {solveLabel(stage, s)}
      </Cmd>
      <Cmd dispatch={dispatch} cmd="panel.toggle" class="tbutton" args={{ panel: 'examples' }}>
        Examples
      </Cmd>
      <Cmd dispatch={dispatch} cmd="file.open" class="tbutton" args={{ picker: true }} title="Open a femlab/1 file">
        Open
      </Cmd>
      <Cmd dispatch={dispatch} cmd="file.save" class="tbutton" title="Save the Model and its Journal">
        Save
      </Cmd>
      <Cmd dispatch={dispatch} cmd="file.shareLink" class="tbutton" title="A URL that reopens this Model (not built yet)">
        Share
      </Cmd>
      <Cmd dispatch={dispatch} cmd="panel.toggle" class="tbutton" args={{ panel: 'export' }}>
        Export
      </Cmd>
      <Cmd dispatch={dispatch} cmd="panel.toggle" class="tbutton" args={{ panel: 'report' }}>
        Report
      </Cmd>
      <Cmd dispatch={dispatch} cmd="panel.toggle" class="tbutton" args={{ panel: 'tutorial' }} pressed={s.panels['tutorial'] === true} title="Guided tutorials">
        Tutorials
      </Cmd>
      <Cmd dispatch={dispatch} cmd="panel.toggle" class="tbutton outline" args={{ panel: 'assistant' }} pressed={s.panels['assistant'] === true}>
        ✳ Assistant
      </Cmd>
    </header>
  );
}

/** The design's 32 px blocker strip: W-code chip, plain-language cause, one mono fix Command. */
function Banner({ s, dispatch }: { s: UiState; dispatch: Dispatch }) {
  if (s.lastError) {
    return (
      <div class="banner error" role="alert">
        <span class="mono code">{s.lastError.code}</span>
        <span>{s.lastError.cause}</span>
        {s.lastError.suggestion ? <span class="suggestion">{s.lastError.suggestion}</span> : null}
      </div>
    );
  }
  const b = blockers(s.model?.warnings ?? [], Boolean(s.model?.meshSettings), (s.model?.bodies.length ?? 0) > 0)[0];
  if (!b) return null;
  return (
    <div class="banner">
      <span class="mono code">{b.code}</span>
      <span>{b.text}</span>
      {b.fixCmd ? (
        <Cmd dispatch={dispatch} cmd="form.open" class="fix" args={{ command: b.fixCmd }} title={`fill in ${b.fixCmd}`}>
          {b.fixLabel}
        </Cmd>
      ) : null}
    </div>
  );
}

/** The design's bottom-left readout: the contoured value, the node, and where it is. */
export function probeLine(p: { face: string | null; body: string | null; point: [number, number, number]; node: number | null; value: number | null } | null): string {
  if (!p) return '';
  const where = `x ${p.point[0].toFixed(3)} y ${p.point[1].toFixed(3)} z ${p.point[2].toFixed(3)} m`;
  const who = p.value === null ? (p.face ?? p.body ?? '—') : `${formatNumber(p.value)}`;
  return p.node === null ? `${who} · ${where}` : `${who} · node ${p.node} · ${where}`;
}

const MODES = ['geometry', 'mesh', 'results'] as const;
const PRESETS = ['iso', 'front', 'top'] as const;
const LAYERS = ['edges', 'loads', 'constraints', 'grid'] as const;

/** Design state 4: the centred solving card, with the one Command that stops it. */
function SolvingCard({ s, dispatch }: { s: UiState; dispatch: Dispatch }) {
  if (s.solving === null) return null;
  const percent = Math.round((s.progress?.fraction ?? 0) * 100);
  return (
    <div class="solving-card" role="status">
      <div class="solving-head">
        <span class="spinner" />
        <b>Solving · {s.solving}</b>
        <Cmd dispatch={dispatch} cmd="solve.cancel" class="tbutton outline">
          Cancel
        </Cmd>
      </div>
      <div class="solving-bar">
        <span style={`width:${percent}%`} />
      </div>
      <div class="mono solving-meta">
        {s.progress?.phase ?? 'starting'} · {percent} % · the viewer stays interactive; cancelling replays the Journal without this solve
      </div>
    </div>
  );
}

/** Design state 7: the error card, its fix chip, and a way to hand it to the Assistant. */
function ErrorCard({ s, dispatch }: { s: UiState; dispatch: Dispatch }) {
  const e = s.lastError;
  if (!e) return null;
  // A suggestion is only a Command when it parses as one; otherwise it is a sentence to read.
  const fix = e.suggestion && /^[a-z]+\.[a-zA-Z]+$/.test(e.suggestion.trim()) ? e.suggestion.trim() : null;
  const text = `${e.code}: ${e.cause}${e.where ? ` (at ${e.where})` : ''}`;
  return (
    <div class="error-card" role="alert">
      <div class="error-head">
        <span class="mono code">{e.code}</span>
        <b>{e.cause}</b>
      </div>
      {e.where ? <div class="mono faint">where: {e.where}</div> : null}
      {e.suggestion ? <div class="error-fix">{e.suggestion}</div> : null}
      <div class="row">
        {fix ? (
          <Cmd dispatch={dispatch} cmd="form.open" class="fix mono" args={{ command: fix }} title={`fill in ${fix}`}>
            {fix}
          </Cmd>
        ) : null}
        <Cmd dispatch={dispatch} cmd="chat.send" class="tbutton outline" args={{ text }} onRun={() => void sendToAssistant(dispatch, text)}>
          Send this error to the Assistant
        </Cmd>
      </div>
    </div>
  );
}

/** Open the drawer, then send the error into it; the clipboard is the fallback when it refuses. */
async function sendToAssistant(dispatch: Dispatch, text: string): Promise<void> {
  await dispatch({ cmd: 'panel.toggle', panel: 'assistant', open: true }).catch(() => undefined);
  try {
    await dispatch({ cmd: 'chat.send', text: `This failed: ${text}. What should I change?` });
  } catch {
    await dispatch({ cmd: 'clipboard.copy', what: { kind: 'text', text } }).catch(() => undefined);
  }
}

/** The design's 168 px legend: field, unit, gradient bar, six ticks, three colour maps. */
function Legend({ s, dispatch }: { s: UiState; dispatch: Dispatch }) {
  const l = s.legend;
  if (!l) return null;
  const choices = fieldChoices(s.result?.extremes.map((e) => e.field) ?? []);
  const ticks = legendTicks(l.min, l.max);
  return (
    <div class="legend">
      <div class="legend-head">
        <span class="legend-field mono">{s.fieldKey}</span>
        <span class="legend-unit mono">{l.unit}</span>
        <span class="legend-sub mono">
          {s.result?.step} · deformed ×{formatNumber(s.deformScale)}
        </span>
      </div>
      <div class="legend-body">
        <div class="bar" style={`background:${cssGradient(s.colormap)}`} />
        <div class="ticks mono">
          {ticks.map((t, i) => (
            <span key={i} class={i === 0 ? 'tick top' : 'tick'}>
              {t}
            </span>
          ))}
        </div>
      </div>
      <div class="fields">
        {choices.map((c) => (
          <Cmd
            key={c.key}
            dispatch={dispatch}
            cmd="view.showField"
            class="field-chip mono"
            args={{ field: c.field, ...(c.component === null ? {} : { component: c.component }) }}
            pressed={s.fieldKey === c.key}
            title={`view.showField ${c.field}`}
          >
            {c.label}
          </Cmd>
        ))}
      </div>
      <div class="swatches">
        {COLORMAPS.map((c) => (
          <Cmd key={c} dispatch={dispatch} cmd="view.setLegend" args={{ colormap: c }} pressed={s.colormap === c} title={c}>
            <span style={`display:block;width:100%;height:100%;background:${cssGradient(c, 'to right')}`} />
          </Cmd>
        ))}
        <Cmd dispatch={dispatch} cmd="view.setLegend" class="chip-add" args={{ range: 'auto' }} title="clamp the legend to the data">
          auto
        </Cmd>
        <Cmd dispatch={dispatch} cmd="view.setLegend" class="chip-add" args={{ range: [0, l.max] }} title="clamp the legend from zero">
          0…max
        </Cmd>
      </div>
    </div>
  );
}

/** The deformation bar: play, the scale slider, true scale, and the screenshot. */
function DeformBar({ s, dispatch }: { s: UiState; dispatch: Dispatch }) {
  return (
    <div class="deform-bar">
      <Cmd dispatch={dispatch} cmd="view.animate" class="tbutton" args={{ step: s.result?.step ?? '', playing: true }} title="animate the deformation">
        ▶
      </Cmd>
      <span class="faint">deformation</span>
      <input
        type="range"
        min="0"
        max="400"
        step="10"
        aria-label="deformation scale"
        data-cmd="view.setDeformScale"
        value={String(s.deformScale)}
        onChange={(e) => void dispatch({ cmd: 'view.setDeformScale', scale: Number((e.target as HTMLInputElement).value) }).catch(() => undefined)}
      />
      <span class="mono">×{formatNumber(s.deformScale)}</span>
      <Cmd dispatch={dispatch} cmd="view.setDeformScale" class="tbutton" args={{ scale: 'true' }} title="draw the real displacement">
        true scale
      </Cmd>
      <Cmd dispatch={dispatch} cmd="file.export" class="tbutton" args={{ spec: { format: 'png' } }} title="the viewer as a PNG, legend burned in">
        screenshot
      </Cmd>
    </div>
  );
}

function ViewerPane({ s, dispatch, viewer }: { s: UiState; dispatch: Dispatch; viewer: ViewerRef }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [probe, setProbe] = useState('');
  const [broken, setBroken] = useState('');
  const results = s.viewMode === 'results' && s.result !== null;
  useEffect(() => {
    if (!canvas.current) return;
    let v: Viewer;
    try {
      v = new Viewer(canvas.current);
    } catch (e) {
      // No WebGL2 is a fact about the browser, not a crash: say so and keep the rest usable.
      setBroken(`This browser could not open a WebGL2 context: ${(e as Error).message}`);
      return;
    }
    viewer.current = v;
    v.onPick((p) => {
      setProbe(probeLine(p));
      if (p?.face) void dispatch({ cmd: 'selection.set', faces: [p.face], ...(p.body ? { bodies: [p.body] } : {}) }).catch(() => undefined);
    });
    const onResize = () => v.resize();
    addEventListener('resize', onResize);
    return () => {
      removeEventListener('resize', onResize);
      viewer.current = null;
      v.dispose();
    };
  }, [viewer, dispatch]);

  const ref = s.selection.refs[0];
  const stale = s.result?.stale === true;
  return (
    <div class="viewer">
      <canvas ref={canvas} />
      <div class="viewer-chrome">
        <div class="viewer-toolbar">
          <div class="segmented" role="group" aria-label="display mode">
            {MODES.map((mode) => (
              <Cmd key={mode} dispatch={dispatch} cmd="view.setMode" args={{ mode }} pressed={s.viewMode === mode}>
                {mode}
              </Cmd>
            ))}
          </div>
          {LAYERS.map((layer) => (
            <Cmd key={layer} dispatch={dispatch} cmd="view.toggle" class="toggle" args={{ layer }}>
              {layer}
            </Cmd>
          ))}
          <Cmd dispatch={dispatch} cmd="view.setClip" class="toggle" args={{ plane: s.clipOn ? null : { normal: [0, 1, 0], offset: 0 } }} pressed={s.clipOn}>
            clip
          </Cmd>
          {PRESETS.map((view) => (
            <Cmd key={view} dispatch={dispatch} cmd="view.preset" class="tbutton" args={{ view }}>
              {view}
            </Cmd>
          ))}
          <Cmd dispatch={dispatch} cmd="view.fit" class="tbutton">
            fit
          </Cmd>
        </div>
        {ref ? (
          <div class="selection-chip">
            <span>@{ref}</span>
            <Cmd dispatch={dispatch} cmd="clipboard.copy" class="key" args={{ what: { kind: 'selection' } }}>
              ⌘C
            </Cmd>
          </div>
        ) : null}
        {s.pickInto ? <div class="selection-chip armed">click a face in the viewer to fill {s.pickInto.join('.')}</div> : null}
      </div>
      {stale ? (
        <div class="stale-banner" role="status">
          <span>Result is stale — Model changed after journal line {s.result!.revision}</span>
          <Cmd dispatch={dispatch} cmd="solve.run" class="apply" args={{ step: s.result!.step }}>
            Re-solve
          </Cmd>
        </div>
      ) : null}
      {results ? <Legend s={s} dispatch={dispatch} /> : null}
      {results ? <DeformBar s={s} dispatch={dispatch} /> : null}
      <SolvingCard s={s} dispatch={dispatch} />
      <ErrorCard s={s} dispatch={dispatch} />
      <div class="probe mono">{probe}</div>
      {broken ? (
        <div class="hint">{broken}</div>
      ) : (s.model?.bodies.length ?? 0) === 0 ? (
        <div class="hint">
          <b>No geometry yet</b>
          <span>Add a box in Properties, or ask the Assistant. The banner above always says what is missing before Solve can run.</span>
        </div>
      ) : null}
    </div>
  );
}

export function App({ store, dispatch, viewer, query, commands = [], registry }: AppProps) {
  const s = useStore(store);
  const started = s.model !== null && (s.model.bodies.length > 0 || s.revision > 0);
  const read = useMemo<Query>(() => query ?? (async () => ({ value: 0, unit: '' })), [query]);

  // Design state 1: the moment a Model exists the Properties panel shows "New body".
  useEffect(() => {
    if (started && !s.form) store.openForm('geometry.addBox', { name: 'body', size: ['1 m', '100 mm', '100 mm'] });
  }, [started, s.form, store]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'k') (e.preventDefault(), void dispatch({ cmd: 'panel.toggle', panel: 'palette' }).catch(() => undefined));
      else if (meta && e.key.toLowerCase() === 'z') (e.preventDefault(), void dispatch({ cmd: e.shiftKey ? 'journal.redo' : 'journal.undo', steps: 1 }).catch(() => undefined));
      else if (meta && e.key.toLowerCase() === 'c' && s.selection.refs.length > 0) void dispatch({ cmd: 'clipboard.copy', what: { kind: 'selection' } }).catch(() => undefined);
      else if (e.key === 'Escape') for (const p of ['palette', 'examples', 'export', 'report']) void dispatch({ cmd: 'panel.toggle', panel: p, open: false }).catch(() => undefined);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [dispatch, s.selection.refs.length]);

  if (!started) {
    return (
      <>
        <Start s={s} dispatch={dispatch} />
        <Examples s={s} dispatch={dispatch} />
      </>
    );
  }
  return (
    <div class="shell">
      <TopBar s={s} dispatch={dispatch} />
      <div class="under-bar">
        <Banner s={s} dispatch={dispatch} />
        <div class="workspace">
          <ModelTree s={s} dispatch={dispatch} />
          <div class="centre">
            <ViewerPane s={s} dispatch={dispatch} viewer={viewer} />
            <Bottom s={s} store={store} dispatch={dispatch} query={read} />
          </div>
          <SchemaForm s={s} store={store} dispatch={dispatch} query={read} defs={DEFS} variants={VARIANTS} />
          {registry && s.panels['assistant'] ? <AssistantPanel registry={registry} store={store} /> : null}
        </div>
      </div>
      <Examples s={s} dispatch={dispatch} />
      <ExportModal s={s} dispatch={dispatch} />
      <Palette s={s} dispatch={dispatch} commands={commands} />
      {registry ? <TutorialPanel registry={registry} store={store} /> : null}
      <Tour store={store} />
    </div>
  );
}
