// The shell of docs/design/README.md: top bar, Model tree, viewer, Properties, bottom panel.
// The forms and the rich panels are commits 33–36; what is here is the frame they drop into.
// Rule (ADR 0003): everything a person can click dispatches a registry Command, and carries its
// name in `data-cmd` so `test/data-cmd.test.tsx` can hold the DOM against `registry.list()`.
import type { BodyRow, ConstraintRow, JournalEntry, LoadRow, MaterialRow, StepRow } from '@femlab/registry';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { engineChip } from '../capabilities';
import type { ViewerRef } from '../host';
import type { Store, UiState } from '../store';
import { COLORMAPS, cssGradient } from '../viewer/colormap';
import { Viewer } from '../viewer/viewer';

export type Dispatch = (cmd: { cmd: string } & Record<string, unknown>) => Promise<unknown>;
export interface AppProps {
  store: Store;
  dispatch: Dispatch;
  viewer: ViewerRef;
}

function useStore(store: Store): UiState {
  const [state, setState] = useState(store.state);
  useEffect(() => store.subscribe(() => setState(store.state)), [store]);
  return state;
}

/** Every clickable in the app: one Command, one `data-cmd`, one place errors are caught. */
function Cmd(props: { dispatch: Dispatch; cmd: string; args?: Record<string, unknown>; class?: string; title?: string; disabled?: boolean; pressed?: boolean; children: ComponentChildren }) {
  const { dispatch, cmd, args, children, ...rest } = props;
  return (
    <button
      type="button"
      data-cmd={cmd}
      class={rest.class}
      title={rest.title ?? cmd}
      disabled={rest.disabled ?? false}
      {...(rest.pressed === undefined ? {} : { 'aria-pressed': rest.pressed })}
      onClick={() => void dispatch({ cmd, ...(args ?? {}) }).catch(() => undefined)}
    >
      {children}
    </button>
  );
}

const MM = { length: 'mm', force: 'N', stress: 'MPa' };
const SI = { length: 'm', force: 'N', stress: 'Pa' };

function TopBar({ s, dispatch }: { s: UiState; dispatch: Dispatch }) {
  const blocker = s.model?.warnings[0];
  const noModel = !s.model || s.model.steps.length === 0;
  const reason = !s.ready ? 'the engine is still loading' : noModel ? 'add a Step before solving' : blocker ? `${blocker.code} ${blocker.text}` : '';
  const mm = s.model?.units.length === 'mm';
  return (
    <header class="topbar">
      <div class="logo">
        <i /> FEM Lab
      </div>
      <span class="mono" style="color:var(--text-high)">
        {s.model?.name ?? 'no model'}
      </span>
      <span class="spacer" />
      <div class="segmented" role="group" aria-label="display units">
        <Cmd dispatch={dispatch} cmd="model.setUnits" args={{ units: MM }} pressed={mm} title="mm N MPa">
          mm N MPa
        </Cmd>
        <Cmd dispatch={dispatch} cmd="model.setUnits" args={{ units: SI }} pressed={!mm} title="m N Pa">
          m N Pa
        </Cmd>
      </div>
      <Cmd dispatch={dispatch} cmd="journal.undo" class="tbutton" args={{ steps: 1 }} disabled={!s.journal?.canUndo}>
        ↶
      </Cmd>
      <Cmd dispatch={dispatch} cmd="journal.redo" class="tbutton" args={{ steps: 1 }} disabled={!s.journal?.canRedo}>
        ↷
      </Cmd>
      <span class="chip" title={s.notes.join('\n') || 'everything available'}>
        <span class={s.notes.length > 0 ? 'dot warn' : 'dot'} />
        {s.hostCaps ? engineChip(s.hostCaps, s.engineCaps) : 'starting…'}
      </span>
      <Cmd dispatch={dispatch} cmd="solve.run" class="solve" disabled={reason !== ''} title={reason || 'solve.run'}>
        Solve
      </Cmd>
      <Cmd dispatch={dispatch} cmd="panel.toggle" class="tbutton" args={{ panel: 'examples' }}>
        Examples
      </Cmd>
      <Cmd dispatch={dispatch} cmd="panel.toggle" class="tbutton" args={{ panel: 'export' }}>
        Export
      </Cmd>
      <Cmd dispatch={dispatch} cmd="panel.toggle" class="tbutton" args={{ panel: 'report' }}>
        Report
      </Cmd>
      <Cmd dispatch={dispatch} cmd="panel.toggle" class="tbutton outline" args={{ panel: 'assistant' }} pressed={s.panels['assistant'] === true}>
        ✳ Assistant
      </Cmd>
    </header>
  );
}

