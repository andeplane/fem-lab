// The bottom panel of docs/design/README.md: Journal, Script, Results, Checks, Console. The
// Journal is the Model (ADR 0003), so its rows carry the line number, the Command, its arguments,
// who issued it and when, with the undo boundary drawn under the solve that produced a Result.
import type { JournalEntry, ModelSummary, ResultSummary } from '@femlab/registry';
import type { Store, Tab, UiState } from '../store';
import { TABS } from '../store';
import { Checks, Results } from './Results';
import type { Query } from './SchemaForm';
import { Cmd, type Dispatch } from './cmd';
import { commandLine } from './schema';

const argText = (cmd: Record<string, unknown>): string => {
  const { cmd: _name, ...rest } = cmd;
  const text = JSON.stringify(rest);
  return text.length > 110 ? `${text.slice(0, 109)}…` : text;
};

const clock = (at: number | undefined): string => (at === undefined ? '' : new Date(at).toTimeString().slice(0, 8));

type ViewerTarget = { bodies?: string[]; faces?: string[]; sets?: string[] };
export interface JournalTarget {
  /** The live Model object the Journal Command refers to. */
  ref: string;
  /** Its drawable body or face names, accepted by both selection.set and view.highlight. */
  view: ViewerTarget;
}

const liveBodies = (names: unknown, model: ModelSummary): string[] => {
  if (!Array.isArray(names)) return [];
  const current = new Set(model.bodies.map((body) => body.name));
  return names.filter((name): name is string => typeof name === 'string' && current.has(name));
};

const surfaceTarget = (name: unknown, model: ModelSummary): ViewerTarget | null => {
  if (typeof name !== 'string') return null;
  if (model.sets.some((set) => set.name === name && set.kind === 'face')) return { sets: [name] };
  return model.bodies.some((body) => body.faces.includes(name)) ? { faces: [name] } : null;
};

/** Resolve only an explicit Command target that still exists and has something drawable. */
export function journalTarget(cmd: Record<string, unknown>, model: ModelSummary | null): JournalTarget | null {
  if (!model || typeof cmd.cmd !== 'string') return null;
  const named = (kind: string, name: unknown): JournalTarget | null => {
    if (typeof name !== 'string') return null;
    if (kind === 'body') return model.bodies.some((body) => body.name === name) ? { ref: `body:${name}`, view: { bodies: [name] } } : null;
    if (kind === 'set') {
      const view = surfaceTarget(name, model);
      return view ? { ref: `set:${name}`, view } : null;
    }
    if (kind === 'material') {
      const material = model.materials.find((item) => item.name === name);
      const bodies = liveBodies(material?.assignedTo, model);
      return material && bodies.length > 0 ? { ref: `material:${name}`, view: { bodies } } : null;
    }
    if (kind === 'constraint') {
      const constraint = model.constraints.find((item) => item.name === name);
      const view = surfaceTarget(constraint?.on, model);
      return constraint && view ? { ref: `constraint:${name}`, view } : null;
    }
    if (kind === 'load') {
      const load = model.loads.find((item) => item.name === name);
      const view = surfaceTarget(load?.on, model);
      return load && view ? { ref: `load:${name}`, view } : null;
    }
    return null;
  };

  if (cmd.cmd === 'model.rename') return named(String(cmd.kind ?? ''), cmd.to);
  if (cmd.cmd === 'model.duplicate') return named(String(cmd.kind ?? ''), cmd.as);
  if (cmd.cmd === 'geometry.addBox' || cmd.cmd === 'geometry.add') return named('body', cmd.name);
  if (cmd.cmd === 'geometry.subtractBox' || cmd.cmd === 'geometry.subtract') return named('body', cmd.from);
  if (cmd.cmd === 'geometry.nameFace' || cmd.cmd === 'geometry.nameRegion') return named('set', cmd.name);
  if (cmd.cmd === 'material.add') return named('material', cmd.name);
  if (cmd.cmd === 'material.assign') {
    const material = typeof cmd.material === 'string' && model.materials.some((item) => item.name === cmd.material) ? cmd.material : null;
    const bodies = liveBodies(cmd.bodies, model);
    return material && bodies.length > 0 ? { ref: `material:${material}`, view: { bodies } } : null;
  }
  if (cmd.cmd.startsWith('constraint.') && cmd.cmd !== 'constraint.remove') return named('constraint', cmd.name);
  if (cmd.cmd.startsWith('load.') && cmd.cmd !== 'load.remove') {
    const bySurface = named('load', cmd.name);
    if (bySurface) return bySurface;
    const load = typeof cmd.name === 'string' && model.loads.some((item) => item.name === cmd.name) ? cmd.name : null;
    const bodies = liveBodies(cmd.bodies, model);
    return load && bodies.length > 0 ? { ref: `load:${load}`, view: { bodies } } : null;
  }
  return null;
}

