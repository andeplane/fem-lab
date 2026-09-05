// Every piece of view state the app has, as one plain object with plain reducers. No immer, no
// signals: host Commands call the reducers, components subscribe. The Model itself is never
// here — it lives in the engine and arrives as `query.model` snapshots.
import type { Capabilities, JournalDump, ModelSummary, ObjectRef, Selection } from '@femlab/registry';
import type { HostCaps } from './capabilities';
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
}

export const EMPTY_SELECTION: Selection = { bodies: [], faces: [], sets: [], refs: [] };

export const initialState: UiState = {
  ready: false,
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