function Banner({ s, dispatch }: { s: UiState; dispatch: Dispatch }) {
  if (s.lastError) {
    return (
      <div class="banner error" role="alert">
        <span class="code">{s.lastError.code}</span>
        <span>{s.lastError.cause}</span>
        {s.lastError.suggestion ? <span class="fix">{s.lastError.suggestion}</span> : null}
      </div>
    );
  }
  const w = s.model?.warnings[0];
  if (!w) return null;
  return (
    <div class="banner">
      <span class="code">{w.code}</span>
      <span>{w.text}</span>
      {w.where ? (
        <Cmd dispatch={dispatch} cmd="selection.set" class="fix" args={{ bodies: [w.where] }}>
          {w.where}
        </Cmd>
      ) : null}
    </div>
  );
}

type TreeRow = { kind: string; glyph: string; name: string; summary: string; select: Record<string, unknown> };

function rowsOf(s: UiState): { label: string; note: string; rows: TreeRow[] }[] {
  const m = s.model;
  return [
    {
      label: 'Geometry',
      note: 'No Bodies yet — every Model starts with one.',
      rows: (m?.bodies ?? []).map((b: BodyRow) => ({ kind: 'body', glyph: '◈', name: b.name, summary: `${b.measure.value.toPrecision(3)} ${b.measure.unit} · ${b.faces.length} faces`, select: { bodies: [b.name] } })),
    },
    {
      label: 'Materials',
      note: 'No Materials yet — a Body without one cannot be solved.',
      rows: (m?.materials ?? []).map((x: MaterialRow) => ({ kind: 'material', glyph: '●', name: x.name, summary: `E ${x.E.value} ${x.E.unit} · ν ${x.nu} · on ${x.assignedTo.join(', ') || 'nothing'}`, select: { sets: [] , bodies: x.assignedTo } })),
    },
    {
      label: 'Constraints',
      note: 'No Constraints yet — the Model would float.',
      rows: (m?.constraints ?? []).map((x: ConstraintRow) => ({ kind: 'constraint', glyph: '△', name: x.name, summary: `${x.summary} on ${x.on}`, select: { faces: [x.on] } })),
    },
    {
      label: 'Loads',
      note: 'No Loads yet — nothing would happen.',
      rows: (m?.loads ?? []).map((x: LoadRow) => ({ kind: 'load', glyph: '↓', name: x.name, summary: x.summary, select: x.on ? { faces: [x.on] } : {} })),
    },
    {
      label: 'Steps',
      note: 'No Steps yet — a Step says what to solve.',
      rows: (m?.steps ?? []).map((x: StepRow) => ({ kind: 'step', glyph: '▶', name: x.name, summary: `${x.procedure} · ${x.loads.length} loads`, select: {} })),
    },
  ];
}

function ModelTree({ s, dispatch }: { s: UiState; dispatch: Dispatch }) {
  const selected = new Set([...s.selection.bodies, ...s.selection.faces, ...s.selection.sets]);
  return (
    <aside class="panel">
      <div class="panel-head">
        <span class="section-label">Model</span>
        <span class="mono" style="font-size:10.5px;color:var(--text-faint)">
          rev {s.revision}
        </span>
      </div>
      {rowsOf(s).map((group) => (
        <div key={group.label}>
          <div class="group section-label">{group.label}</div>
          {group.rows.length === 0 ? <div class="empty-note">{group.note}</div> : null}
          {group.rows.map((r) => (
            <Cmd key={r.name} dispatch={dispatch} cmd="selection.set" class="row" args={r.select} title={`selection.set ${r.name}`}>
              <span class="glyph">{r.glyph}</span>
              <span class="name">{r.name}</span>
              <span class="summary">{r.summary}</span>
              <span class="spacer" />
              {selected.has(r.name) ? <span class="mono" style="color:var(--accent)">•</span> : null}
            </Cmd>
          ))}
        </div>
      ))}
    </aside>
  );
}

