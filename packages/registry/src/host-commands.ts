// Every host Command and host Query of plan B §4.3: what the UI can do that the engine cannot
// see (camera, selection, panels, scripts, chat, files, projects, the disk folder, AI settings).
// Two different things used to be called a project; they are now a **project** (one saved Model
// in this browser, `project.*`) and a **folder** (a directory on disk, `folder.*`). Each row is
// a zod schema, a doc string that is the AI's tool description, and a `run` that makes one call on
// `HostContext`. Nothing here touches the DOM: the app implements `HostContext`, tests fake it.
import { z } from 'zod';
import type { ScriptDiagnostic, ScriptValidation } from './script-validation-types';
import type { JournalEntry, ModelFile, ModelSummary, PathResult, ResultSummary } from './generated/engine';
import { FemError } from './error';
import { assertInside } from './project-paths';
import type { HostDef } from './registry';
import type { Skill } from './skills';
import type { EngineTransport, ExportSpec } from './transport';

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const int = z.number().int();
const none = z.object({});

export const CameraState = z.object({ position: vec3, target: vec3, up: vec3.optional() });
export const ViewPreset = z.enum(['iso', 'front', 'back', 'left', 'right', 'top', 'bottom']);
export const Projection = z.enum(['perspective', 'orthographic']);
export const FieldChoice = z.union([
  z.object({ field: z.string(), component: int.optional(), step: z.string().optional() }),
  z.object({ field: z.null() }),
]);
export const LegendSpec = z.object({
  colormap: z.enum(['viridis', 'turbo', 'rainbow']).optional(),
  bands: int.nullable().optional(),
  range: z.union([z.tuple([z.number(), z.number()]), z.literal('auto')]).optional(),
});
export const DeformScale = z.union([z.number(), z.literal('auto'), z.literal('true')]);
export const ClipPlane = z.object({ normal: vec3, offset: z.number() });
export const Layer = z.enum(['mesh', 'edges', 'loads', 'constraints', 'sets', 'legend', 'axes', 'grid']);
export const Theme = z.enum(['dark', 'light']);
export const Animation = z.object({ step: z.string().min(1), mode: int.positive().optional(), playing: z.boolean(), speed: z.number().positive().optional(), frame: int.min(0).max(100).optional() });
const TimeQuantity = z.union([z.string(), z.object({ value: z.number(), unit: z.string() })]);
export const TransientPlayback = z.object({
  step: z.string(), playing: z.boolean(), speed: z.number().positive().optional(),
  sample: z.union([
    z.object({ kind: z.literal('frame'), index: int.nonnegative() }),
    z.object({ kind: z.literal('time'), time: TimeQuantity, sampling: z.enum(['exact', 'nearest']) }),
  ]).optional(),
});
export const SelectionInput = z.object({
  refs: z.array(z.string()).optional(),
  bodies: z.array(z.string()).optional(),
  faces: z.array(z.string()).optional(),
  sets: z.array(z.string()).optional(),
  mode: z.enum(['replace', 'add', 'remove']).optional(),
});
export const HighlightInput = SelectionInput.omit({ refs: true, mode: true });
export const PickTarget = z.enum(['face', 'body', 'off']);
/** Resizable shell panels. Their sizes are view state and never enter the Journal. */
export const PanelTarget = z.enum(['tree', 'properties', 'bottom', 'assistant']);
export const ScreenshotOptions = z.object({ width: int.positive().optional(), height: int.positive().optional(), legend: z.boolean().optional(), title: z.string().optional() });
export const AnimationCaptureOptions = z.object({
  width: int.min(64).max(3840),
  height: int.min(64).max(2160),
  fps: int.min(1).max(60).default(30),
  duration: z.number().min(0.1).max(30).default(4),
});
export type AiProvider = 'anthropic' | 'openai';
export const CopyWhat = z.union([
  z.object({ kind: z.literal('selection') }),
  z.object({ kind: z.literal('mention'), ref: z.string() }),
  z.object({ kind: z.literal('script'), seqs: z.array(int).optional() }),
  z.object({ kind: z.literal('text'), text: z.string() }),
]);
export const OpenHow = z.union([z.object({ picker: z.literal(true) }), z.object({ handle: z.looseObject({}) })]);
const Destination = z.enum(['download', 'folder']).optional();

export interface Selection {
  bodies: string[];
  faces: string[];
  sets: string[];
  /** What `@selection` expands to: stable `kind:name` Model object references. */
  refs: string[];
}
/** The open project *folder* on disk, as `query.folder` reports it. */
export interface FolderInfo {
  name: string;
  files: { path: string; size: number; kind: 'journal' | 'script' | 'skill' | 'agents' | 'export' | 'other' }[];
  agentsMd: 'AGENTS.md' | 'CLAUDE.md' | null;
  skills: string[];
}
export interface ScriptResult {
  diagnostics?: ScriptDiagnostic[];
  /** Successful engine Commands dispatched by this script, for attributable turn diffs. */
  journalEntries?: JournalEntry[];
  result: unknown;
  console: string[];
  error?: string;
}
/** One saved Model in this browser: what a Recent card shows, and what `query.projects` lists. */
export interface ProjectMeta {
  id: string;
  name: string;
  /** When it was last written, ms since the epoch. */
  at: number;
  createdAt: number;
  /** How many Commands its Journal holds, so a card needs no Journal read. */
  commands: number;
  /** `query.model().hash` at the last write, or `null` before one. */
  hash: string | null;
  /** A small `data:` URL of the viewer, at most 320x180; `null` until a save takes one. */
  thumbnail: string | null;
}

