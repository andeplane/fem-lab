// Every piece of view state the app has, as one plain object with plain reducers. No immer, no
// signals: host Commands call the reducers, components subscribe. The Model itself is never
// here — it lives in the engine and arrives as `query.model` snapshots.
import type { AdaptReport, AutosaveState, AutosaveVersion, Capabilities, Journal, JournalDiff, JournalDump, ModelSummary, ObjectRef, OpenProject, ProjectMeta, ResultSummary, Selection, Skill, StudyReport, Warning } from '@femlab/registry';
import type { PaletteIntent } from './ai/palette-intent';
import type { HostCaps } from './capabilities';
import type { ActiveBenchmark } from './benchmark';
import { projectSkills, type ProjectFolder } from './ai/project';
import { BUILTIN_SKILLS } from './ai/skills';
import { TABS, type Tab } from './ui/tabs';
import { getAt, setAt } from './ui/schema';
import type { ColormapName } from './viewer/colormap';
import type { TransientState } from './transient';

/** Content identity, independent of JSON object-key order and view-only state. */
export function journalIdentity(entries: JournalDump['entries']): string {
  return JSON.stringify(entries, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value);
}

export function unsaved(s: UiState): boolean {
  return s.journal !== null && s.journal.entries.length > 0 && journalIdentity(s.journal.entries) !== s.savedJournal;
}

export type ViewMode = 'geometry' | 'mesh' | 'results';
export { TABS, type Tab } from './ui/tabs';

export type ResizablePanel = 'tree' | 'properties' | 'bottom' | 'assistant';
export type PanelSizes = Record<ResizablePanel, number>;
export const DEFAULT_PANEL_SIZES: PanelSizes = { tree: 274, properties: 308, bottom: 252, assistant: 392 };
export const PANEL_SIZE_LIMITS: Record<ResizablePanel, { min: number; max: number }> = {
  tree: { min: 180, max: 420 },
  properties: { min: 240, max: 440 },
  bottom: { min: 184, max: 480 },
  assistant: { min: 320, max: 520 },
};
export function clampPanelSize(panel: ResizablePanel, size: number): number {
  const limits = PANEL_SIZE_LIMITS[panel];
  return Math.round(Math.min(limits.max, Math.max(limits.min, size)));
}
/** The Properties panel: which Command is being filled in, and the arguments so far. */
export interface FormState {
  cmd: string;
  values: Record<string, unknown>;
  /** What Revert goes back to: the values the form was opened with. */
  initial: Record<string, unknown>;
}
export type ConsoleLevel = 'command' | 'engine' | 'warn' | 'error' | 'result';
export type ExampleDifficulty = 1 | 2 | 3;
export interface ExampleFilter {
  tag: string | null;
  difficulty: ExampleDifficulty | null;
}
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

/** Assistant-authored observations, never engine measurements or a solver acceptance gate. */
export interface AssistantVerification {
  rows: { status: 'ok' | 'warn' | 'fail'; what: string; value: string }[];
  model: string | null;
  revision: number;
  journalHash: string | null;
  result: { step: string; revision: number } | null;
}

export function verificationState(record: AssistantVerification, state: UiState): string {
  if (!record.journalHash || !state.journal?.hash) return 'Model revision unconfirmed';
  if (record.journalHash !== state.journal.hash || record.model !== (state.model?.name ?? null) || record.revision !== state.revision || (record.result === null ? state.result !== null : state.result?.stale || record.result.step !== state.result?.step || record.result.revision !== state.result?.revision)) return 'Stale — Model or Result changed';
  return `Recorded at Model rev ${record.revision}${record.result ? ` · Result ${record.result.step} rev ${record.result.revision}` : ' · no Result'}`;
}

export interface UiState {
  assistantVerifications: AssistantVerification[];