const MODES = ['geometry', 'mesh', 'results'] as const;
const PRESETS = ['iso', 'front', 'top'] as const;

function ViewerPane({ s, dispatch, viewer }: { s: UiState; dispatch: Dispatch; viewer: ViewerRef }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [probe, setProbe] = useState('');
  const [broken, setBroken] = useState('');
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
      setProbe(p ? `${p.face ?? p.body ?? '—'} · x ${p.point[0].toFixed(1)} y ${p.point[1].toFixed(1)} z ${p.point[2].toFixed(1)}` : '');
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'c' && ref) void dispatch({ cmd: 'clipboard.copy', what: { kind: 'selection' } }).catch(() => undefined);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [dispatch, ref]);

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
      </div>
      {s.viewMode === 'results' ? (
      <div class="legend">
        <div class="section-label">Colour map</div>
        <div class="bar" style={`background:${cssGradient(s.colormap)}`} />
        <div class="swatches">
          {COLORMAPS.filter((c) => c !== 'turbo').map((c) => (
            <Cmd key={c} dispatch={dispatch} cmd="view.setLegend" args={{ colormap: c }} pressed={s.colormap === c} title={c}>
              <span style={`display:block;width:100%;height:100%;background:${cssGradient(c, 'to right')}`} />
            </Cmd>
          ))}
        </div>
      </div>
      ) : null}
      <div class="probe mono">{probe}</div>
      {broken ? <div class="hint">{broken}</div> : (s.model?.bodies.length ?? 0) === 0 ? <div class="hint">No geometry yet — add a Body to see it here.</div> : null}
    </div>
  );
}

const TABS = ['journal', 'script', 'console'] as const;

function args(cmd: Record<string, unknown>): string {
  const { cmd: _name, ...rest } = cmd;
  const text = JSON.stringify(rest);
  return text.length > 90 ? `${text.slice(0, 89)}…` : text;
}

