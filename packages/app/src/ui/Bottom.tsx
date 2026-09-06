// The bottom panel of docs/design/README.md: Journal, Script, Results, Checks, Console. The
// Journal is the Model (ADR 0003), so its rows carry the line number, the Command, its arguments,
// who issued it and when, with the undo boundary drawn under the solve that produced a Result.
import type { JournalEntry, ModelSummary, ObjectRef, ResultSummary } from '@femlab/registry';
import { useEffect, useLayoutEffect } from 'preact/hooks';
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
  /** The separate drawable target; Steps and other semantic objects may not have one. */
  highlight: ViewerTarget | null;
}

const liveBodies = (names: unknown, model: ModelSummary): string[] => {
  if (!Array.isArray(names)) return [];
  const current = new Set(model.bodies.map((body) => body.name));
  return names.filter((name): name is string => typeof name === 'string' && current.has(name));
};

/** Resolve an explicit Command target against `query.objects`; derive its viewer highlight separately. */
export function journalTarget(cmd: Record<string, unknown>, model: ModelSummary | null, objects: ObjectRef[]): JournalTarget | null {
  if (!model || typeof cmd.cmd !== 'string') return null;
  const named = (kind: string, name: unknown): JournalTarget | null => {
    if (typeof name !== 'string') return null;
    const object = objects.find((item) => item.kind === kind && item.name === name);
    if (!object) return null;
    if (kind === 'body') return { ref: object.ref, highlight: { bodies: [name] } };
    if (kind === 'set') return { ref: object.ref, highlight: model.sets.some((set) => set.name === name && set.kind === 'face') ? { sets: [name] } : null };
    if (kind === 'material') {
      const material = model.materials.find((item) => item.name === name);
      const bodies = liveBodies(material?.assignedTo, model);
      return { ref: object.ref, highlight: material && bodies.length > 0 ? { bodies } : null };
    }
    if (kind === 'constraint') {
      const constraint = model.constraints.find((item) => item.name === name);
      return { ref: object.ref, highlight: constraint ? { sets: [constraint.on] } : null };
    }
    if (kind === 'load') {
      const load = model.loads.find((item) => item.name === name);
      const bodies = liveBodies(cmd.bodies, model);
      return { ref: object.ref, highlight: load?.on ? { sets: [load.on] } : bodies.length > 0 ? { bodies } : null };
    }
    return { ref: object.ref, highlight: null };
  };

  if (cmd.cmd === 'model.rename') return named(String(cmd.kind ?? ''), cmd.to);
  if (cmd.cmd === 'model.duplicate') return named(String(cmd.kind ?? ''), cmd.as);
  if (cmd.cmd === 'geometry.addBox' || cmd.cmd === 'geometry.add') return named('body', cmd.name);
  if (cmd.cmd === 'geometry.subtractBox' || cmd.cmd === 'geometry.subtract') return named('set', cmd.name);
  if (cmd.cmd === 'geometry.nameFace' || cmd.cmd === 'geometry.nameRegion') return named('set', cmd.name);
  if (cmd.cmd === 'material.add') return named('material', cmd.name);
  if (cmd.cmd === 'material.assign') return named('material', cmd.material);
  if (cmd.cmd.startsWith('constraint.') && cmd.cmd !== 'constraint.remove') return named('constraint', cmd.name);
  if (cmd.cmd.startsWith('load.') && cmd.cmd !== 'load.remove') return named('load', cmd.name);
  if (cmd.cmd === 'step.add') return named('step', cmd.name);
  return null;
}

/** The retained producer: Result revision counts Commands; Journal seq is zero-based. */
export function solveBoundary(entries: JournalEntry[], result: Pick<ResultSummary, 'step' | 'revision'> | null): number {
  if (!result) return -1;
  const entry = entries.find((e) => e.seq + 1 === result.revision);
  if (!entry) return -1;
  const cmd = entry.cmd as unknown as { cmd: string; step?: string; restore?: boolean };
  const producesResult = cmd.cmd === 'solve.run' || (cmd.cmd === 'study.converge' && cmd.restore === false);
  return producesResult && cmd.step === result.step ? entry.seq : -1;
}

