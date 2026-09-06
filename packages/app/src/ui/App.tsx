// The shell of docs/design/README.md: top bar, blocker banner, Model tree, viewer, Properties,
// bottom panel, and the three overlays. Rule (ADR 0003): everything a person can click dispatches
// one registry Command and carries its name in `data-cmd`, so `test/data-cmd.test.tsx` and the
// Playwright smoke can hold the DOM against `registry.list()`.
import type { CommandDef, EngineSchema, JsonSchema, Registry } from '@femlab/registry';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import schema from '../../../registry/src/generated/engine.schema.json';
import { engineChip } from '../capabilities';
import { choiceOf, fieldChoices, formatNumber, legendTicks, showFieldArgs } from '../fields';
import type { ViewerRef } from '../host';
import { lazy } from '../lazy';
import { solveLabel, stageOf, type Store, type UiState } from '../store';
import { COLORMAPS, cssGradient } from '../viewer/colormap';
import type { Viewer } from '../viewer/viewer';
import { Bottom } from './Bottom';
import { ExportModal } from './Export';
import { Examples, Palette, Start } from './Overlays';
import { SchemaForm, type Query } from './SchemaForm';
import { ModelTree } from './Tree';
import { Cmd, useStore, type Dispatch } from './cmd';
import { blockers, type Defs } from './schema';

export type { Dispatch } from './cmd';

// Three chunks that must not be on the boot path: the two AI SDKs, the tutorial runner and (in
// `ViewerPane` below) three.js. Same import sites as before, one `import()` later.
const AssistantPanel = lazy(() => import('../ai').then((m) => m.AssistantPanel));
const TutorialPanel = lazy(() => import('../tutorial').then((m) => m.TutorialPanel));
const Tour = lazy(() => import('../tutorial').then((m) => m.Tour));

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
  // Design state 7: while an error card stands, Solve is disabled and carries the same code.
  const reason = !s.ready ? 'the engine is still loading' : list[0] ? `${list[0].code} ${list[0].text}` : s.lastError ? `${s.lastError.code} ${s.lastError.cause}` : '';
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
const PRESETS = [
  { view: 'iso', shortcut: '⇧1' },
  { view: 'front', shortcut: '⇧2' },
  { view: 'top', shortcut: '⇧3' },
] as const;
const CAMERA_SHORTCUTS: Record<string, { cmd: 'view.preset'; view: (typeof PRESETS)[number]['view'] } | { cmd: 'view.fit' }> = {
  Digit1: { cmd: 'view.preset', view: 'iso' },
  Digit2: { cmd: 'view.preset', view: 'front' },
  Digit3: { cmd: 'view.preset', view: 'top' },
  Digit4: { cmd: 'view.fit' },
};