/** The retained solve or non-restoring convergence study that produced the Result on screen. */
export function solveBoundary(entries: JournalEntry[], result: Pick<ResultSummary, 'step' | 'revision'> | null): number {
  if (!result) return -1;
  const entry = entries.find((e) => e.seq === result.revision);
  if (!entry) return -1;
  const cmd = entry.cmd as unknown as { cmd: string; step?: string; restore?: boolean };
  const producesResult = cmd.cmd === 'solve.run' || (cmd.cmd === 'study.converge' && cmd.restore === false);
  return producesResult && cmd.step === result.step ? entry.seq : -1;
}

function Journal({ s, dispatch }: { s: UiState; dispatch: Dispatch }) {
  const entries = s.journal?.entries ?? [];
  const boundary = solveBoundary(entries, s.result);
  // Rows after the solve are only "stale" once the engine says the Result is: an export or a
  // camera move after a solve changes nothing the Result depends on.
  const staleBoundary = s.result?.stale === true ? boundary : -1;
  return (
    <div class="rows">
      {entries.map((e) => {
        const cmd = e.cmd as unknown as Record<string, unknown> & { cmd: string };
        const meta = s.journalWho[e.seq];
        const stale = staleBoundary >= 0 && e.seq > staleBoundary;
        const target = journalTarget(cmd, s.model);
        const highlight = (on: boolean) => void dispatch({ cmd: 'view.highlight', ...(on && target ? target.view : {}) }).catch(() => undefined);
        return (
          <div key={e.seq}>
            <div
              class={stale ? 'jrow stale' : 'jrow'}
              data-target-ref={target?.ref}
              onMouseEnter={() => target && highlight(true)}
              onMouseLeave={(event) => target && !event.currentTarget.contains(document.activeElement) && highlight(false)}
            >
              <Cmd
                dispatch={dispatch}
                cmd="selection.set"
                class="jrow-main"
                args={target?.view}
                disabled={!target}
                title={target ? `Select ${target.ref}` : 'This Command has no current object that can be shown in the viewer'}
                onFocus={() => target && highlight(true)}
                onBlur={() => target && highlight(false)}
              >
                <span class="no">{e.seq}</span>
                <span class={cmd.cmd.startsWith('solve.') ? 'jcmd solve' : 'jcmd'}>{cmd.cmd}</span>
                <span class="jargs">{argText(cmd)}</span>
                <span class="jwho">{meta?.who ?? 'you'}</span>
                <span class="jtime">{clock(meta?.at)}</span>
              </Cmd>
              <Cmd dispatch={dispatch} cmd="clipboard.copy" class="jcopy" args={{ what: { kind: 'text', text: commandLine(cmd) } }} title={`Copy ${cmd.cmd} as script`}>
                Copy
              </Cmd>
            </div>
            {e.seq === boundary ? (
              <div class="boundary">
                <span class="rule" />
                <span class="section-label">Result produced here · undo boundary</span>
                <span class="rule" />
              </div>
            ) : null}
          </div>
        );
      })}
      {entries.length === 0 ? <div class="empty-note">The Journal is empty. Every Command you apply lands here, and the Script tab shows the same thing as TypeScript.</div> : null}
    </div>
  );
}