function Bottom({ s, dispatch }: { s: UiState; dispatch: Dispatch }) {
  const counts = { journal: s.journal?.entries.length ?? 0, script: s.script.split('\n').length, console: s.console.length };
  return (
    <section class="bottom">
      <div class="tabs" role="tablist">
        {TABS.map((t) => (
          <Cmd key={t} dispatch={dispatch} cmd="panel.toggle" class={s.tab === t ? 'tab active' : 'tab'} args={{ panel: t, open: true }} title={`panel.toggle ${t}`}>
            <span aria-selected={s.tab === t} role="tab">
              {t}
              <span class="count">{counts[t]}</span>
            </span>
          </Cmd>
        ))}
      </div>
      {s.tab === 'journal' ? (
        <div class="log">
          {(s.journal?.entries ?? []).map((e: JournalEntry) => (
            <div key={e.seq}>
              <span class="no">{e.seq}</span>
              <span class="cmd">{(e.cmd as unknown as { cmd: string }).cmd}</span> <span class="args">{args(e.cmd as unknown as Record<string, unknown>)}</span>
            </div>
          ))}
        </div>
      ) : null}
      {s.tab === 'script' ? <pre class="log">{s.script}</pre> : null}
      {s.tab === 'console' ? (
        <div class="log">
          {s.console.map((l, i) => (
            <div key={i}>
              <span class="no">{new Date(l.at).toISOString().slice(11, 19)}</span>
              <span class={`lvl-${l.level}`}>{l.level}</span> {l.text}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function Properties({ s }: { s: UiState }) {
  const name = s.selection.bodies[0] ?? s.selection.faces[0] ?? s.selection.sets[0] ?? null;
  const object =
    name === null
      ? null
      : (s.model?.bodies.find((b) => b.name === name) ??
        s.model?.materials.find((b) => b.name === name) ??
        s.model?.constraints.find((b) => b.name === name) ??
        s.model?.loads.find((b) => b.name === name) ??
        { name });
  return (
    <aside class="panel props">
      <div class="panel-head">
        <span class="section-label">Properties</span>
        <span class="mono" style="font-size:10.5px;color:var(--text-faint)">
          {name ?? '—'}
        </span>
      </div>
      {object ? <pre>{JSON.stringify(object, null, 2)}</pre> : <div class="empty-note">Select something in the tree or the viewer.</div>}
    </aside>
  );
}

function Start({ s, dispatch }: { s: UiState; dispatch: Dispatch }) {
  return (
    <div class="start">
      <h1>
        <i /> FEM Lab
      </h1>
      <p style="color:var(--text-faint);margin:0">A finite-element editor and solver in a browser tab. No install, no server, nothing leaves this page.</p>
      <div class="cards">
        <Cmd dispatch={dispatch} cmd="panel.toggle" class="card cue" args={{ panel: 'assistant' }}>
          <b>Ask the Assistant</b>
          <span>Describe the model in words and watch the Commands land in the Journal.</span>
        </Cmd>
        <Cmd dispatch={dispatch} cmd="panel.toggle" class="card" args={{ panel: 'examples' }}>
          <b>Open an example</b>
          <span>A benchmark with a reference value, opened as its own Journal.</span>
        </Cmd>
        <Cmd dispatch={dispatch} cmd="model.new" class="card" args={{ name: 'model' }} disabled={!s.ready}>
          <b>Start from geometry</b>
          <span>An empty Model; add a Body, a Material, a Mesh, then solve.</span>
        </Cmd>
      </div>
      <div class="caps">
        {s.ready ? '●' : '○'} {s.hostCaps ? engineChip(s.hostCaps, s.engineCaps) : 'starting…'} · {s.hostCaps?.webgpu ? 'WebGPU available' : 'no WebGPU'} ·{' '}
        {s.hostCaps?.crossOriginIsolated ? 'cross-origin isolated' : 'not isolated'} · no install · no server · nothing leaves the tab
      </div>
      {s.notes.length > 0 ? <div class="notes">{s.notes.join(' · ')}</div> : null}
      {s.lastError ? <div class="notes" style="color:var(--red-text)">{`${s.lastError.code}: ${s.lastError.cause}`}</div> : null}
    </div>
  );
}

function Examples({ dispatch }: { dispatch: Dispatch }) {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}examples/index.json`)
      .then((r) => r.json() as Promise<{ examples: { name: string }[] }>)
      .then((j) => setNames(j.examples.map((e) => e.name)))
      .catch(() => setNames([]));
  }, []);
  return (
    <div class="panel">
      <div class="panel-head">
        <span class="section-label">Examples</span>
        <Cmd dispatch={dispatch} cmd="panel.toggle" class="tbutton" args={{ panel: 'examples', open: false }}>
          ×
        </Cmd>
      </div>
      {names.map((name) => (
        <Cmd key={name} dispatch={dispatch} cmd="file.openExample" class="row" args={{ name }}>
          <span class="glyph">◧</span>
          <span class="name">{name}</span>
        </Cmd>
      ))}
      {names.length === 0 ? <div class="empty-note">No bundled examples were found.</div> : null}
    </div>
  );
}

export function App({ store, dispatch, viewer }: AppProps) {
  const s = useStore(store);
  const started = s.model !== null && (s.model.bodies.length > 0 || s.revision > 0);
  if (!started) return <Start s={s} dispatch={dispatch} />;
  return (
    <div class="shell">
      <TopBar s={s} dispatch={dispatch} />
      <div style="display:grid;grid-template-rows:auto 1fr;min-height:0">
        <Banner s={s} dispatch={dispatch} />
        <div class="workspace">
          <ModelTree s={s} dispatch={dispatch} />
          <div class="centre">
            <ViewerPane s={s} dispatch={dispatch} viewer={viewer} />
            <Bottom s={s} dispatch={dispatch} />
          </div>
          {s.panels['examples'] ? <Examples dispatch={dispatch} /> : <Properties s={s} />}
        </div>
      </div>
    </div>
  );
}