/** The open project, as `query.project` and the top bar's saved chip see it. */
export interface OpenProject extends ProjectMeta {
  /** A write is in flight or waiting on the debounce. */
  saving: boolean;
  /** Whether the background save is on at all (`file.autosave`). */
  autosave: boolean;
}

/** The exact browser-project payload written by one successful explicit `project.save`. */
export interface ProjectSaveReceipt extends OpenProject {
  /** Normalized Journal captured when Save began, before the thumbnail or storage write awaited. */
  journal: ModelFile['journal'];
}

/** The autosave state exposed through `query.autosave`. */
export interface AutosaveState {
  enabled: boolean;
  /** The model name, when it was written, and how many Commands it holds; `null` if none. */
  saved: { name: string; at: number; commands: number } | null;
}
export interface AutosaveVersion {
  id: string;
  name: string;
  at: number;
  commands: number;
}

/** What the app hands the registry: every side effect a host Command can have, as an interface. */
export interface HostContext {
  transport: EngineTransport;
  view: {
    fit(): void;
    setCamera(c: z.output<typeof CameraState>): void;
    preset(v: z.output<typeof ViewPreset>): void;
    setProjection(p: z.output<typeof Projection>): void;
    // The three that reach the engine for an array; the app awaits them, a fake need not.
    showField(f: z.output<typeof FieldChoice>): void | Promise<void>;
    setLegend(l: z.output<typeof LegendSpec>): void | Promise<void>;
    setDeformScale(s: z.output<typeof DeformScale>): void | Promise<void>;
    setClip(p: z.output<typeof ClipPlane> | null): void;
    toggle(layer: z.output<typeof Layer>, on?: boolean): void;
    setVisible(bodies: string[], on: boolean): void;
    highlight(s: z.output<typeof HighlightInput>): void;
    setTheme(t: z.output<typeof Theme>): void;
    animate(a: z.output<typeof Animation>): void | Promise<void>;
    playTransient(a: z.output<typeof TransientPlayback>): void | Promise<void>;
    camera(): z.output<typeof CameraState>;
    screenshot(o: z.output<typeof ScreenshotOptions>): Promise<{ png: string }>;
    captureAnimation(o: z.output<typeof AnimationCaptureOptions>): Promise<{ webm: Uint8Array | null }>;
    cancelAnimationCapture(): boolean;
  };
  selection: {
    set(s: z.output<typeof SelectionInput>): void | Promise<void>;
    clear(): void;
    setPickTarget(t: z.output<typeof PickTarget>): void;
    get(): Selection;
  };
  panels: { toggle(panel: string, open?: boolean): void; resize(panel: z.output<typeof PanelTarget>, size: number): void };
  report: {
    /** Open the browser print dialog for the mounted calculation note. */
    print(): void;
  };
  script: {
    validate(code: string, timeoutMs?: number): Promise<ScriptValidation>;
    run(code: string, timeoutMs?: number): Promise<ScriptResult>;
    stop(): void;
    setSource(code: string, append?: boolean): void;
  };
  chat: { send(text: string): void; insertMention(ref: string): void; setDraft(text: string): void | Promise<void>; clear(): void };
  skills(): Skill[];
  clipboard: { writeText(text: string): Promise<void> };
  files: {
    /** Open a file picker and return the chosen file's text. */
    pick(): Promise<string>;
    download(name: string, mime: string, data: string | Uint8Array): void;
    /** Establish the explicit save/open baseline from that operation's exact normalized Journal. */
    markSaved(journal: ModelFile['journal']): void;
    shareLink(file: ModelFile): Promise<{ url: string }>;
    /** Turn the background save into the open project on or off. The choice sticks in this browser. */
    setAutosave(on: boolean): void;
    /** Replay one saved revision, or the newest revision when no id is supplied. */
    restore(id?: string): Promise<AutosaveState['saved']>;
    /** Whether autosave is on and the latest known revision, for `query.autosave`. */
    autosave(): AutosaveState;
    /** Bounded saved Journal revisions, newest first, for the history view. */
    autosaves(): AutosaveVersion[];
  };
  /**
   * Projects in this browser's storage. `list` and `current` are **synchronous**: both answer
   * from a memory cache the app primes at boot and every write keeps up to date, because
   * IndexedDB is not and a Query the top bar reads on every render must not await.
   */
  projects: {
    'new'(name?: string): Promise<ProjectMeta>;
    open(id: string): Promise<ProjectMeta>;
    rename(id: string | undefined, name: string): Promise<ProjectMeta>;
    delete(id: string): Promise<void>;
    save(): Promise<ProjectSaveReceipt | null>;
    list(): ProjectMeta[];
    current(): OpenProject | null;
  };
  /** The project *folder* on disk, over the File System Access API. */
  folder: {
    open(how: z.output<typeof OpenHow>): Promise<void>;
    close(): void;
    refresh(): Promise<void>;
    info(): FolderInfo | null;
    readText(path: string): Promise<string>;
    writeText(path: string, text: string): Promise<void>;
    writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  };
  /** Hosts replay bundled example Journals and hydrate their presentation after a complete open. */
  examples: { open(name: string): Promise<{ name: string; commands: number }> };
  ai: { setKey(key: string | null, provider: AiProvider): void; setModel(model: string): void };
  env: { webgpu: boolean; crossOriginIsolated: boolean; threads: number; userAgent: string; engine: 'local' | 'remote' };
}

