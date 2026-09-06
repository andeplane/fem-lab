// Every piece of view state the app has, as one plain object with plain reducers. No immer, no
// signals: host Commands call the reducers, components subscribe. The Model itself is never
// here — it lives in the engine and arrives as `query.model` snapshots.
import type { AutosaveState, Capabilities, JournalDump, ModelSummary, ObjectRef, ResultSummary, Selection, StudyReport, Warning } from '@femlab/registry';
import type { HostCaps } from './capabilities';
import type { ActiveBenchmark } from './benchmark';
import { getAt, setAt } from './ui/schema';
import type { ColormapName } from './viewer/colormap';

export type ViewMode = 'geometry' | 'mesh' | 'results';
export type Tab = 'journal' | 'script' | 'results' | 'checks' | 'console';
export const TABS: Tab[] = ['journal', 'script', 'results', 'checks', 'console'];

/** The Properties panel: which Command is being filled in, and the arguments so far. */
export interface FormState {
  cmd: string;
  values: Record<string, unknown>;
  /** What Revert goes back to: the values the form was opened with. */
  initial: Record<string, unknown>;
}
export type ConsoleLevel = 'command' | 'engine' | 'warn' | 'error' | 'result';
export interface ConsoleLine {
  level: ConsoleLevel;
  text: string;
  at: number;
}
export interface LastError {
  code: string;
  cause: string;
  where: string | null;
  suggestion: string | null;
}

export interface UiState {
  ready: boolean;
  /** What `query.autosave` last reported, so the start screen can offer `file.restore`. */
  autosave: AutosaveState['saved'];
  model: ModelSummary | null;
  journal: JournalDump | null;
  script: string;
  /** `query.model().revision` mirrored, so the tree header can show `rev N` without a query. */
  revision: number;
  selection: Selection;
  pickTarget: 'face' | 'body' | 'off';
  viewMode: ViewMode;
  colormap: ColormapName;
  deformScale: number;
  /** Panel id → open. Panels absent from the map are closed. */
  panels: Record<string, boolean>;
  tab: Tab;
  /** Every `@`-mentionable object, for the picker chips and the palette. */
  objects: ObjectRef[];
  form: FormState | null;
  /** The last failure of an Apply, so the form can put it under the field `where` names. */
  formError: LastError | null;
  /** Which form field the next viewer pick fills in, from "pick in viewer". */
  pickInto: string[] | null;
  /** Journal `seq` → who dispatched it and when. The UI is `you`; scripts and the AI are `ai`. */
  journalWho: Record<number, { who: 'you' | 'ai'; at: number }>;
  /** What the caller of `dispatch` currently counts as; the script host flips it to `ai`. */
  source: 'you' | 'ai';
  /** `null` while the Script tab shows the Journal; a string once it is being edited. */
  scriptDraft: string | null;
  scriptOut: string[];
  scriptRunning: boolean;
  hostCaps: HostCaps | null;
  engineCaps: Capabilities | null;
  notes: string[];
  console: ConsoleLine[];
  lastError: LastError | null;
  progress: { phase: string; fraction: number } | null;
  theme: 'dark' | 'light';
  /** `query.result` for the last solved Step; `stale` on it is the engine's own hash check. */
  result: ResultSummary | null;
  /** Metadata for the bundled example that produced this Model, retained while edits stale it. */
  benchmark: ActiveBenchmark | null;
  /** The Step a solve is running for, `null` when none is. */
  solving: string | null;
  /** Which scalar the viewer contours, as a `FIELD_CHOICES` key. */
  fieldKey: string;
  /** The contoured field's range and unit in display units, for the legend. */
  legend: { min: number; max: number; unit: string } | null;
  /** A manual clamp from `view.setLegend { range }`; `null` follows the data. */
  clamp: [number, number] | null;
  /** The last `study.converge` report, for the Results tab's convergence bars. */
  study: StudyReport | null;
  /** Every default the solve fell back on: the `warnings` of the solve's own Ack. */
  assumptions: Warning[];
  /** display = SI x this, for the one dimension the camera needs: length. */
  lengthFactor: number;
  /**
   * The smallest `yield` any Material in the Journal names, in SI pascals, or `null` when
   * none does. `query.model` does not carry it (MaterialRow has E, nu and rho), so it is read
   * back off the Journal's own `material.add` lines — the Journal is the Model (ADR 0003).
   * The smallest is the conservative one when several Materials disagree.
   */
  yieldStress: number | null;
  /** Whether the deformation is being swept (`view.animate`), for the ▶ / ❚❚ button. */
  playing: boolean;
  /** Where in one sweep the scrub sits, in turns 0…1. */
  phase: number;
  /** Pixels per CSS pixel a saved PNG is rendered at: the export dialog's 1× / 2×. */
  screenshotScale: number;
  /** True only while the current report Markdown and viewer figure are mounted and printable. */
  reportReady: boolean;
  /** Whether the section plane is in, so the toolbar's clip toggle knows which way to flip. */
  clipOn: boolean;
}

/** The design's states 4–7, as one word derived from what the store already holds. */
export type Stage = 'idle' | 'solving' | 'solved' | 'stale' | 'error';

export function stageOf(s: Pick<UiState, 'solving' | 'result' | 'lastError'>): Stage {
  if (s.solving !== null) return 'solving';
  if (s.lastError) return 'error';
  if (!s.result) return 'idle';
  return s.result.stale ? 'stale' : 'solved';
}

