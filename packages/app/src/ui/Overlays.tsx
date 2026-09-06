// The full-screen states of docs/design/README.md that are not the workspace: the start screen's
// four paths, the examples gallery and the ⌘K command palette. The palette is the registry made
// visible — every row is one Command with its doc string, which is also the AI's tool description.
import type { CommandDef } from '@femlab/registry';
import { useEffect, useState } from 'preact/hooks';
import type { ExampleEntry } from '../benchmark';
import { engineChip } from '../capabilities';
import type { UiState } from '../store';
import { Cmd, type Dispatch } from './cmd';
import { humanise } from './schema';

/** Substring-in-order match, the cheapest fuzzy filter that still feels like one. */
export function fuzzy(query: string, text: string): boolean {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (q === '') return true;
  let i = 0;
  for (const ch of text.toLowerCase()) if (ch === q[i]) i++;
  return i === q.length;
}

/**
 * How well a Command answers the query: lower is better, `null` is no match. A typed Command
 * name has to come first, or `⇥` fills in whatever happens to be at the top of the registry.
 */
export function score(query: string, def: { name: string; description: string }): number | null {
  const q = query.toLowerCase().trim();
  if (q === '') return 0;
  const name = def.name.toLowerCase();
  if (name === q) return 0;
  if (name.includes(q)) return 1;
  if (fuzzy(q, name)) return 2;
  if (def.description.toLowerCase().includes(q)) return 3;
  return fuzzy(q, def.description) ? 4 : null;
}

/** The palette's rows: every matching Command, best match first, ties in registry order. */
export function rankCommands<T extends { name: string; description: string }>(query: string, commands: T[]): T[] {
  return commands
    .map((c, i) => ({ c, i, s: score(query, c) }))
    .filter((r): r is { c: T; i: number; s: number } => r.s !== null)
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((r) => r.c);
}

/** Parameters a Command cannot run without, so the palette knows whether ↵ can run it outright. */
export function requiredOf(def: CommandDef): string[] {
  const required = (def.schema as { required?: string[] }).required ?? [];
  return required.filter((r) => r !== 'cmd' && r !== 'query');
}

export function Palette({ s, dispatch, commands }: { s: UiState; dispatch: Dispatch; commands: CommandDef[] }) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const rows = rankCommands(query, commands).slice(0, 60);
  const active = rows[Math.min(cursor, rows.length - 1)];
  if (!s.panels['palette']) return null;
  const fill = (def: CommandDef): void => void dispatch({ cmd: 'form.open', command: def.name }).then(() => dispatch({ cmd: 'panel.toggle', panel: 'palette', open: false })).catch(() => undefined);
  const run = (def: CommandDef): void =>
    void (requiredOf(def).length === 0 ? dispatch({ cmd: def.name }).then(() => dispatch({ cmd: 'panel.toggle', panel: 'palette', open: false })) : Promise.resolve(fill(def))).catch(() => undefined);
  return (
    <div class="overlay" onClick={() => void dispatch({ cmd: 'panel.toggle', panel: 'palette', open: false })}>
      <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette" onClick={(e) => e.stopPropagation()}>
        <div class="palette-head">
          <span class="mono prompt">›</span>
          <input
            class="mono"
            autoFocus
            placeholder="Search commands or ask in plain words"
            value={query}
            onInput={(e) => (setQuery((e.target as HTMLInputElement).value), setCursor(0))}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') setCursor((c) => Math.min(c + 1, rows.length - 1));
              else if (e.key === 'ArrowUp') setCursor((c) => Math.max(c - 1, 0));
              else if (e.key === 'Tab' && active) (e.preventDefault(), fill(active));
              else if (e.key === 'Enter' && active) run(active);
            }}
          />
          <span class="palette-note">every entry is one Command</span>
        </div>
        <div class="palette-rows">
          {rows.map((c, i) => (
            <Cmd key={c.name} dispatch={dispatch} cmd="form.open" class={i === Math.min(cursor, rows.length - 1) ? 'prow active' : 'prow'} args={{ command: c.name }} title={c.name} onRun={() => run(c)}>
              <span class={`mono pname ${c.provider}`}>{c.name}</span>
              <span class="pdesc">{c.description.split('\n')[0]}</span>
              <span class="mono pkey">{requiredOf(c).length === 0 ? '↵' : '⇥'}</span>
            </Cmd>
          ))}
          {rows.length === 0 ? <div class="empty-note">Nothing in the registry matches. Every capability is a Command, so if it is not here it does not exist yet.</div> : null}
        </div>
        <div class="palette-foot mono">
          <span>↑↓ move</span>
          <span>↵ run</span>
          <span>⇥ fill parameters</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}