function JournalRow({ s, dispatch, entry, className = '', removed = false }: { s: UiState; dispatch: Dispatch; entry: JournalEntry; className?: string; removed?: boolean }) {
  const e = entry;
  const cmd = e.cmd as unknown as Record<string, unknown> & { cmd: string };
  const meta = removed ? undefined : s.journalWho[e.seq];
  const boundary = removed ? -1 : solveBoundary(s.journal?.entries ?? [], s.result);
  const stale = s.result?.stale === true && boundary >= 0 && e.seq > boundary;
  const target = removed ? null : journalTarget(cmd, s.model, s.objects);
  const highlight = (on: boolean) => void dispatch({ cmd: 'view.highlight', ...(on && target?.highlight ? target.highlight : {}) }).catch(() => undefined);
  return (
    <div class={className}>
      <div
        class={stale ? 'jrow stale' : 'jrow'}
        data-target-ref={target?.ref}
        onMouseEnter={() => target?.highlight && highlight(true)}
        onMouseLeave={(event) => target?.highlight && !event.currentTarget.contains(document.activeElement) && highlight(false)}
      >
        <Cmd
          dispatch={dispatch}
          cmd="selection.set"
          class="jrow-main"
          args={target ? { refs: [target.ref] } : undefined}
          disabled={!target}
          title={target ? `Select ${target.ref}` : 'This Command has no object in the current Model'}
          onFocus={() => target?.highlight && highlight(true)}
          onBlur={() => target?.highlight && highlight(false)}
        >
          <span class="no">{e.seq}</span>
          <span class={cmd.cmd.startsWith('solve.') ? 'jcmd solve' : 'jcmd'}>{cmd.cmd}</span>
          <span class="jargs">{argText(cmd)}</span>
          <span class="jwho">{meta?.who ?? (removed ? 'unknown' : 'you')}</span>
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
}

function Journal({ s, dispatch }: { s: UiState; dispatch: Dispatch }) {
  const entries = s.journal?.entries ?? [];
  useLayoutEffect(() => () => void dispatch({ cmd: 'view.highlight' }).catch(() => undefined), [dispatch, s.model?.revision]);
  return (
    <div class="rows">
      {s.journalComparison ? <div class="section-label comparison-label">{s.comparisonSource === 'imported' ? 'Compared file' : 'Since last explicit save/open'}</div> : null}
      {entries.map((e, index) => <JournalRow key={index} s={s} dispatch={dispatch} entry={e} className={s.journalComparison && index >= s.journalComparison.sharedEntries ? 'comparison-added' : ''} />)}
      {s.journalComparison && s.journalComparison.removed.length > 0 ? (
        <>
          <div class="section-label comparison-removed-label">Removed from comparison baseline</div>
          {s.journalComparison.removed.map((e, index) => <JournalRow key={`removed-${index}`} s={s} dispatch={dispatch} entry={e} className="comparison-removed" removed />)}
        </>
      ) : null}
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

function History({ s, dispatch }: { s: UiState; dispatch: Dispatch }) {
  return (
    <div class="rows" aria-label="autosave history">
      <div class="section-label">Saved Journal revisions · newest first</div>
      {s.autosaves.map((revision) => (
        <Cmd key={revision.id} dispatch={dispatch} cmd="file.restore" class="jrow" args={{ id: revision.id }} title={`file.restore ${revision.id}`}>
          <span class="no">{revision.commands}</span>
          <span class="jcmd">{revision.name}</span>
          <span class="jargs">{revision.commands} Commands</span>
          <span class="jwho">autosave</span>
          <span class="jtime">{new Date(revision.at).toLocaleString()}</span>
        </Cmd>
      ))}
      {s.autosaves.length === 0 ? <div class="empty-note">No saved Journal revisions yet. Apply a Command with autosave enabled to create one.</div> : null}
    </div>
  );
}

export function Bottom({ s, store, dispatch, query }: { s: UiState; store: Store; dispatch: Dispatch; query: Query }) {
  useEffect(() => {
    if (s.tab !== 'journal') void dispatch({ cmd: 'view.highlight' }).catch(() => undefined);
  }, [dispatch, s.tab]);
  const counts: Record<Tab, string> = {
    journal: String(s.journal?.entries.length ?? 0),
    history: String(s.autosaves.length),
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
        {s.tab === 'history' ? <History s={s} dispatch={dispatch} /> : null}
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
