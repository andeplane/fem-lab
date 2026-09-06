// The full-screen states of docs/design/README.md that are not the workspace: the start screen
// (issue #41), the examples gallery and the ⌘K command palette. The palette is the registry made
// visible — every row is one Command with its doc string, which is also the AI's tool description.
import type { CommandDef, ObjectRef, ProjectMeta } from '@femlab/registry';
import { useEffect, useRef, useState } from 'preact/hooks';
import { engineChip } from '../capabilities';
import type { ExampleDifficulty, ExampleFilter, UiState } from '../store';
import { Cmd, type Dispatch } from './cmd';
import { useDialogFocus } from './Dialog';
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

/** Route only objects returned by query.objects; geometric selection and editing use the registry. */
export function objectRoute(object: ObjectRef, s: UiState): { cmd: string; [key: string]: unknown } | null {
  if (object.ref.endsWith('.*')) return null; // query.objects can describe a family of cut faces, not one selectable Set.
  if (object.kind === 'body') return { cmd: 'selection.set', bodies: [object.name], mode: 'replace' };
  if (object.kind === 'set' || object.kind === 'face') return { cmd: 'selection.set', sets: [object.name], mode: 'replace' };
  if (['material', 'constraint', 'load', 'step'].includes(object.kind)) return { cmd: 'form.edit', kind: object.kind, name: object.name };
  if (object.kind !== 'journal') return null;
  const entry = s.journal?.entries.find((e) => e.seq === Number(object.name));
  if (!entry) return null;
  const { cmd, ...args } = entry.cmd;
  return { cmd: 'form.open', command: cmd, args };
}