function Script({ s, store, dispatch }: { s: UiState; store: Store; dispatch: Dispatch }) {
  const text = s.scriptDraft ?? s.script;
  const editing = s.scriptDraft !== null;
  return (
    <div class="script">
      {editing ? (
        <textarea class="mono script-edit" value={text} data-cmd="script.setSource" onInput={(e) => store.set({ scriptDraft: (e.target as HTMLTextAreaElement).value })} />
      ) : (
        <div class="script-view">
          {text.split('\n').map((line, i) => (
            <div key={i} class="sline">
              <span class="no">{i + 1}</span>
              <span class={line.startsWith('//') ? 'mono faint' : 'mono'}>{line}</span>
            </div>
          ))}
        </div>
      )}
      <div class="script-rail">
        <div class="section-label">Run</div>
        <Cmd dispatch={dispatch} cmd="script.run" class="apply" args={{ code: text }} disabled={s.scriptRunning}>
          ▶ Run script
        </Cmd>
        <Cmd dispatch={dispatch} cmd="script.stop" class="tbutton outline" disabled={!s.scriptRunning}>
          ■ Stop
        </Cmd>
        <Cmd dispatch={dispatch} cmd="script.setSource" class="tbutton outline" args={{ code: text }} onRun={() => store.set({ scriptDraft: editing ? null : text })}>
          {editing ? 'view the Journal' : 'edit this script'}
        </Cmd>
        <div class="script-out mono">
          {s.scriptOut.map((line, i) => (
            <div key={i} class={line.startsWith('✕') ? 'bad' : ''}>
              {line}
            </div>
          ))}
        </div>
        <div class="rule-note">The Journal, typed. Edit a line, run it again, and the Model replays from there.</div>
      </div>
    </div>
  );
}

export function Bottom({ s, store, dispatch, query }: { s: UiState; store: Store; dispatch: Dispatch; query: Query }) {
  const counts: Record<Tab, string> = {
    journal: String(s.journal?.entries.length ?? 0),
    script: 'ts',
    results: s.result ? (s.result.stale ? 'stale' : String(s.result.extremes.length)) : '—',
    checks: String((s.model?.warnings.length ?? 0) || 'ok'),
    console: String(s.console.length),
  };
  return (
    <section class="bottom">
      <div class="tabs" role="tablist" aria-label="results panel">
        {TABS.map((t) => (
          <Cmd key={t} dispatch={dispatch} cmd="panel.toggle" class={s.tab === t ? 'tab active' : 'tab'} args={{ panel: t, open: true }} title={`panel.toggle ${t}`} role="tab" selected={s.tab === t}>
            {t}
            <span class="count mono">{counts[t]}</span>
          </Cmd>
        ))}
        <span class="spacer" />
        <Cmd dispatch={dispatch} cmd="clipboard.copy" class="tbutton" args={{ what: { kind: 'script' } }}>
          copy
        </Cmd>
        <Cmd dispatch={dispatch} cmd="file.export" class="tbutton" args={{ spec: { format: 'script' } }}>
          download .ts
        </Cmd>
      </div>
      <div class="bottom-body">
        {s.tab === 'journal' ? <Journal s={s} dispatch={dispatch} /> : null}
        {s.tab === 'script' ? <Script s={s} store={store} dispatch={dispatch} /> : null}
        {s.tab === 'results' ? <Results s={s} dispatch={dispatch} query={query} /> : null}
        {s.tab === 'checks' ? <Checks s={s} dispatch={dispatch} query={query} /> : null}
        {s.tab === 'console' ? (
          <div class="rows">
            {s.console.map((l, i) => (
              <div key={i} class="crow mono">
                <span class="no">{clock(l.at)}</span>
                <span class={`lvl-${l.level}`}>{l.level}</span>
                <span>{l.text}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