const isTypingInto = (target: EventTarget | null): boolean => target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null;
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
  const choices = fieldChoices(s.result?.extremes.map((e) => e.field) ?? [], s.result?.frequencies?.length ?? 0, s.yieldStress !== null);
  const ticks = legendTicks(l.min, l.max);
  return (
    <div class="legend">
      <div class="legend-head">
        <span class="legend-field mono">{choiceOf(s.fieldKey).label}</span>
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
            args={showFieldArgs(c)}
            pressed={s.fieldKey === c.key}
            title={`view.showField ${showFieldArgs(c).field}`}
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

/**
 * The deformation bar: play / pause, the phase scrub, the scale slider, true scale and the
 * screenshot. ▶ sweeps the drawn shape through `A·sin(2πt)`, which is what a mode shape means;
 * a transient Result keeps only its final field, so the sweep there is the amplitude rather
 * than a replay of the history, and the bar's own title says so.
 */
function DeformBar({ s, store, dispatch, viewer }: { s: UiState; store: Store; dispatch: Dispatch; viewer: ViewerRef }) {
  const step = s.result?.step ?? '';
  const mode = choiceOf(s.fieldKey).mode;
  const sweeps = mode !== undefined || (s.result?.history?.length ?? 0) > 0;
  const what = mode === undefined ? 'the deformed shape (the Result keeps one field, so the sweep is the amplitude)' : `mode ${mode}`;
  return (
    <div class="deform-bar">
      <Cmd
        dispatch={dispatch}
        cmd="view.animate"
        class="tbutton"
        args={{ step, playing: !s.playing, ...(mode === undefined ? {} : { mode }) }}
        pressed={s.playing}
        title={s.playing ? 'pause' : `sweep ${what}`}
        onRun={() => {
          store.set({ playing: !s.playing });
          void dispatch({ cmd: 'view.animate', step, playing: !s.playing, ...(mode === undefined ? {} : { mode }) }).catch(() => undefined);
        }}
      >
        {s.playing ? '❚❚' : '▶'}
      </Cmd>
      {sweeps ? (
        <input
          type="range"
          class="phase"
          min="0"
          max="100"
          step="2"
          aria-label="animation phase"
          data-cmd="view.animate"
          value={String(Math.round(s.phase * 100))}
          onInput={(e) => {
            const turns = Number((e.target as HTMLInputElement).value) / 100;
            // The Command carries the frame so a script and the AI can scrub too; the local
            // call is what makes it visible until the host forwards `frame` to the viewer.
            store.set({ phase: turns, playing: false });
            viewer.current?.setPhase(turns);
            void dispatch({ cmd: 'view.animate', step, playing: false, frame: Math.round(turns * 100), ...(mode === undefined ? {} : { mode }) }).catch(() => undefined);
          }}
        />
      ) : null}
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

function ViewerPane({ s, store, dispatch, viewer }: { s: UiState; store: Store; dispatch: Dispatch; viewer: ViewerRef }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [probe, setProbe] = useState('');
  const [broken, setBroken] = useState('');
  const results = s.viewMode === 'results' && s.result !== null;
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    // three.js is a lazy chunk, warmed by `main.tsx` the moment the shell paints, so by the time
    // a Model exists this `import()` is already in the module cache.
    let v: Viewer | null = null;
    let gone = false;
    let observer: ResizeObserver | null = null;
    const onResize = () => v?.resize();
    void import('../viewer/viewer').then(({ Viewer }) => {
      if (gone) return;
      try {
        v = new Viewer(el);
      } catch (e) {
        // No WebGL2 is a fact about the browser, not a crash: say so and keep the rest usable.
        setBroken(`This browser could not open a WebGL2 context: ${(e as Error).message}`);
        return;
      }
      viewer.current = v;
      viewer.onReady?.();
      v.onPick((p) => {
        setProbe(probeLine(p));
        if (p?.face) void dispatch({ cmd: 'selection.set', faces: [p.face], ...(p.body ? { bodies: [p.body] } : {}) }).catch(() => undefined);
      });
      addEventListener('resize', onResize);
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(onResize);
        observer.observe(el);
      }
      // A chunk that never arrives leaves the canvas blank rather than raising unhandled.
    }, () => undefined);
    return () => {
      gone = true;
      removeEventListener('resize', onResize);
      observer?.disconnect();
      if (!v) return;
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
          {PRESETS.map(({ view, shortcut }) => (
            <Cmd key={view} dispatch={dispatch} cmd="view.preset" class="tbutton" args={{ view }} title={`${view} view · ${shortcut}`}>
              {view}
            </Cmd>
          ))}
          <Cmd dispatch={dispatch} cmd="view.fit" class="tbutton" title="fit view · ⇧4">
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
      {results ? <DeformBar s={s} store={store} dispatch={dispatch} viewer={viewer} /> : null}
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
  // Collapse hides the drawer, but keeps the conversation and any running turn alive.
  const assistantOpened = useRef(false);
  assistantOpened.current ||= s.panels['assistant'] === true;
  const started = s.model !== null && (s.model.bodies.length > 0 || s.revision > 0);
  const read = useMemo<Query>(() => query ?? (async () => ({ value: 0, unit: '' })), [query]);

  // Design state 1: the moment a Model exists the Properties panel shows "New body".
  useEffect(() => {
    if (started && !s.form) store.openForm('geometry.addBox', { name: 'body', size: ['1 m', '100 mm', '100 mm'] });
  }, [started, s.form, store]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      const camera = e.shiftKey && !meta && !e.altKey && !e.repeat && !isTypingInto(e.target) ? CAMERA_SHORTCUTS[e.code] : undefined;
      if (camera) (e.preventDefault(), void dispatch(camera).catch(() => undefined));
      else if (meta && e.key.toLowerCase() === 'k') (e.preventDefault(), void dispatch({ cmd: 'panel.toggle', panel: 'palette' }).catch(() => undefined));
      else if (meta && e.key.toLowerCase() === 'z') (e.preventDefault(), void dispatch({ cmd: e.shiftKey ? 'journal.redo' : 'journal.undo', steps: 1 }).catch(() => undefined));
      else if (meta && e.key.toLowerCase() === 'c' && s.selection.refs.length > 0) void dispatch({ cmd: 'clipboard.copy', what: { kind: 'selection' } }).catch(() => undefined);
      else if (e.key === 'Escape') for (const p of ['palette', 'examples', 'export', 'report', 'tutorial']) if (s.panels[p]) void dispatch({ cmd: 'panel.toggle', panel: p, open: false }).catch(() => undefined);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [dispatch, s.selection.refs.length, s.panels]);

  // One fragment for both states, with the overlays at fixed positions: the start screen
  // offers "Start a tutorial", and a tutorial that begins there has to survive the switch to
  // the workspace its first Command causes — which it only does if the node keeps its slot.
  return (
    <>
      {started ? (
        <div class="shell">
          <TopBar s={s} dispatch={dispatch} />
          <div class={s.panels['assistant'] === true ? 'under-bar with-assistant' : 'under-bar'}>
            <Banner s={s} dispatch={dispatch} />
            <div class="workspace">
              <ModelTree s={s} dispatch={dispatch} />
              <div class="centre">
                <ViewerPane s={s} store={store} dispatch={dispatch} viewer={viewer} />
                <Bottom s={s} store={store} dispatch={dispatch} query={read} />
              </div>
              <SchemaForm s={s} store={store} dispatch={dispatch} query={read} defs={DEFS} variants={VARIANTS} />
            </div>
          </div>
        </div>
      ) : (
        <Start s={s} dispatch={dispatch} />
      )}
      <Examples s={s} dispatch={dispatch} />
      <ExportModal s={s} store={store} dispatch={dispatch} query={read} />
      <Palette s={s} dispatch={dispatch} commands={commands} />
      {registry ? <TutorialPanel registry={registry} store={store} /> : null}
      {/* Issue #40: a fixed slot in this fragment, not a column of `.workspace`, so the drawer
          opens on the start screen and keeps its conversation when the workspace comes up around
          it. `.under-bar.with-assistant` reserves its 392 px, which is what keeps the five-column
          layout of the design while the top bar stays full-width. Collapsing only hides the
          drawer, preserving the conversation and any running turn. */}
      {registry && assistantOpened.current ? <AssistantPanel registry={registry} store={store} hidden={!s.panels['assistant']} /> : null}
      {/* The tour's stops are shell regions, so it waits for the shell. */}
      {started ? <Tour store={store} /> : null}
    </>
  );
}
