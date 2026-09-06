// The bottom panel of docs/design/README.md: Journal, Script, Results, Checks, Console. The
// Journal is the Model (ADR 0003), so its rows carry the line number, the Command, its arguments,
// who issued it and when, with the undo boundary drawn under the solve that produced a Result.
import type { JournalEntry, ResultSummary } from '@femlab/registry';
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

/** The retained `solve.*` that produced the Result currently on screen. */
export function solveBoundary(entries: JournalEntry[], result: Pick<ResultSummary, 'step'> | null): number {
  if (!result) return -1;
  let seq = -1;
  for (const e of entries) {
    const cmd = e.cmd as unknown as { cmd: string; step?: string };
    if (cmd.cmd.startsWith('solve.') && cmd.step === result.step) seq = e.seq;
  }
  return seq;
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
        return (
          <div key={e.seq}>
            <Cmd dispatch={dispatch} cmd="clipboard.copy" class={stale ? 'jrow stale' : 'jrow'} args={{ what: { kind: 'text', text: commandLine(cmd) } }} title={commandLine(cmd)}>
              <span class="no">{e.seq}</span>
              <span class={cmd.cmd.startsWith('solve.') ? 'jcmd solve' : 'jcmd'}>{cmd.cmd}</span>
              <span class="jargs">{argText(cmd)}</span>
              <span class="jwho">{meta?.who ?? 'you'}</span>
              <span class="jtime">{clock(meta?.at)}</span>
            </Cmd>
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