const def = <S extends z.ZodType>(name: string, description: string, schema: S, run: (input: z.output<S>, ctx: HostContext) => unknown, tool = true): HostDef<S> => ({
  name,
  description,
  schema,
  tool,
  run,
});

const MAX_TEXT = 2 * 1024 * 1024;

/** Write a saved or exported file where the person asked, defaulting to the open folder. */
async function deliver(ctx: HostContext, to: 'download' | 'folder' | undefined, name: string, mime: string, data: string | Uint8Array): Promise<{ name: string; to: 'download' | 'folder' }> {
  const dest = to ?? (ctx.folder.info() ? 'folder' : 'download');
  if (dest === 'download') ctx.files.download(name, mime, data);
  else if (typeof data === 'string') await ctx.folder.writeText(name, data);
  else await ctx.folder.writeBytes(name, data);
  return { name, to: dest };
}

/** Browser imports are bounded before JSON parsing or transfer to the engine Worker. */
export const MAX_MODEL_FILE_BYTES = 16 * 1024 * 1024;

async function importText(ctx: HostContext, text: string) {
  if (text.length > MAX_MODEL_FILE_BYTES || new TextEncoder().encode(text).byteLength > MAX_MODEL_FILE_BYTES) {
    throw new FemError('schema', 'Model file exceeds the 16 MiB import limit', 'json', 'open a smaller file written by file.save');
  }
  let file: ModelFile;
  try {
    file = JSON.parse(text) as ModelFile;
  } catch (e) {
    throw new FemError('schema', `not a femlab/1 JSON file: ${(e as Error).message}`, 'json', 'open a file written by file.save or an example from the gallery');
  }
  const ack = await ctx.transport.importFile(file);
  ctx.files.markSaved(ack.journal);
  return ack;
}

/** One row of the Export dialog (design §Export modal), and what `file.export` accepts. */
export interface ExportFormatRow {
  /** The `spec.format` that writes it. */
  format: string;
  ext: string;
  name: string;
  note: string;
  group: 'Model & mesh' | 'Results' | 'Document & model file';
  /** What has to exist first, so the dialog can grey the row and say why. */
  needs: 'mesh' | 'result' | 'animation' | 'none' | 'soon';
}

export const EXPORT_FORMATS: ExportFormatRow[] = [
  { format: 'msh', ext: 'msh', name: 'Gmsh mesh', note: 'Nodes, elements and the Sets as physical names, Gmsh 4.1 ASCII.', group: 'Model & mesh', needs: 'mesh' },
  { format: 'inp', ext: 'inp', name: 'Abaqus / CalculiX', note: '*NODE, *ELEMENT and the Sets, for a cross-check in CalculiX.', group: 'Model & mesh', needs: 'mesh' },
  { format: 'stl', ext: 'stl', name: 'STL surface', note: 'The mesh boundary as triangles, for a 3D viewer or a printer.', group: 'Model & mesh', needs: 'mesh' },
  { format: 'vtu', ext: 'vtu', name: 'VTK unstructured grid', note: 'The mesh with every nodal field of the Step. Opens in ParaView.', group: 'Results', needs: 'mesh' },
  { format: 'csv', ext: 'csv', name: 'Result table (CSV)', note: 'One table: extremes, reactions, or a sampled path.', group: 'Results', needs: 'result' },
  { format: 'png', ext: 'png', name: 'Viewer image', note: 'Exactly what the viewer shows, with the legend burned in.', group: 'Results', needs: 'none' },
  { format: 'webm', ext: 'webm', name: 'Viewer animation', note: 'One mode-shape sweep at an explicit resolution, encoded by Chromium as WebM.', group: 'Results', needs: 'animation' },
  { format: 'script', ext: 'ts', name: 'TypeScript script', note: 'The Journal, typed: run it back and the Model rebuilds.', group: 'Document & model file', needs: 'none' },
  { format: 'journal', ext: 'json', name: 'Model file (femlab/1)', note: 'The Model and its Journal, what file.open reads back.', group: 'Document & model file', needs: 'none' },
  { format: 'report', ext: 'md', name: 'Calculation note', note: 'Assumptions, mesh, loads, results and the Journal as Markdown.', group: 'Document & model file', needs: 'none' },
];