export function Examples({ s, dispatch }: { s: UiState; dispatch: Dispatch }) {
  const [items, setItems] = useState<ExampleEntry[]>([]);
  const open = s.panels['examples'] === true;
  useEffect(() => {
    if (!open) return;
    fetch(`${import.meta.env.BASE_URL}examples/index.json`)
      .then((r) => r.json() as Promise<{ examples: ExampleEntry[] }>)
      .then((j) => setItems(j.examples))
      .catch(() => setItems([]));
  }, [open]);
  if (!open) return null;
  return (
    <div class="overlay wide" onClick={() => void dispatch({ cmd: 'panel.toggle', panel: 'examples', open: false })}>
      <div class="gallery" role="dialog" aria-modal="true" aria-label="Examples and benchmarks" onClick={(e) => e.stopPropagation()}>
        <div class="gallery-head">
          <span class="gallery-title">Examples &amp; benchmarks</span>
          <span class="gallery-sub">Each one opens as a Journal you can read, edit and rerun. Reference values ship with the app.</span>
          <Cmd dispatch={dispatch} cmd="panel.toggle" class="tbutton" args={{ panel: 'examples', open: false }}>
            ×
          </Cmd>
        </div>
        <div class="cards-grid">
          {items.map((e) => (
            <Cmd key={e.name} dispatch={dispatch} cmd="file.openExample" class="ex-card" args={{ name: e.name }} title={`file.openExample ${e.name}`}>
              <span class="ex-thumb" />
              <span class="ex-body">
                <span class="ex-title">{humanise(e.name.replace(/-/g, ' '))}</span>
                <span class="ex-text">{e.summary}</span>
                <span class="ex-foot mono">
                  <span>Journal</span>
                  <span class="cyan">{e.commands} Commands</span>
                </span>
              </span>
            </Cmd>
          ))}
          {items.length === 0 ? <div class="empty-note">No bundled examples were found. `npm run dev` copies them from crates/engine/benches/journals.</div> : null}
        </div>
      </div>
    </div>
  );
}

export function Start({ s, dispatch }: { s: UiState; dispatch: Dispatch }) {
  const [name, setName] = useState('model');
  return (
    <div class="start">
      <h1>
        <i /> FEM Lab
      </h1>
      <p class="pitch">A finite-element editor and solver in a browser tab. No install, no server, nothing leaves this page.</p>
      <div class="cards">
        <Cmd dispatch={dispatch} cmd="panel.toggle" class="card cue" args={{ panel: 'assistant' }}>
          <b>Ask the Assistant</b>
          <span>Describe the part in words. It builds the geometry, meshes, solves and checks it — every step lands in the Journal.</span>
          <i class="mono cue-yellow">⇧A · shares this Model with you</i>
        </Cmd>
        <Cmd dispatch={dispatch} cmd="panel.toggle" class="card" args={{ panel: 'examples' }}>
          <b>Open an example</b>
          <span>Worked benchmarks with reference values, each opened as its own Journal.</span>
          <i class="mono cue-cyan">file.openExample(…)</i>
        </Cmd>
        <Cmd dispatch={dispatch} cmd="model.new" class="card" args={{ name }} disabled={!s.ready} title="model.new">
          <b>Start from geometry</b>
          <span>An empty Model; add a Body, a Material, a Mesh, a Constraint, a Load and a Step, then solve.</span>
          <input
            class="mono start-name"
            aria-label="model name"
            data-cmd="model.new"
            value={name}
            onClick={(e) => e.stopPropagation()}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
          />
        </Cmd>
        <Cmd dispatch={dispatch} cmd="panel.toggle" class="card" args={{ panel: 'tutorial' }}>
          <b>Start a tutorial</b>
          <span>Nine guided walks, one Command at a time with the reason for each: a cantilever, a plate with a hole, heat, modes, a convergence study.</span>
          <i class="mono">tutorials · step by step</i>
        </Cmd>
        {s.autosave ? (
          <Cmd dispatch={dispatch} cmd="file.restore" class="card" title="file.restore">
            <b>Restore the last model</b>
            <span>
              {s.autosave.name} · {s.autosave.commands} Commands, autosaved in this browser {new Date(s.autosave.at).toLocaleString()}.
            </span>
            <i class="mono">file.restore()</i>
          </Cmd>
        ) : null}
      </div>
      <div class="caps mono">
        {s.ready ? '●' : '○'} {s.hostCaps ? engineChip(s.hostCaps, s.engineCaps) : 'starting…'} · {s.hostCaps?.webgpu ? 'WebGPU available' : 'no WebGPU'} ·{' '}
        {s.hostCaps?.crossOriginIsolated ? 'cross-origin isolated' : 'not isolated'} · no install · no server · nothing leaves the tab
      </div>
      {s.notes.length > 0 ? <div class="notes">{s.notes.join(' · ')}</div> : null}
      {s.lastError ? <div class="notes bad">{`${s.lastError.code}: ${s.lastError.cause}`}</div> : null}
    </div>
  );
}