  autosave: AutosaveState['saved'];
  autosaves: AutosaveVersion[];
  /** Session mirror of the ai.setModel host Command, shared with the Assistant. */
  assistantModel: string | null;
  paletteIntent: PaletteIntent | null;
  /** The opened browser folder, shared by Assistant skill discovery and host Commands. */
  folder: ProjectFolder | null;
  /** One available catalog; project skills override built-ins by name. */
  skills: Skill[];
  ready: boolean;
  model: ModelSummary | null;
  journal: JournalDump | null;
  /** Exact normalized Journal of the last successful explicit open/save; autosave is separate. */
  savedJournal: string | null;
  /** The complete normalized baseline, retained so comparison can show removed entries too. */
  savedBaseline: JournalDump['entries'] | null;
  /** Current-vs-baseline causal diff, or an explicitly imported comparison. */
  journalComparison: JournalDiff | null;
  comparisonSource: 'saved' | 'imported' | null;
  /** Imported comparison baseline, retained so a later refresh can recompute it read-only. */
  comparisonBaseline: JournalDump['entries'] | null;
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
  /** The Examples gallery's two independent, registry-driven filters. */
  exampleFilter: ExampleFilter;
  /** View-only panel dimensions in CSS pixels; resizing never changes the Model or Journal. */
  panelSizes: PanelSizes;
  /** Body names hidden only in the viewer by `view.setVisible`; the Model is unchanged. */
  hiddenBodies: string[];
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
  /** An intentional draft survives switching back to the live Journal script. */
  scriptDraft: string | null;
  /** Whether the Script tab is showing the draft editor or the live Journal script. */
  scriptEditing: boolean;
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
  /** The last adaptive study, shown only with its retained Result. */
  adaptation: AdaptReport | null;
  /** Every default the solve fell back on: the `warnings` of the solve's own Ack. */
  assumptions: Warning[];
  /** display = SI x this, for the one dimension the camera needs: length. */
  lengthFactor: number;
  /**
   * The smallest yield in the current `query.model` material rows, converted from their
   * display units to SI pascals, or `null` when no Material specifies a positive yield.
   * The smallest is the conservative one when several Materials disagree.
   */
  yieldStress: number | null;
  /** Whether the deformation is being swept (`view.animate`), for the ▶ / ❚❚ button. */
  playing: boolean;
  /** Where in one sweep the scrub sits, in turns 0…1. */
  phase: number;
  /** True while Chromium is encoding the viewer canvas as WebM. */
  capturingAnimation: boolean;
  /** Pixels per CSS pixel a saved PNG is rendered at: the export dialog's 1× / 2×. */
  screenshotScale: number;
  animationSpeed: number;
  /** True only while the current report Markdown and viewer figure are mounted and printable. */
  reportReady: boolean;
  /** The retained physical frame shared by contours, deformation, legend and scientific probes. */
  transient: TransientState | null;
  /** Whether the section plane is in, so the toolbar's clip toggle knows which way to flip. */
  clipOn: boolean;
  /** Viewer layer visibility, mirrored from the Viewer so toolbar pressed state follows Commands. */
  layerVisibility: Record<string, boolean>;
  // --- plan D ---------------------------------------------------------------------------
  /** `query.projects`: every project saved in this browser, newest first (the Recent list). */
  projects: ProjectMeta[];
  /** `query.project`: the open project and whether a write is in flight; `null` before one. */
  project: OpenProject | null;
  /**
   * `data-field` path → the value the running tutorial step expects there, which `SchemaForm`
   * shows as that input's `placeholder` (issue #46). The tutorial module never reaches into
   * `src/ui/**`; this field is the whole of the dependency, and it points one way.
   */
  formHints: Record<string, string> | null;
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
  assistantVerifications: [],

  autosave: null,
  autosaves: [],
  assistantModel: null,
  paletteIntent: null,
  folder: null,
  skills: BUILTIN_SKILLS,
  ready: false,
  model: null,
  journal: null,
  savedJournal: null,
  savedBaseline: null,
  journalComparison: null,
  comparisonSource: null,
  comparisonBaseline: null,
  script: '',
  revision: 0,
  selection: EMPTY_SELECTION,
  pickTarget: 'face',
  viewMode: 'geometry',
  colormap: 'viridis',
  deformScale: 1,
  panels: {
    assistant: false,
    examples: false,
    export: false,
    report: false,
    palette: false,
    'tree.geometry': true,
    'tree.materials': true,
    'tree.mesh': true,
    'tree.constraints': true,
    'tree.loads': true,
    'tree.steps': true,
    'tree.results': true,
    'tree.plugins': true,
  },
  panelSizes: { ...DEFAULT_PANEL_SIZES },
  hiddenBodies: [],
  exampleFilter: { tag: null, difficulty: null },
  tab: 'journal',
  objects: [],
  form: null,
  formError: null,
  pickInto: null,
  journalWho: {},
  source: 'you',
  scriptDraft: null,
  scriptEditing: false,
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
  adaptation: null,
  assumptions: [],
  lengthFactor: 1,
  clipOn: false,
  layerVisibility: { mesh: true, edges: true, loads: true, constraints: true, sets: true, legend: true, axes: true, grid: true },
  yieldStress: null,
  playing: false,
  phase: 0,
  capturingAnimation: false,
  screenshotScale: 1,
  animationSpeed: 1,
  reportReady: false,
  // --- plan D ---
  projects: [],
  project: null,
  formHints: null,
  transient: null,
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

export function selectionReducer(cur: Selection, input: { refs?: string[]; bodies?: string[]; faces?: string[]; sets?: string[]; mode?: 'replace' | 'add' | 'remove' }): Selection {
  const mode = input.mode ?? 'replace';
  const supplied = [...(input.refs ?? []), ...refsOf({ bodies: input.bodies ?? [], faces: input.faces ?? [], sets: input.sets ?? [] })];
  const refs = merge(mode, cur.refs, supplied);
  const names = (kind: string) => refs.filter((ref) => ref.startsWith(`${kind}:`)).map((ref) => ref.slice(kind.length + 1));
  return { bodies: names('body'), faces: names('face'), sets: names('set'), refs };
}

export function consoleReducer(lines: ConsoleLine[], line: ConsoleLine): ConsoleLine[] {
  const next = [...lines, line];
  return next.length > MAX_CONSOLE ? next.slice(next.length - MAX_CONSOLE) : next;
}

export function panelsReducer(panels: Record<string, boolean>, panel: string, open?: boolean): Record<string, boolean> {
  const nextOpen = open ?? !panels[panel];
  if (!panel.startsWith('tree.menu.') || !nextOpen) return { ...panels, [panel]: nextOpen };
  const next = { ...panels };
  for (const key of Object.keys(next)) if (key.startsWith('tree.menu.')) next[key] = false;
  next[panel] = true;
  return next;
}

export function visibilityReducer(hidden: string[], bodies: string[], on: boolean): string[] {
  if (on) return hidden.filter((body) => !bodies.includes(body));
  return [...new Set([...hidden, ...bodies])];
}

export class Store {
  /**
   * The app's wrapped `dispatch` (main.tsx): journals, refreshes the tree, the viewer and the
   * results after a Command. Panels mounted outside the shell (the tutorial runner) go through
   * it so "do it for me" behaves exactly like a click on the real control (issue #37, #12).
   */
  dispatch: ((cmd: { cmd: string } & Record<string, unknown>) => Promise<unknown>) | null = null;
  private comparisonRequest = 0;
  private documentIdentity = {};
  private journalDiffQuery: ((base: Journal) => Promise<JournalDiff>) | null = null;
  private listeners = new Set<() => void>();