export function Palette({ s, dispatch, commands }: { s: UiState; dispatch: Dispatch; commands: CommandDef[] }) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(s.panels['palette'] === true, dialog);
  const text = query.trim();
  const objectMode = /^@[^\s]*$/.test(text);
  const exact = commands.some((c) => c.name.toLowerCase() === text.toLowerCase());
  const intent = s.paletteIntent?.text === text && !exact ? s.paletteIntent : null;
  const stale = intent !== null && intent.modelHash !== (s.model?.hash ?? null);
  const commandRows = rankCommands(query, commands).slice(0, 60);
  const objects = objectMode ? s.objects.filter((o) => fuzzy(text.slice(1), `${o.ref} ${o.name}`)).slice(0, 60) : [];
  const proposals = intent?.status === 'ready' ? intent.proposals : [];
  const preview = intent?.status === 'ready';
  const count = objectMode ? objects.length : preview ? proposals.length : commandRows.length;
  const selected = Math.max(0, Math.min(cursor, count - 1));
  const plainWords = !objectMode && !exact && /\s/.test(text);
  if (!s.panels['palette']) return null;
  const close = () => dispatch({ cmd: 'panel.toggle', panel: 'palette', open: false });
  const fill = (name: string, args?: Record<string, unknown>): void => void close().then(() => dispatch({ cmd: 'form.open', command: name, ...(args ? { args } : {}) })).catch(() => undefined);
  const run = (def: CommandDef): void => void (requiredOf(def).length === 0 ? dispatch({ cmd: def.name }).then(close) : Promise.resolve(fill(def.name))).catch(() => undefined);
  const resolve = () => void dispatch({ cmd: 'palette.resolve', text }).catch(() => undefined);
  const route = (object: ObjectRef) => {
    const action = objectRoute(object, s);
    if (action) void dispatch(action).then(close).catch(() => undefined);
  };
  const activate = (tab: boolean) => {
    if (objectMode) { if (objects[selected]) route(objects[selected]!); }
    else if (preview) { if (!stale && proposals[selected]) fill(proposals[selected]!.command, proposals[selected]!.args); }
    else if (!tab && plainWords) resolve();
    else if (commandRows[selected]) tab ? fill(commandRows[selected]!.name) : run(commandRows[selected]!);
    else if (text) resolve();
  };
  return (
    <div class="overlay" onClick={() => void close()}>
      <div ref={dialog} class="palette" role="dialog" aria-modal="true" aria-label="Command palette" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div class="palette-head">
          <span class="mono prompt">›</span>
          <input class="mono" autoFocus placeholder="Search commands, @objects or ask in plain words" value={query}
            onInput={(e) => (setQuery((e.target as HTMLInputElement).value), setCursor(0))}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, Math.max(0, count - 1))); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
              else if (e.key === 'Tab' && count > 0 && !e.shiftKey) { e.preventDefault(); activate(true); }
              else if (e.key === 'Enter') { e.preventDefault(); activate(false); }
              else if (e.key === 'Escape') { e.preventDefault(); void close(); }
            }} />
          <span class="palette-note">every entry is one Command</span>
        </div>
        {text && !objectMode && !exact ? <div class="palette-intent">
          <Cmd dispatch={dispatch} cmd="palette.resolve" args={{ text }} disabled={intent?.status === 'loading'}>{intent?.status === 'loading' ? 'Preparing preview…' : 'Prepare intent preview'}</Cmd>
          <span class="faint">Uses your Assistant provider; review parameters before Apply.</span>
        </div> : null}
        {intent?.clarification ? <div class="empty-note" role="status">{intent.clarification}</div> : null}
        {stale ? <div class="empty-note">The Model changed. Prepare the preview again before choosing a command.</div> : null}
        {intent?.status === 'error' ? <Cmd dispatch={dispatch} cmd="panel.toggle" args={{ panel: 'assistant.settings', open: true }} onRun={() => void dispatch({ cmd: 'panel.toggle', panel: 'assistant.settings', open: true }).then(() => dispatch({ cmd: 'panel.toggle', panel: 'assistant', open: true })).then(close)}>Assistant Settings</Cmd> : null}
        <div class="palette-rows">
          {objectMode ? objects.map((object, i) => {
            const action = objectRoute(object, s);
            return <Cmd key={object.ref} dispatch={dispatch} cmd={action?.cmd ?? 'form.open'} class={i === selected ? 'prow active' : 'prow'} disabled={!action} onRun={() => route(object)} title={object.ref}>
              <span class="mono pname">@{object.ref}</span><span class="pdesc">{object.summary}</span><span class="mono pkey">{action?.cmd === 'selection.set' ? 'select' : action ? 'review' : 'no direct route'}</span>
            </Cmd>;
          }) : preview ? proposals.map((p, i) => <Cmd key={`${p.command}:${i}`} dispatch={dispatch} cmd="form.open" args={{ command: p.command, args: p.args }} disabled={stale} class={i === selected ? 'prow active' : 'prow'} onRun={() => fill(p.command, p.args)}>
            <span class="mono pname">{p.command}</span><span class="pdesc">{JSON.stringify(p.args)}{p.missing.length ? ` · Fill in: ${p.missing.join(', ')}` : ''}</span><span class="mono pkey">review ⇥</span>
          </Cmd>) : commandRows.map((c, i) => <Cmd key={c.name} dispatch={dispatch} cmd="form.open" class={i === selected ? 'prow active' : 'prow'} args={{ command: c.name }} title={c.name} onRun={() => run(c)}>
            <span class={`mono pname ${c.provider}`}>{c.name}</span><span class="pdesc">{c.description.split('\n')[0]}</span><span class="mono pkey">{requiredOf(c).length === 0 ? '↵' : '⇥'}</span>
          </Cmd>)}
          {count === 0 ? <div class="empty-note">{objectMode ? 'No Model object matches this reference.' : preview ? 'Clarify the request above, then prepare another preview.' : 'No command name matches. Describe the operation and prepare an intent preview.'}</div> : null}
        </div>
        <div class="palette-foot mono"><span>↑↓ move</span><span>{preview || plainWords ? '↵ preview' : '↵ run'}</span><span>⇥ fill parameters</span><span>esc close</span></div>
      </div>
    </div>
  );
}

export interface ExampleEntry {
  name: string;
  commands: number;
  title: string;
  tag: string;
  tags: string[];
  difficulty: ExampleDifficulty;
  summary: string;
  expected: {
    quantity: string;
    value: number | number[];
    unit: string;
    reference: string;
  };
  thumbnail: string | null;
}

export function filterExamples(items: ExampleEntry[], filter: ExampleFilter): ExampleEntry[] {
  return items.filter((item) => (filter.tag === null || item.tags.includes(filter.tag)) && (filter.difficulty === null || item.difficulty === filter.difficulty));
}

export const expectedValue = (expected: ExampleEntry['expected']): string =>
  `${Array.isArray(expected.value) ? expected.value.join(' · ') : String(expected.value)} ${expected.unit}`;

