// Every piece of view state the app has, as one plain object with plain reducers. No immer, no
// signals: host Commands call the reducers, components subscribe. The Model itself is never
// here — it lives in the engine and arrives as `query.model` snapshots.
import type { Capabilities, JournalDump, ModelSummary, Selection } from '@femlab/registry';
import type { HostCaps } from './capabilities';
import type { ColormapName } from './viewer/colormap';

export type ViewMode = 'geometry' | 'mesh' | 'results';
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
  tab: 'journal' | 'script' | 'console';
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
  panels: { assistant: false, examples: false, export: false, report: false },
  tab: 'journal',
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

  select(input: Parameters<typeof selectionReducer>[1]): void {
    this.set({ selection: selectionReducer(this.state.selection, input) });
  }

  log(level: ConsoleLevel, text: string): void {
    this.set({ console: consoleReducer(this.state.console, { level, text, at: Date.now() }) });
  }

  /** The bottom tabs are panels too, so the tab strip needs no Command of its own. */
  togglePanel(panel: string, open?: boolean): void {
    if (panel === 'journal' || panel === 'script' || panel === 'console') return this.set({ tab: panel });
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