  constructor(public state: UiState = structuredClone(initialState)) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Publish a fresh catalog even when refresh mutated the same ProjectFolder instance. */
  setFolder(folder: ProjectFolder | null): void {
    this.set({ folder, skills: projectSkills(BUILTIN_SKILLS, folder) });
  }

  set(patch: Partial<UiState>): void {
    // A comparison belongs to the complete current Journal; do not draw an old tail while
    // refresh is waiting for the next query reply.
    if (patch.journal && patch.journal !== this.state.journal && !('journalComparison' in patch)) {
      patch = { ...patch, journalComparison: null };
    }
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  setJournalDiffQuery(query: (base: Journal) => Promise<JournalDiff>): void {
    this.journalDiffQuery = query;
  }

  /** A reply may draw only while its request, current Journal and baseline selection still match. */
  beginJournalComparison(): (diff?: JournalDiff) => boolean {
    const request = ++this.comparisonRequest;
    const { journal, savedBaseline, comparisonBaseline, comparisonSource } = this.state;
    return diff => request === this.comparisonRequest && journal === this.state.journal
      && savedBaseline === this.state.savedBaseline && comparisonBaseline === this.state.comparisonBaseline
      && comparisonSource === this.state.comparisonSource
      // The live engine may advance before the displayed Journal finishes hydration.
      && (diff === undefined || diff.currentHash === journal?.hash);
  }

  async refreshJournalComparison(): Promise<JournalDiff | null> {
    const source = this.state.comparisonSource === 'imported' ? 'imported' : 'saved';
    const entries = source === 'imported' ? this.state.comparisonBaseline : this.state.savedBaseline;
    const current = this.beginJournalComparison();
    if (!entries || !this.journalDiffQuery) return null;
    try {
      const diff = await this.journalDiffQuery({ entries });
      if (!current(diff)) return null;
      this.set({ journalComparison: diff, comparisonSource: source });
      return diff;
    } catch (error) {
      if (!current()) return null;
      throw error;
    }
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

  /** Capture before I/O; ordinary edits keep this identity, replacing the Model does not. */
  beginSave(): (journal: { entries: JournalDump['entries'] }) => void {
    const identity = this.documentIdentity;
    return journal => {
      if (identity === this.documentIdentity) this.markSaved(journal);
    };
  }

  /** A successful explicit open owns a new document and its normalized saved baseline. */
  markOpened(journal: { entries: JournalDump['entries'] }): void {
    this.documentIdentity = {};
    this.markSaved(journal);
  }

  markSaved(journal: { entries: JournalDump['entries'] }): void {
    this.set({
      savedJournal: journalIdentity(journal.entries),
      savedBaseline: structuredClone(journal.entries),
      journalComparison: null,
      comparisonSource: null,
      comparisonBaseline: null,
    });
  }

  resizePanel(panel: ResizablePanel, size: number): void {
    this.set({ panelSizes: { ...this.state.panelSizes, [panel]: clampPanelSize(panel, size) } });
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