export function Examples({ s, dispatch }: { s: UiState; dispatch: Dispatch }) {
  const [items, setItems] = useState<ExampleEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const open = s.panels['examples'] === true;
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(open, dialog);
  useEffect(() => {
    if (!open) return;
    setLoaded(false);
    fetch(`${import.meta.env.BASE_URL}examples/index.json`)
      .then((r) => r.json() as Promise<{ examples: ExampleEntry[] }>)
      .then((j) => (setItems(j.examples), setLoaded(true)))
      .catch(() => (setItems([]), setLoaded(true)));
  }, [open]);
  if (!open) return null;
  const tags = [...new Set(items.flatMap((item) => item.tags))].sort();
  const shown = filterExamples(items, s.exampleFilter);
  const filtered = s.exampleFilter.tag !== null || s.exampleFilter.difficulty !== null;
  const applyFilter = (patch: Partial<ExampleFilter>) =>
    void dispatch({ cmd: 'example.filter', ...s.exampleFilter, ...patch }).catch(() => undefined);
  return (
    <div class="overlay wide" onClick={() => void dispatch({ cmd: 'panel.toggle', panel: 'examples', open: false })}>
      <div ref={dialog} class="gallery" role="dialog" aria-modal="true" aria-label="Examples and benchmarks" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div class="gallery-head">
          <span class="gallery-title">Examples &amp; benchmarks</span>
          <span class="gallery-sub">Each one opens as a Journal you can read, edit and rerun. Reference values ship with the app.</span>
          <Cmd dispatch={dispatch} cmd="panel.toggle" class="tbutton" args={{ panel: 'examples', open: false }}>
            <span class="sr-only">Close examples</span>
            ×
          </Cmd>
        </div>
        <div class="gallery-filters">
          <label>
            <span>Tag</span>
            <select
              aria-label="Filter examples by tag"
              data-cmd="example.filter"
              value={s.exampleFilter.tag ?? ''}
              onChange={(e) => applyFilter({ tag: (e.target as HTMLSelectElement).value || null })}
            >
              <option value="">all tags</option>
              {tags.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Difficulty</span>
            <select
              aria-label="Filter examples by difficulty"
              data-cmd="example.filter"
              value={s.exampleFilter.difficulty ?? ''}
              onChange={(e) => applyFilter({ difficulty: ((e.target as HTMLSelectElement).value ? Number((e.target as HTMLSelectElement).value) : null) as ExampleDifficulty | null })}
            >
              <option value="">all levels</option>
              <option value="1">1 · start here</option>
              <option value="2">2 · applied</option>
              <option value="3">3 · advanced</option>
            </select>
          </label>
          <span class="gallery-count mono" aria-live="polite">
            {shown.length} / {items.length}
          </span>
          {filtered ? (
            <Cmd dispatch={dispatch} cmd="example.filter" class="tbutton" args={{ tag: null, difficulty: null }}>
              reset filters
            </Cmd>
          ) : null}
        </div>
        <div class="cards-grid">
          {!loaded ? <div class="empty-note">Loading bundled examples…</div> : null}
          {shown.map((e) => (
            <Cmd key={e.name} dispatch={dispatch} cmd="file.openExample" class="ex-card" args={{ name: e.name }} title={`file.openExample ${e.name}`}>
              <span class="ex-thumb">
                {e.thumbnail ? (
                  <img src={`${import.meta.env.BASE_URL}examples/${e.thumbnail}`} alt={`Rendered viewer preview of ${e.title}`} width="320" height="180" loading="lazy" decoding="async" />
                ) : (
                  <span class="ex-thumb-pending mono">preview pending</span>
                )}
                <span class="ex-tag mono">{e.tag}</span>
              </span>
              <span class="ex-body">
                <span class="ex-title">{e.title || humanise(e.name.replace(/-/g, ' '))}</span>
                <span class="ex-text">{e.summary}</span>
                <span class="ex-expected">
                  <span class="section-label">{e.expected.quantity}</span>
                  <span class="mono cyan">{expectedValue(e.expected)}</span>
                  <span class="ex-reference">{e.expected.reference}</span>
                </span>
                <span class="ex-foot mono">
                  <span>difficulty {e.difficulty}</span>
                  <span>{e.commands} Commands</span>
                </span>
              </span>
            </Cmd>
          ))}
          {loaded && items.length === 0 ? <div class="empty-note">No bundled examples were found. `npm run dev` copies them from crates/engine/benches/journals.</div> : null}
          {loaded && items.length > 0 && shown.length === 0 ? (
            <div class="empty-note gallery-empty">
              <span>No examples match both filters.</span>
              <Cmd dispatch={dispatch} cmd="example.filter" class="tbutton outline" args={{ tag: null, difficulty: null }}>
                reset filters
              </Cmd>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** "4 minutes ago", "2 days ago" — a card wants the age, not a timestamp to parse. */
export function ago(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  const units: [number, string][] = [
    [86_400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ];
  const unit = units.find(([size]) => seconds >= size);
  if (!unit) return 'just now';
  const n = Math.floor(seconds / unit[0]);
  return `${n} ${unit[1]}${n === 1 ? '' : 's'} ago`;
}

/** One Recent card: the whole card opens the project, with rename and delete sitting on it. */
function RecentCard({ p, dispatch }: { p: ProjectMeta; dispatch: Dispatch }) {
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  return (
    <div class="recent">
      <Cmd dispatch={dispatch} cmd="project.open" class="recent-open" args={{ id: p.id }} title={`project.open ${p.name}`}>
        {p.thumbnail ? <img class="recent-thumb" src={p.thumbnail} alt="" /> : <span class="recent-thumb empty" />}
        <span class="recent-name mono">{p.name}</span>
        <span class="recent-meta mono">
          {p.commands} Command{p.commands === 1 ? '' : 's'} · edited {ago(p.at)}
        </span>
      </Cmd>
      <div class="recent-tools">
        {renaming === null ? null : (
          <input
            class="mono rename-field"
            aria-label={`rename ${p.name}`}
            data-cmd="project.rename"
            autoFocus
            value={renaming}
            onClick={(e) => e.stopPropagation()}
            onInput={(e) => setRenaming((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setRenaming(null);
              if (e.key !== 'Enter') return;
              const name = renaming.trim();
              setRenaming(null);
              if (name) void dispatch({ cmd: 'project.rename', id: p.id, name }).catch(() => undefined);
            }}
          />
        )}
        <Cmd dispatch={dispatch} cmd="project.rename" args={{ id: p.id, name: p.name }} title="project.rename" onRun={() => setRenaming(renaming === null ? p.name : null)}>
          rename
        </Cmd>
        <Cmd
          dispatch={dispatch}
          cmd="project.delete"
          class={confirming ? 'danger' : ''}
          args={{ id: p.id }}
          title={confirming ? 'there is no undo' : 'project.delete'}
          onRun={() => {
            if (!confirming) return setConfirming(true);
            setConfirming(false);
            void dispatch({ cmd: 'project.delete', id: p.id }).catch(() => undefined);
          }}
        >
          {confirming ? 'really delete' : 'delete'}
        </Cmd>
      </div>
    </div>
  );
}

/** Where a project goes, said in the capability line rather than discovered when one is lost. */
export function storageLine(s: Pick<UiState, 'project'>): string {
  if (s.project?.autosave === false) return 'saving is off — use Save as file';
  if (typeof indexedDB === 'undefined') return 'projects need browser storage; use Save as file';
  return 'projects saved in this browser';
}

/**
 * The start screen of issue #41, in the issue's own reading order: say what you want in words,
 * start a project, come back to one, open a file, browse examples, take a tutorial.
 *
 * The composer is a real input rather than a card that toggles a panel, because describing the
 * part is the thing a person is most likely to want. It opens the drawer and sends the line as
 * two Commands; with no API key the drawer answers by opening its Settings, and the line stays
 * here in the composer so nothing typed is lost.
 */
export function Start({ s, dispatch }: { s: UiState; dispatch: Dispatch }) {
  const [name, setName] = useState('model');
  const [ask, setAsk] = useState('');
  const [all, setAll] = useState(false);
  const recent = all ? s.projects : s.projects.slice(0, 6);
  const send = (): void => {
    if (!ask.trim()) return;
    void dispatch({ cmd: 'panel.toggle', panel: 'assistant', open: true })
      .then(() => dispatch({ cmd: 'chat.send', text: ask.trim() }))
      .catch(() => undefined);
  };
  return (
    <div class="start">
      <h1>
        <i /> FEM Lab
      </h1>
      <p class="pitch">A finite-element editor and solver in a browser tab. No install, no server, nothing leaves this page.</p>

      <div class="ask">
        <input
          class="ask-field"
          aria-label="describe the part"
          data-cmd="chat.send"
          placeholder="Describe the part — a 1 m steel cantilever, 50×100 mm, 10 kN at the tip…"
          value={ask}
          onInput={(e) => setAsk((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.preventDefault(), send());
          }}
        />
        <Cmd dispatch={dispatch} cmd="chat.send" class="ask-send" args={{ text: ask }} disabled={ask.trim() === ''} title="chat.send" onRun={send}>
          Send
        </Cmd>
      </div>
      <div class="ask-note">the Assistant builds it as visible Commands; you can take over at any step</div>

      <div class="section">
        <span class="section-head">New project</span>
        <div class="new-project">
          <input class="mono new-name" aria-label="project name" data-cmd="project.new" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          <Cmd dispatch={dispatch} cmd="project.new" opens="model.new" class="apply" args={{ name }} disabled={!s.ready} title="project.new">
            New project
          </Cmd>
          <span class="faint">an empty Model, saved from the first Command</span>
        </div>
      </div>

      <div class="section">
        <div class="section-head">
          <span>Recent projects</span>
          {s.projects.length > 6 ? (
            <span class="link show-all" role="button" tabIndex={0} onClick={() => setAll(!all)} onKeyDown={(e) => e.key === 'Enter' && setAll(!all)}>
              {all ? 'show six' : `show all (${s.projects.length})`}
            </span>
          ) : null}
        </div>
        {recent.length > 0 ? (
          <div class="recents">
            {recent.map((p) => (
              <RecentCard key={p.id} p={p} dispatch={dispatch} />
            ))}
          </div>
        ) : (
          <div class="faint no-projects">Projects you start are kept in this browser. Nothing is uploaded.</div>
        )}
      </div>

      <div class="cards">
        <Cmd dispatch={dispatch} cmd="file.open" class="card" args={{ picker: true }} title="file.open">
          <b>Open a file</b>
          <span>A femlab/1 file saved from here or from the CLI; it becomes a project when you edit it.</span>
          <i class="mono cue-cyan">file.open(picker)</i>
        </Cmd>
        <Cmd dispatch={dispatch} cmd="panel.toggle" class="card" args={{ panel: 'examples' }}>
          <b>Examples</b>
          <span>Worked benchmarks with reference values, each opened as its own Journal.</span>
          <i class="mono cue-cyan">panel.toggle(examples)</i>
        </Cmd>
        <Cmd dispatch={dispatch} cmd="panel.toggle" class="card" args={{ panel: 'tutorial' }}>
          <b>Tutorials</b>
          <span>Nine guided walks, one Command at a time with the reason for each: a cantilever, a plate with a hole, heat, modes, a convergence study.</span>
          <i class="mono">panel.toggle(tutorial)</i>
        </Cmd>
      </div>

      <div class="caps mono">
        {s.ready ? '●' : '○'} {s.hostCaps ? engineChip(s.hostCaps, s.engineCaps) : 'starting…'} · {s.hostCaps?.webgpu ? 'WebGPU available' : 'no WebGPU'} ·{' '}
        {s.hostCaps?.crossOriginIsolated ? 'cross-origin isolated' : 'not isolated'} · {storageLine(s)} · no server · nothing leaves the tab
      </div>
      {s.notes.length > 0 ? <div class="notes">{s.notes.join(' · ')}</div> : null}
      {s.lastError ? <div class="notes bad">{`${s.lastError.code}: ${s.lastError.cause}`}</div> : null}
    </div>
  );
}

/**
 * The same screen as an overlay, so the top bar's **Projects** button gets a person from a
 * workspace back to the list without a `project.close` Command having to exist.
 */
export function Projects({ s, dispatch }: { s: UiState; dispatch: Dispatch }) {
  if (s.panels['projects'] !== true) return null;
  return (
    <div class="overlay wide" onClick={() => void dispatch({ cmd: 'panel.toggle', panel: 'projects', open: false })}>
      <div class="projects-modal" role="dialog" aria-modal="true" aria-label="Projects" onClick={(e) => e.stopPropagation()}>
        <Cmd dispatch={dispatch} cmd="panel.toggle" class="tbutton close" args={{ panel: 'projects', open: false }}>
          ×
        </Cmd>
        <Start s={s} dispatch={dispatch} />
      </div>
    </div>
  );
}