/** The Solve button's label: `Solve`, `Solving 47 %`, `Solved · rev 10`, `Re-solve`. */
export function solveLabel(stage: Stage, s: Pick<UiState, 'progress' | 'result'>): string {
  if (stage === 'solving') return `Solving ${Math.round((s.progress?.fraction ?? 0) * 100)} %`;
  if (stage === 'solved') return `Solved · rev ${s.result?.revision ?? 0}`;
  if (stage === 'stale') return 'Re-solve';
  return 'Solve';
}

export const EMPTY_SELECTION: Selection = { bodies: [], faces: [], sets: [], refs: [] };

export const initialState: UiState = {
  ready: false,
  autosave: null,
  model: null,
  journal: null,
  script: '',
  revision: 0,
  selection: EMPTY_SELECTION,
  pickTarget: 'face',
  viewMode: 'geometry',
  colormap: 'viridis',
  deformScale: 1,
  panels: { assistant: false, examples: false, export: false, report: false, palette: false },
  tab: 'journal',
  objects: [],
  form: null,
  formError: null,
  pickInto: null,
  journalWho: {},
  source: 'you',
  scriptDraft: null,
  scriptOut: [],
  scriptRunning: false,
  hostCaps: null,
  engineCaps: null,
  notes: [],
  console: [],
  lastError: null,
  progress: null,
  theme: 'dark',
  result: null,
  benchmark: null,
  solving: null,
  fieldKey: 'vonMises',
  legend: null,
  clamp: null,
  study: null,
  assumptions: [],
  lengthFactor: 1,
  clipOn: false,
  yieldStress: null,
  playing: false,
  phase: 0,
  screenshotScale: 1,
  reportReady: false,
};

const MAX_CONSOLE = 500;

const merge = (mode: 'replace' | 'add' | 'remove', cur: string[], next: string[] | undefined): string[] => {
  if (next === undefined) return mode === 'replace' ? [] : cur;
  if (mode === 'replace') return [...new Set(next)];
  if (mode === 'add') return [...new Set([...cur, ...next])];
  return cur.filter((n) => !next.includes(n));
};

/** `refs` is what `@selection` expands to; `face:` for faces and Sets alike (both are Sets). */
export function refsOf(s: Omit<Selection, 'refs'>): string[] {
  return [...s.bodies.map((n) => `body:${n}`), ...s.faces.map((n) => `face:${n}`), ...s.sets.map((n) => `set:${n}`)];
}

export function selectionReducer(cur: Selection, input: { bodies?: string[]; faces?: string[]; sets?: string[]; mode?: 'replace' | 'add' | 'remove' }): Selection {
  const mode = input.mode ?? 'replace';
  const next = {
    bodies: merge(mode, cur.bodies, input.bodies),
    faces: merge(mode, cur.faces, input.faces),
    sets: merge(mode, cur.sets, input.sets),
  };
  return { ...next, refs: refsOf(next) };
}

export function consoleReducer(lines: ConsoleLine[], line: ConsoleLine): ConsoleLine[] {
  const next = [...lines, line];
  return next.length > MAX_CONSOLE ? next.slice(next.length - MAX_CONSOLE) : next;
}

export function panelsReducer(panels: Record<string, boolean>, panel: string, open?: boolean): Record<string, boolean> {
  return { ...panels, [panel]: open ?? !panels[panel] };
}

export class Store {
  /**
   * The app's wrapped `dispatch` (main.tsx): journals, refreshes the tree, the viewer and the
   * results after a Command. Panels mounted outside the shell (the tutorial runner) go through
   * it so "do it for me" behaves exactly like a click on the real control (issue #37, #12).
   */
  dispatch: ((cmd: { cmd: string } & Record<string, unknown>) => Promise<unknown>) | null = null;
  private listeners = new Set<() => void>();

  constructor(public state: UiState = initialState) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  set(patch: Partial<UiState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  /**
   * Every pick, tree click and `selection.set` lands here, which is also where a pending
   * "pick in viewer" is spent: one place, so no caller can forget.
   */
  select(input: Parameters<typeof selectionReducer>[1]): void {
    const selection = selectionReducer(this.state.selection, input);
    const { pickInto, form } = this.state;
    const picked = selection.faces[0] ?? selection.sets[0] ?? selection.bodies[0];
    if (!pickInto || !picked || !form) return this.set({ selection });
    const current = getAt(form.values, pickInto);
    const next = Array.isArray(current) ? [...new Set([...current, picked])] : picked;
    this.set({ selection, pickInto: null, form: { ...form, values: setAt(form.values, pickInto, next) } });
  }

  /**
   * Open the Properties form on a Command, pre-filled with `values`. Every field edit comes
   * back through here with `keepInitial`, so Revert still knows where the form started.
   */
  openForm(cmd: string, values: Record<string, unknown> = {}, keepInitial = false): void {
    const initial = keepInitial && this.state.form?.cmd === cmd ? this.state.form.initial : values;
    this.set({ form: { cmd, values, initial }, formError: null, pickInto: null });
  }

  log(level: ConsoleLevel, text: string): void {
    this.set({ console: consoleReducer(this.state.console, { level, text, at: Date.now() }) });
  }

  /** The bottom tabs are panels too, so the tab strip needs no Command of its own. */
  togglePanel(panel: string, open?: boolean): void {
    if ((TABS as string[]).includes(panel)) return this.set({ tab: panel as Tab });
    this.set({ panels: panelsReducer(this.state.panels, panel, open) });
  }

  fail(e: unknown): void {
    const err = e as Partial<LastError> & { message?: string };
    const line: LastError = {
      code: err.code ?? 'internal',
      cause: err.cause ?? err.message ?? String(e),
      where: err.where ?? null,
      suggestion: err.suggestion ?? null,
    };
    this.set({ lastError: line });
    this.log('error', `${line.code}: ${line.cause}`);
  }
}