/** A CSV cell: quoted only when it has to be, so a diff of two exports stays readable. */
function cell(v: string | number): string {
  const text = String(v);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
const row = (cells: (string | number)[]): string => cells.map(cell).join(',');

/** The Results tab's Extremes table, as a file. */
export function extremesCsv(r: ResultSummary): string {
  const head = row(['field', 'component', 'min', 'minX', 'minY', 'minZ', 'max', 'maxX', 'maxY', 'maxZ', 'unit']);
  const rows = r.extremes.map((e) =>
    row([e.field, e.component, e.min.value, ...e.minAt.map((v) => v.value), e.max.value, ...e.maxAt.map((v) => v.value), e.max.unit]),
  );
  return `${[head, ...rows].join('\n')}\n`;
}

/** The Reactions table with its two totals: what the balance check is computed from. */
export function reactionsCsv(r: ResultSummary): string {
  const sum = [0, 1, 2].map((c) => r.reactions.reduce((a, x) => a + x.total[c]!.value, 0));
  const unit = r.appliedTotal[0]!.unit;
  const rows = [
    row(['constraint', 'fx', 'fy', 'fz', 'unit']),
    ...r.reactions.map((x) => row([x.constraint, ...x.total.map((v) => v.value), x.total[0]!.unit])),
    row(['sum reactions', ...sum, unit]),
    row(['sum applied', ...r.appliedTotal.map((v) => v.value), unit]),
    row(['balance', r.balance, '', '', '']),
  ];
  return `${rows.join('\n')}\n`;
}

/** `query.path` as two columns, which is what a plot in a spreadsheet wants. */
export function pathCsv(p: PathResult): string {
  const rows = p.s.map((s, i) => row([s, p.values[i] ?? '']));
  return `${[row(['s', `value (${p.unit})`]), ...rows].join('\n')}\n`;
}

/** `data:image/png;base64,...` as the bytes a download needs. */
export function dataUrlBytes(url: string): Uint8Array {
  const binary = atob(url.slice(url.indexOf(',') + 1));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

interface Built {
  filename: string;
  mime: string;
  data: string | Uint8Array;
}

/**
 * What `file.export` writes. Mesh formats are the engine's `mesh.export`; the four the engine
 * cannot see - the script, the model file, the viewer image and the result tables - are built
 * here from Queries it can.
 */
async function buildExport(spec: ExportSpec, ctx: HostContext): Promise<Built | null> {
  const { name } = (await ctx.transport.query({ query: 'query.model' })) as ModelSummary;
  if (spec.format === 'script') {
    const { text } = (await ctx.transport.query({ query: 'query.script' })) as { text: string };
    return { filename: `${name}.ts`, mime: 'text/typescript', data: text };
  }
  if (spec.format === 'journal') {
    return { filename: `${name}.femlab.json`, mime: 'application/json', data: JSON.stringify(await ctx.transport.exportFile(), null, 2) };
  }
  if (spec.format === 'png') {
    const options = ScreenshotOptions.parse({
      legend: spec['legend'] !== false,
      ...(spec['width'] === undefined ? {} : { width: spec['width'] }),
      ...(spec['height'] === undefined ? {} : { height: spec['height'] }),
      ...(spec['title'] === undefined ? {} : { title: spec['title'] }),
    });
    const { png } = await ctx.view.screenshot(options);
    return { filename: `${name}.png`, mime: 'image/png', data: dataUrlBytes(png) };
  }
  if (spec.format === 'webm') {
    const width = spec['width'] as number;
    const height = spec['height'] as number;
    const fps = spec['fps'] as number;
    const duration = spec['duration'] as number;
    const { webm } = await ctx.view.captureAnimation({ width, height, fps, duration });
    return webm === null ? null : { filename: `${name}.webm`, mime: 'video/webm', data: webm };
  }
  if (spec.format === 'csv') {
    const table = String(spec['table'] ?? 'extremes');
    if (table === 'path') {
      const path = (await ctx.transport.query({ query: 'query.path', ...(spec['path'] as object) } as never)) as PathResult;
      return { filename: `${name}-path.csv`, mime: 'text/csv', data: pathCsv(path) };
    }
    const step = spec['step'] === undefined ? {} : { step: spec['step'] };
    const result = (await ctx.transport.query({ query: 'query.result', ...step } as never)) as ResultSummary;
    return { filename: `${name}-${table}.csv`, mime: 'text/csv', data: table === 'reactions' ? reactionsCsv(result) : extremesCsv(result) };
  }
  const out = await ctx.transport.export(spec);
  return { filename: out.filename, mime: out.mime, data: out.bytes };
}

export const HOST_COMMANDS: HostDef[] = [
  def('view.fit', 'Frame the camera on the whole mesh, or on the current selection when there is one. Use it after adding geometry or when the model has drifted out of view.', none, (_, ctx) => ctx.view.fit()),
  def('view.setCamera', 'Place the camera explicitly: `position` and `target` in metres in viewer space, optional `up`. Use `view.preset` for the standard views; this is for a reproducible screenshot angle.', CameraState, (c, ctx) => ctx.view.setCamera(c)),
  def('view.preset', 'Jump to a standard view (iso, front, back, left, right, top, bottom) framed on the mesh bounding box; the same as the view buttons and keys.', z.object({ view: ViewPreset }), ({ view }, ctx) => ctx.view.preset(view)),
  def('view.setProjection', 'Switch between perspective and orthographic projection. Orthographic is the right choice for dimensioned screenshots and for comparing deformed shapes.', z.object({ projection: Projection }), ({ projection }, ctx) => ctx.view.setProjection(projection)),
  def('view.showField', 'Show a browser-supported result field as a contour on the mesh (`field`, optional `component` and `step`; default the last solved Step), or `{ field: null }` to turn contours off. Unsupported fields or components return a structured `unsupported` error; choose a field and component from the Results picker.', FieldChoice, (f, ctx) => ctx.view.showField(f)),
  def('view.setLegend', 'Set the contour legend: colormap (viridis or rainbow), number of discrete bands (null for continuous) and the value range as `[min, max]` or `"auto"`.', LegendSpec, (l, ctx) => ctx.view.setLegend(l)),
  def('view.setDeformScale', 'Scale the displayed deformed shape: a number, `"auto"` (a visible exaggeration) or `"true"` (scale 1, the real displacement). Only the display changes; results do not.', z.object({ scale: DeformScale }), ({ scale }, ctx) => ctx.view.setDeformScale(scale)),
  def('view.setClip', 'Cut the view with a section plane `{ normal, offset }` in metres to look inside a body, or `{ plane: null }` to remove the cut. Contours are drawn on the cut surface too.', z.object({ plane: ClipPlane.nullable() }), ({ plane }, ctx) => ctx.view.setClip(plane)),
  def('view.toggle', 'Show or hide an overlay layer: mesh, edges, loads, constraints, sets, legend, axes or grid. Omit `on` to flip the current state.', z.object({ layer: Layer, on: z.boolean().optional() }), ({ layer, on }, ctx) => ctx.view.toggle(layer, on)),
  def('view.setVisible', 'Show or hide the named bodies in the viewer (the tree\'s eye icon). Hidden bodies stay in the Model and in every solve; only the display changes.', z.object({ bodies: z.array(z.string()), on: z.boolean() }), ({ bodies, on }, ctx) => ctx.view.setVisible(bodies, on)),
  def('view.highlight', 'Temporarily highlight named bodies, faces or Sets in the viewer. Pass an empty object to clear the highlight. This is transient hover state: it never changes the selection, Model or Journal.', HighlightInput, (s, ctx) => ctx.view.highlight(s)),
  def('view.setTheme', 'Switch the app between the dark and light theme. The choice is remembered in this browser and affects screenshots.', z.object({ theme: Theme }), ({ theme }, ctx) => ctx.view.setTheme(theme)),
  def('view.animate', 'Play, pause or scrub the displacement amplitude of a solved Step. mode selects a one-based modal shape; speed is positive cycles per second. frame is phase from 0 to 100 percent of a sinusoidal cycle, including while paused. Use view.playTransient for retained physical-time fields. No Model or Journal change.', Animation, (a, ctx) => ctx.view.animate(a)),
  def('view.playTransient', 'Play, pause or select actual retained fields of a solved transient Step. speed is positive simulated seconds per wall second. sample selects a zero-based retained frame or a unit-bearing time resolved by the engine with exact/nearest sampling. Playback holds stored fields until the next retained time, stops at the endpoint, and synchronizes temperature or displacement contours, deformation, legend and probes. Historical derived fields are unavailable. Display only; no Model or Journal change.', TransientPlayback, (a, ctx) => ctx.view.playTransient(a)),
  def('selection.set', 'Select Model objects by stable `kind:name` refs, or select drawable bodies, faces and Sets by name. `mode` is replace (default), add or remove. The selection drives Properties, `view.fit` and `@selection` in chat.', SelectionInput, (s, ctx) => ctx.selection.set(s)),
  def('selection.clear', 'Clear the current selection of bodies, faces and Sets, the same as clicking empty space in the viewer or pressing Escape.', none, (_, ctx) => ctx.selection.clear()),
  def('selection.setPickTarget', 'Arm the next viewer click to pick a face, a body, or nothing (`off`). The Properties form uses it for its "pick in viewer" buttons.', z.object({ target: PickTarget }), ({ target }, ctx) => ctx.selection.setPickTarget(target)),
  def('panel.toggle', 'Open, close or flip a panel by id, including the command palette, examples gallery, report, project folder and export dialog. Model-tree groups are `tree.geometry` through `tree.plugins`; row menus are `tree.menu.<kind>:<name>`.', z.object({ panel: z.string(), open: z.boolean().optional() }), ({ panel, open }, ctx) => ctx.panels.toggle(panel, open)),
  def('panel.resize', 'Resize one shell panel in CSS pixels. `panel` is `tree`, `properties`, `bottom` or `assistant`; the size is constrained to preserve a usable viewer and is view state, never a Journal entry. During a drag, issue exactly one final Command with the ending size; use the keyboard for accessible step changes.', z.object({ panel: PanelTarget, size: z.number().int().min(120).max(640) }), ({ panel, size }, ctx) => ctx.panels.resize(panel, size)),
  def('report.print', 'Open Chromium\'s print dialog for the rendered calculation note. Choose Save as PDF there for a paginated PDF of the current report.', none, (_, ctx) => ctx.report.print()),
  def('script.run', 'Validate TypeScript against the generated `fem` types (fem.d.ts) with a separate 10000 ms validation deadline, then run it in the script Worker with a default and maximum 30000 ms execution deadline and a 64000-character source limit. Returns `{ result, console, error? }`; Commands it issues enter the Journal like any other.', z.object({ code: z.string().max(64000), timeoutMs: z.number().finite().positive().max(30000).optional() }), async ({ code, timeoutMs }, ctx) => {
    const validation = await ctx.script.validate(code);
    if (!validation.ok) return { result: null, console: [], error: 'script.validation: correct validation diagnostics before running', diagnostics: validation.diagnostics } satisfies ScriptResult;
    return ctx.script.run(code, timeoutMs);
  }, false),
  def('script.stop', 'Terminate the script that is currently running in the script Worker. Commands it already dispatched stay in the Journal; use journal.undo to take them back.', none, (_, ctx) => ctx.script.stop()),
  def('script.setSource', 'Put text into the Script editor, replacing its content or appending to it. Use it to hand a script to the person to review and edit rather than running it directly.', z.object({ code: z.string(), append: z.boolean().optional() }), ({ code, append }, ctx) => ctx.script.setSource(code, append)),
  def('chat.send', 'Send a chat turn, or queue it while the Assistant works. Empty text while a message is queued interrupts the current response and starts the next after any active tool finishes. The text may contain `@kind:name` chips and a leading `/skill`. Not a tool: the AI is the receiver of chat turns, never their author.', z.object({ text: z.string() }), ({ text }, ctx) => ctx.chat.send(text), false),
  def('chat.insertMention', 'Insert an `@kind:name` chip into the chat input, as a viewer or tree click does while the chat is focused. Not a tool; the AI receives chips, it does not type them.', z.object({ ref: z.string() }), ({ ref }, ctx) => ctx.chat.insertMention(ref), false),
  def('chat.clear', 'Start a new conversation: clears the chat history and the AI context. The Model and Journal are untouched.', none, (_, ctx) => ctx.chat.clear(), false),
  def('skill.invoke', 'Load a skill by name and return its instructions (`{ name, body, source }`) so they enter the conversation at the point they are needed; `args` is the rest of the person\'s `/name` line. Use query.skills to see what exists.', z.object({ name: z.string(), args: z.string().optional() }), ({ name, args }, ctx) => {
    const skills = ctx.skills();
    const skill = skills.find((s) => s.name === name);
    if (!skill) throw new FemError('not-found', `no skill named '${name}'`, `skill '${name}'`, `known skills: ${skills.map((s) => s.name).join(', ')}`);
    return { name: skill.name, body: skill.body, source: skill.source, args: args ?? '' };
  }),
  def('clipboard.copy', 'Copy to the clipboard as plain text: the current selection as `@face:… @body:…` chips, one mention ref, the Journal as a script (optionally only `seqs`), or literal text. One Command for every copy affordance.', z.object({ what: CopyWhat }), async ({ what }, ctx) => {
    let text: string;
    if (what.kind === 'selection') text = ctx.selection.get().refs.map((r) => `@${r}`).join(' ');
    else if (what.kind === 'mention') text = `@${what.ref}`;
    else if (what.kind === 'script') text = ((await ctx.transport.query({ query: 'query.script' })) as { text: string }).text;
    else text = what.text;
    await ctx.clipboard.writeText(text);
    return { text };
  }),
  def('file.open', 'Open a saved Model file (`femlab/1` JSON): from `json` text, from a `path` relative to the open project folder, or with the file picker. Accepts at most 16 MiB of UTF-8 JSON. Replaces the current Model and Journal after engine validation.', z.union([z.object({ json: z.string() }), z.object({ picker: z.literal(true) }), z.object({ path: z.string() })]), async (how, ctx) => {
    if ('json' in how) return importText(ctx, how.json);
    if ('path' in how) return importText(ctx, await ctx.folder.readText(assertInside(how.path).join('/')));
    return importText(ctx, await ctx.files.pick());
  }),
  def('file.save', 'Save the Model and its Journal as a `femlab/1` JSON file, into the open project folder when there is one (or `to: "folder"`) or as a download. `name` defaults to `<model name>.femlab.json`.', z.object({ name: z.string().optional(), to: Destination }), async ({ name, to }, ctx) => {
    const file = await ctx.transport.exportFile();
    const receipt = await deliver(ctx, to, name ?? `${file.model.name}.femlab.json`, 'application/json', JSON.stringify(file, null, 2));
    ctx.files.markSaved(file.journal);
    return receipt;
  }),
  def('file.export', 'Export in any format query.exportFormats lists: the mesh (vtu, msh, inp, stl), a result table as CSV, the viewer as PNG or a WebM mode-shape sweep, the Journal as a TypeScript script or as a `femlab/1` file. For WebM, select a mode and give `width` and `height` in pixels; optional `fps` (default 30) and `duration` in seconds (default 4) control the recording. Lands in the open project folder when there is one (or `to: "folder"`), else downloads.', z.object({
    spec: z.union([
      AnimationCaptureOptions.extend({ format: z.literal('webm') }),
      z.looseObject({ format: z.string().refine((format) => format !== 'webm') }),
    ]),
    name: z.string().optional(),
    to: Destination,
  }), async ({ spec, name, to }, ctx) => {
    const out = await buildExport(spec as ExportSpec, ctx);
    if (out === null) return { cancelled: true };
    return deliver(ctx, to, name ?? out.filename, out.mime, out.data);
  }),
  def('file.cancelAnimationCapture', 'Cancel the WebM animation recording in progress. The viewer returns to the exact phase and play state it had before recording; returns `{ cancelled: false }` when no recording is active.', none, (_, ctx) => ({ cancelled: ctx.view.cancelAnimationCapture() })),
  def('file.shareLink', 'Make a URL that reopens the current Model: the Journal deflated into the URL fragment, so nothing is uploaded anywhere and the link works offline. Returns `{ url }` and copies it to the clipboard; paste it in a message or a report. Links replay validated engine Commands only. Refuses with `unsupported` over 32 kB encoded or 1 MiB uncompressed — use file.save and send the file for a big Model.', none, async (_, ctx) => ctx.files.shareLink(await ctx.transport.exportFile())),
  def('file.autosave', 'Turn the background save on or off. When on (the default) the Journal is written into the open project after every Command, so a crash or a closed tab loses nothing, and nothing is uploaded anywhere. Turning it off stops writing; the projects already saved in this browser are kept.', z.object({ on: z.boolean() }), ({ on }, ctx) => {
    ctx.files.setAutosave(on);
    return { enabled: on };
  }),
  def('file.restore', 'Reopen an autosaved Journal revision as a separate project without overwriting the currently saved project. Pass the `id` from query.autosaveHistory to reopen an earlier revision; omit it for the newest. Returns `{ name, at, commands }`, or `null` when this browser has nothing saved.', z.object({ id: z.string().optional() }), ({ id }, ctx) => ctx.files.restore(id)),
  def('file.read', 'Read a text file from the open project folder by relative path (AGENTS.md, a script, a report, a skill). Paths outside the folder are refused; files over 2 MB are not read.', z.object({ path: z.string() }), async ({ path }, ctx) => {
    const text = await ctx.folder.readText(assertInside(path).join('/'));
    if (text.length > MAX_TEXT) throw new FemError('unsupported', `'${path}' is larger than 2 MB`, `path '${path}'`, 'read a smaller file or export a summary instead');
    return { text };
  }),
  def('file.write', 'Write a text file into the open project folder by relative path, creating directories as needed and replacing an existing file. Paths outside the folder are refused.', z.object({ path: z.string(), text: z.string() }), ({ path, text }, ctx) => ctx.folder.writeText(assertInside(path).join('/'), text)),
  def('folder.open', 'Open a folder on disk with the directory picker (needs a click) or from a stored handle; its AGENTS.md and skills/*/SKILL.md are read and its files listed. Not a tool: the person chooses the folder.', OpenHow, (how, ctx) => ctx.folder.open(how), false),
  def('folder.close', 'Close the open folder on disk: file.read/file.write stop working, its skills and AGENTS.md rules are dropped, saves go back to downloads.', none, (_, ctx) => ctx.folder.close()),
  def('folder.refresh', 'Re-list the open folder on disk and re-read AGENTS.md or CLAUDE.md and skills/*/SKILL.md after files changed outside the app.', none, (_, ctx) => ctx.folder.refresh()),
  def('project.new',
    'Start a new project: an empty Model and Journal under `name`, kept in this browser and saved after every Command from now on. The project that was open is left exactly as it was and stays in Recent projects, so starting another one loses nothing.',
    z.object({ name: z.string().optional() }), (i, ctx) => ctx.projects.new(i.name)),
  def('project.open',
    'Open a saved project by id (query.projects lists them) and replay its Journal, so the Model, its history and its undo stack come back as they were left. Replaces whatever is open, which has already been saved under its own id.',
    z.object({ id: z.string() }), ({ id }, ctx) => ctx.projects.open(id)),
  def('project.rename',
    'Rename a saved project, by default the one that is open. The name appears in the Projects dialog and Recent projects list. This changes browser-project metadata only; use model.setName to edit the Model name shown in the top bar and saved in its Journal.',
    z.object({ id: z.string().optional(), name: z.string() }), ({ id, name }, ctx) => ctx.projects.rename(id, name)),
  def('project.delete',
    'Delete a saved project and its Journal from this browser for good. There is no undo and nothing was ever uploaded anywhere, so use file.save first if the model might be wanted again. Not a tool: deleting a person\u2019s work is theirs to do.',
    z.object({ id: z.string() }), ({ id }, ctx) => ctx.projects.delete(id), false),
  def('project.save',
    'Write the open project\'s current Journal now rather than waiting for the background save, and take a fresh thumbnail of the viewer for the Recent projects list. Returns the project and the exact normalized Journal that was written, or `null` when there is none yet. Use file.save to write a `femlab/1` file instead.',
    none, async (_, ctx) => {
      const saved = await ctx.projects.save();
      if (saved) ctx.files.markSaved(saved.journal);
      return saved;
    }),
  def('example.open', 'Open a bundled example by name (see the examples gallery), replaying its Journal Commands. A complete open establishes the saved baseline. If replay fails partway through, the partial Model remains visible and the previous saved baseline is preserved.', z.object({ name: z.string() }), ({ name }, ctx) => ctx.examples.open(name)),
  def('solve.cancel', 'Cancel the running solve or convergence study. The Model is restored to its state before the solve; nothing is journaled.', none, (_, ctx) => ctx.transport.cancel()),
  def('ai.setKey', 'Store an AI provider key for this tab session only (sessionStorage), or `null` to forget it. The provider defaults to Anthropic for compatibility. Never journaled, exported or exposed as a tool.', z.object({ key: z.string().nullable(), provider: z.enum(['anthropic', 'openai']).default('anthropic') }), ({ key, provider }, ctx) => ctx.ai.setKey(key, provider), false),
  def('ai.setModel', 'Choose the model id the AI assistant uses for the next turns; the default is the current Opus. Not exposed as a tool.', z.object({ model: z.string() }), ({ model }, ctx) => ctx.ai.setModel(model), false),
];

export const HOST_QUERIES: HostDef[] = [
  def('query.validateScript', 'Parse and type-check TypeScript against the generated fem API without executing it or changing the Model. Returns { ok, diagnostics: [{ code, cause, where: { line, column } | null, hint }] }. Source locations are one-based. Compilation runs in a worker with a separate default 10000 ms deadline (maximum 30000) and a 64000-character source limit. Passing validates types, not physical correctness or program termination. script.run performs this validation automatically before starting its execution timeout.', z.object({ code: z.string(), timeoutMs: z.number().optional() }), ({ code, timeoutMs }, ctx) => ctx.script.validate(code, timeoutMs)),
  def('query.screenshot', 'Render the current view to a PNG (base64) at the given positive integer pixel width and height, optionally with the legend and a title. A single dimension preserves the current aspect ratio; when neither is supplied, uses the current drawing-buffer size. Restores the interactive view after capture. Use it to see what the person sees or put an image in a report.', ScreenshotOptions, (o, ctx) => ctx.view.screenshot(o)),
  def('query.view', 'The current camera: position, target and up in metres. Save it with the model or hand it back to view.setCamera to reproduce a screenshot.', none, (_, ctx) => ctx.view.camera()),
  def('query.capabilities', 'What this engine and browser can do: GPU and adapter, thread count, engine and schema versions, WebGPU and cross-origin isolation, and whether the engine runs locally or on a remote server.', none, async (_, ctx) => ({
    ...((await ctx.transport.query({ query: 'query.capabilities' })) as object),
    ...ctx.env,
  })),
  def('query.selection', 'The current selection as bodies, faces and Sets plus the `refs` list (`face:beam.top`, …) that `@selection` expands to in the chat.', none, (_, ctx) => ctx.selection.get()),
  def('query.skills', 'Every available skill with its name, description, when to use it and whether it is built in or from the project folder. Invoke one with skill.invoke.', none, (_, ctx) => ctx.skills().map(({ name, description, when, source }) => ({ name, description, when, source }))),
  def('query.exportFormats', 'Every format file.export writes, with its extension, what it contains and what it needs first (`mesh`, `result`, `animation`, `none`, or `soon` for one that is not written yet). The Export dialog is a view of this list.', none, () => ({ formats: EXPORT_FORMATS })),
  def('query.folder', 'The open folder on disk: name, files with size and kind, which of AGENTS.md or CLAUDE.md is present, and the skills it carries; `null` when no folder is open.', none, (_, ctx) => ctx.folder.info()),
  def('query.projects',
    'Every project saved in this browser, most recently edited first: id, name, when it was last written, how many Commands its Journal holds, and a small thumbnail. The start screen\u2019s Recent projects list is a view of this Query.',
    none, (_, ctx) => ({ projects: ctx.projects.list() })),
  def('query.autosave', 'Whether background autosave is on, and the latest locally known revision (`{ name, at, commands }` or `null`), including pending writes; file.restore reopens it.', none, (_, ctx) => ctx.files.autosave()),
  def('query.autosaveHistory', 'List up to 20 locally known Journal revisions, newest first, including pending writes and retryable storage failures. Each `id` stays restorable through file.restore until history eviction or autosave clearing, including when model names and times tie. Pending revisions are not durable until their write commits and are discarded when autosave is disabled. Saved revisions remain available while autosave is off.', none, (_, ctx) => ({ enabled: ctx.files.autosave().enabled, revisions: ctx.files.autosaves() })),
  def('query.project',
    'The open project \u2014 id, name, when it was last written, how many Commands it holds and whether a write is in flight \u2014 or `null` when the Model is still empty and no project has been made yet. The top bar reads this.',
    none, (_, ctx) => ctx.projects.current()),
];
