// Every host Command and host Query of plan B §4.3: what the UI can do that the engine cannot
// see (camera, selection, panels, scripts, chat, files, project folder, AI settings). Each row is
// a zod schema, a doc string that is the AI's tool description, and a `run` that makes one call on
// `HostContext`. Nothing here touches the DOM: the app implements `HostContext`, tests fake it.
import { z } from 'zod';
import type { ModelFile, ModelSummary, PathResult, ResultSummary } from './generated/engine';
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
export const Animation = z.object({ step: z.string(), mode: int.optional(), playing: z.boolean(), speed: z.number().optional(), frame: int.optional() });
export const SelectionInput = z.object({
  bodies: z.array(z.string()).optional(),
  faces: z.array(z.string()).optional(),
  sets: z.array(z.string()).optional(),
  mode: z.enum(['replace', 'add', 'remove']).optional(),
});
export const PickTarget = z.enum(['face', 'body', 'off']);
export const ScreenshotOptions = z.object({ width: int.optional(), height: int.optional(), legend: z.boolean().optional(), title: z.string().optional() });
export const CopyWhat = z.union([
  z.object({ kind: z.literal('selection') }),
  z.object({ kind: z.literal('mention'), ref: z.string() }),
  z.object({ kind: z.literal('script'), seqs: z.array(int).optional() }),
  z.object({ kind: z.literal('text'), text: z.string() }),
]);
export const OpenHow = z.union([z.object({ picker: z.literal(true) }), z.object({ handle: z.looseObject({}) })]);
const Destination = z.enum(['download', 'project']).optional();

export interface Selection {
  bodies: string[];
  faces: string[];
  sets: string[];
  /** What `@selection` expands to: `face:beam.top`, `body:beam`, … */
  refs: string[];
}
export interface ProjectInfo {
  name: string;
  files: { path: string; size: number; kind: 'journal' | 'script' | 'skill' | 'agents' | 'export' | 'other' }[];
  agentsMd: 'AGENTS.md' | 'CLAUDE.md' | null;
  skills: string[];
}
export interface ScriptResult {
  result: unknown;
  console: string[];
  error?: string;
}
/** The autosave, as the start screen and `query.autosave` see it. */
export interface AutosaveState {
  enabled: boolean;
  /** The model name, when it was written, and how many Commands it holds; `null` if none. */
  saved: { name: string; at: number; commands: number } | null;
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
    setTheme(t: z.output<typeof Theme>): void;
    animate(a: z.output<typeof Animation>): void;
    camera(): z.output<typeof CameraState>;
    screenshot(o: z.output<typeof ScreenshotOptions>): Promise<{ png: string }>;
  };
  selection: {
    set(s: z.output<typeof SelectionInput>): void;
    clear(): void;
    setPickTarget(t: z.output<typeof PickTarget>): void;
    get(): Selection;
  };
  panels: { toggle(panel: string, open?: boolean): void };
  script: {
    run(code: string, timeoutMs?: number): Promise<ScriptResult>;
    stop(): void;
    setSource(code: string, append?: boolean): void;
  };
  chat: { send(text: string): void; insertMention(ref: string): void; clear(): void };
  skills(): Skill[];
  clipboard: { writeText(text: string): Promise<void> };
  files: {
    /** Open a file picker and return the chosen file's text. */
    pick(): Promise<string>;
    download(name: string, mime: string, data: string | Uint8Array): void;
    shareLink(file: ModelFile): Promise<{ url: string }>;
    /** Turn the IndexedDB autosave on or off. The choice sticks in this browser. */
    setAutosave(on: boolean): void;
    /** Replay the last autosave onto the current Model; `null` when there is nothing saved. */
    restore(): Promise<AutosaveState['saved']>;
    /** Whether autosave is on and what it last wrote, for `query.autosave` and the start screen. */
    autosave(): AutosaveState;
  };
  project: {
    open(how: z.output<typeof OpenHow>): Promise<void>;
    close(): void;
    refresh(): Promise<void>;
    info(): ProjectInfo | null;
    readText(path: string): Promise<string>;
    writeText(path: string, text: string): Promise<void>;
    writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  };
  examples: { fetch(name: string): Promise<string> };
  ai: { setKey(key: string | null): void; setModel(model: string): void };
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

/** Write a saved or exported file where the person asked, defaulting to the open project folder. */
async function deliver(ctx: HostContext, to: 'download' | 'project' | undefined, name: string, mime: string, data: string | Uint8Array): Promise<{ name: string; to: 'download' | 'project' }> {
  const dest = to ?? (ctx.project.info() ? 'project' : 'download');
  if (dest === 'download') ctx.files.download(name, mime, data);
  else if (typeof data === 'string') await ctx.project.writeText(name, data);
  else await ctx.project.writeBytes(name, data);
  return { name, to: dest };
}

async function importText(ctx: HostContext, text: string) {
  let file: ModelFile;
  try {
    file = JSON.parse(text) as ModelFile;
  } catch (e) {
    throw new FemError('schema', `not a femlab/1 JSON file: ${(e as Error).message}`, 'json', 'open a file written by file.save or an example from the gallery');
  }
  return ctx.transport.importFile(file);
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
  needs: 'mesh' | 'result' | 'none' | 'soon';
}

export const EXPORT_FORMATS: ExportFormatRow[] = [
  { format: 'msh', ext: 'msh', name: 'Gmsh mesh', note: 'Nodes, elements and the Sets as physical names, Gmsh 4.1 ASCII.', group: 'Model & mesh', needs: 'mesh' },
  { format: 'inp', ext: 'inp', name: 'Abaqus / CalculiX', note: '*NODE, *ELEMENT and the Sets, for a cross-check in CalculiX.', group: 'Model & mesh', needs: 'mesh' },
  { format: 'stl', ext: 'stl', name: 'STL surface', note: 'The mesh boundary as triangles, for a 3D viewer or a printer.', group: 'Model & mesh', needs: 'mesh' },
  { format: 'vtu', ext: 'vtu', name: 'VTK unstructured grid', note: 'The mesh with every nodal field of the Step. Opens in ParaView.', group: 'Results', needs: 'mesh' },
  { format: 'csv', ext: 'csv', name: 'Result table (CSV)', note: 'One table: extremes, reactions, or a sampled path.', group: 'Results', needs: 'result' },
  { format: 'png', ext: 'png', name: 'Viewer image', note: 'Exactly what the viewer shows, with the legend burned in.', group: 'Results', needs: 'none' },
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
async function buildExport(spec: ExportSpec, ctx: HostContext): Promise<Built> {
  const { name } = (await ctx.transport.query({ query: 'query.model' })) as ModelSummary;
  if (spec.format === 'script') {
    const { text } = (await ctx.transport.query({ query: 'query.script' })) as { text: string };
    return { filename: `${name}.ts`, mime: 'text/typescript', data: text };
  }
  if (spec.format === 'journal') {
    return { filename: `${name}.femlab.json`, mime: 'application/json', data: JSON.stringify(await ctx.transport.exportFile(), null, 2) };
  }
  if (spec.format === 'png') {
    const { png } = await ctx.view.screenshot({ legend: spec['legend'] !== false });
    return { filename: `${name}.png`, mime: 'image/png', data: dataUrlBytes(png) };
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
  def('view.showField', 'Show a result field as a contour on the mesh (`field`, optional `component` and `step`; default the last solved Step), or `{ field: null }` to turn contours off.', FieldChoice, (f, ctx) => ctx.view.showField(f)),
  def('view.setLegend', 'Set the contour legend: colormap (viridis or rainbow), number of discrete bands (null for continuous) and the value range as `[min, max]` or `"auto"`.', LegendSpec, (l, ctx) => ctx.view.setLegend(l)),
  def('view.setDeformScale', 'Scale the displayed deformed shape: a number, `"auto"` (a visible exaggeration) or `"true"` (scale 1, the real displacement). Only the display changes; results do not.', z.object({ scale: DeformScale }), ({ scale }, ctx) => ctx.view.setDeformScale(scale)),
  def('view.setClip', 'Cut the view with a section plane `{ normal, offset }` in metres to look inside a body, or `{ plane: null }` to remove the cut. Contours are drawn on the cut surface too.', z.object({ plane: ClipPlane.nullable() }), ({ plane }, ctx) => ctx.view.setClip(plane)),
  def('view.toggle', 'Show or hide an overlay layer: mesh, edges, loads, constraints, sets, legend, axes or grid. Omit `on` to flip the current state.', z.object({ layer: Layer, on: z.boolean().optional() }), ({ layer, on }, ctx) => ctx.view.toggle(layer, on)),
  def('view.setVisible', 'Show or hide the named bodies in the viewer (the tree\'s eye icon). Hidden bodies stay in the Model and in every solve; only the display changes.', z.object({ bodies: z.array(z.string()), on: z.boolean() }), ({ bodies, on }, ctx) => ctx.view.setVisible(bodies, on)),
  def('view.setTheme', 'Switch the app between the dark and light theme. The choice is remembered in this browser and affects screenshots.', z.object({ theme: Theme }), ({ theme }, ctx) => ctx.view.setTheme(theme)),
  def('view.animate', 'Play, pause or scrub an animation of a Step: a mode shape (`mode`) or a transient history, with `speed` and an explicit `frame`. Available once dynamics land; the row exists so the control has a Command.', Animation, (a, ctx) => ctx.view.animate(a)),
  def('selection.set', 'Select bodies, faces (named face Sets) and Sets by name, never by id. `mode` is replace (default), add or remove, like shift-click; the selection drives `view.fit` and `@selection` in the chat.', SelectionInput, (s, ctx) => ctx.selection.set(s)),
  def('selection.clear', 'Clear the current selection of bodies, faces and Sets, the same as clicking empty space in the viewer or pressing Escape.', none, (_, ctx) => ctx.selection.clear()),
  def('selection.setPickTarget', 'Arm the next viewer click to pick a face, a body, or nothing (`off`). The Properties form uses it for its "pick in viewer" buttons.', z.object({ target: PickTarget }), ({ target }, ctx) => ctx.selection.setPickTarget(target)),
  def('panel.toggle', 'Open, close or flip a panel by id, including the command palette, examples, report, project folder and export dialog. Model-tree groups are `tree.geometry` through `tree.plugins`; row menus are `tree.menu.<kind>:<name>`.', z.object({ panel: z.string(), open: z.boolean().optional() }), ({ panel, open }, ctx) => ctx.panels.toggle(panel, open)),
  def('script.run', 'Run TypeScript against the `fem` API (see fem.d.ts) in the script Worker with an optional timeout in milliseconds. Returns `{ result, console, error? }`; Commands it issues enter the Journal like any other.', z.object({ code: z.string(), timeoutMs: z.number().optional() }), ({ code, timeoutMs }, ctx) => ctx.script.run(code, timeoutMs), false),
  def('script.stop', 'Terminate the script that is currently running in the script Worker. Commands it already dispatched stay in the Journal; use journal.undo to take them back.', none, (_, ctx) => ctx.script.stop()),
  def('script.setSource', 'Put text into the Script editor, replacing its content or appending to it. Use it to hand a script to the person to review and edit rather than running it directly.', z.object({ code: z.string(), append: z.boolean().optional() }), ({ code, append }, ctx) => ctx.script.setSource(code, append)),
  def('chat.send', 'Send a chat turn as the person would; the text may contain `@kind:name` chips and a leading `/skill`. Not a tool: the AI is the receiver of chat turns, never their author.', z.object({ text: z.string() }), ({ text }, ctx) => ctx.chat.send(text), false),
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
  def('file.open', 'Open a saved Model file (`femlab/1` JSON): from `json` text, from a `path` relative to the open project folder, or with the file picker. Replaces the current Model and Journal.', z.union([z.object({ json: z.string() }), z.object({ picker: z.literal(true) }), z.object({ path: z.string() })]), async (how, ctx) => {
    if ('json' in how) return importText(ctx, how.json);
    if ('path' in how) return importText(ctx, await ctx.project.readText(assertInside(how.path).join('/')));
    return importText(ctx, await ctx.files.pick());
  }),
  def('file.save', 'Save the Model and its Journal as a `femlab/1` JSON file, into the project folder when one is open (or `to: "project"`) or as a download. `name` defaults to `<model name>.femlab.json`.', z.object({ name: z.string().optional(), to: Destination }), async ({ name, to }, ctx) => {
    const file = await ctx.transport.exportFile();
    return deliver(ctx, to, name ?? `${file.model.name}.femlab.json`, 'application/json', JSON.stringify(file, null, 2));
  }),
  def('file.export', 'Export in any format query.exportFormats lists: the mesh (vtu, msh, inp, stl), a result table as CSV, the viewer as PNG, the Journal as a TypeScript script or as a `femlab/1` file. Lands in the project folder when one is open (or `to: "project"`), else downloads.', z.object({ spec: z.looseObject({ format: z.string() }), name: z.string().optional(), to: Destination }), async ({ spec, name, to }, ctx) => {
    const out = await buildExport(spec as ExportSpec, ctx);
    return deliver(ctx, to, name ?? out.filename, out.mime, out.data);
  }),
  def('file.shareLink', 'Make a URL that reopens the current Model: the Journal deflated into the URL fragment, so nothing is uploaded anywhere and the link works offline. Returns `{ url }` and copies it to the clipboard; paste it in a message or a report. Refuses with `unsupported` over 32 kB — use file.save and send the file for a big Model.', none, async (_, ctx) => ctx.files.shareLink(await ctx.transport.exportFile())),
  def('file.autosave', 'Turn the background autosave on or off. When on (the default) the Journal is written to this browser\'s IndexedDB after every Command, so a crash or a closed tab loses nothing; file.restore reopens it. Nothing is uploaded. Turning it off also forgets what is already saved.', z.object({ on: z.boolean() }), ({ on }, ctx) => {
    ctx.files.setAutosave(on);
    return ctx.files.autosave();
  }),
  def('file.restore', 'Reopen the last autosave, replaying its Journal onto the current Model. Returns `{ name, at, commands }`, or `null` when this browser has nothing saved. Use query.autosave first to see whether there is anything to offer.', none, (_, ctx) => ctx.files.restore()),
  def('file.read', 'Read a text file from the open project folder by relative path (AGENTS.md, a script, a report, a skill). Paths outside the folder are refused; files over 2 MB are not read.', z.object({ path: z.string() }), async ({ path }, ctx) => {
    const text = await ctx.project.readText(assertInside(path).join('/'));
    if (text.length > MAX_TEXT) throw new FemError('unsupported', `'${path}' is larger than 2 MB`, `path '${path}'`, 'read a smaller file or export a summary instead');
    return { text };
  }),
  def('file.write', 'Write a text file into the open project folder by relative path, creating directories as needed and replacing an existing file. Paths outside the folder are refused.', z.object({ path: z.string(), text: z.string() }), ({ path, text }, ctx) => ctx.project.writeText(assertInside(path).join('/'), text)),
  def('project.open', 'Open a project folder with the directory picker (needs a click) or from a stored handle; its AGENTS.md and skills/*/SKILL.md are read and its files listed. Not a tool: the person chooses the folder.', OpenHow, (how, ctx) => ctx.project.open(how), false),
  def('project.close', 'Close the open project folder: file.read/file.write stop working, project skills and AGENTS.md rules are dropped, saves go back to downloads.', none, (_, ctx) => ctx.project.close()),
  def('project.refresh', 'Re-list the project folder and re-read AGENTS.md or CLAUDE.md and skills/*/SKILL.md after files changed outside the app.', none, (_, ctx) => ctx.project.refresh()),
  def('example.open', 'Open one of the bundled example models by name (see the examples gallery); replaces the current Model and Journal with the example\'s.', z.object({ name: z.string() }), async ({ name }, ctx) => importText(ctx, await ctx.examples.fetch(name))),
  def('solve.cancel', 'Cancel the running solve or convergence study. The Model is restored to its state before the solve; nothing is journaled.', none, (_, ctx) => ctx.transport.cancel()),
  def('ai.setKey', 'Store the Anthropic API key for the AI assistant in this browser only (localStorage), or `null` to forget it. Never journaled, exported or exposed as a tool.', z.object({ key: z.string().nullable() }), ({ key }, ctx) => ctx.ai.setKey(key), false),
  def('ai.setModel', 'Choose the model id the AI assistant uses for the next turns; the default is the current Opus. Not exposed as a tool.', z.object({ model: z.string() }), ({ model }, ctx) => ctx.ai.setModel(model), false),
];

export const HOST_QUERIES: HostDef[] = [
  def('query.screenshot', 'Render the current view to a PNG (base64) at the given size, optionally with the legend and a title. Use it to see what the person sees or to put an image in a report.', ScreenshotOptions, (o, ctx) => ctx.view.screenshot(o)),
  def('query.view', 'The current camera: position, target and up in metres. Save it with the model or hand it back to view.setCamera to reproduce a screenshot.', none, (_, ctx) => ctx.view.camera()),
  def('query.capabilities', 'What this engine and browser can do: GPU and adapter, thread count, engine and schema versions, WebGPU and cross-origin isolation, and whether the engine runs locally or on a remote server.', none, async (_, ctx) => ({
    ...((await ctx.transport.query({ query: 'query.capabilities' })) as object),
    ...ctx.env,
  })),
  def('query.selection', 'The current selection as bodies, faces and Sets plus the `refs` list (`face:beam.top`, …) that `@selection` expands to in the chat.', none, (_, ctx) => ctx.selection.get()),
  def('query.skills', 'Every available skill with its name, description, when to use it and whether it is built in or from the project folder. Invoke one with skill.invoke.', none, (_, ctx) => ctx.skills().map(({ name, description, when, source }) => ({ name, description, when, source }))),
  def('query.exportFormats', 'Every format file.export writes, with its extension, what it contains and what it needs first (`mesh`, `result`, `none`, or `soon` for one that is not written yet). The Export dialog is a view of this list.', none, () => ({ formats: EXPORT_FORMATS })),
  def('query.project', 'The open project folder: name, files with size and kind, which of AGENTS.md or CLAUDE.md is present, and the project skills; `null` when no folder is open.', none, (_, ctx) => ctx.project.info()),
  def('query.autosave', 'Whether the background autosave is on, and what this browser last saved (`{ name, at, commands }` or `null`). The start screen reads it to decide whether to offer "restore the last model"; file.restore reopens it.', none, (_, ctx) => ctx.files.autosave()),
];
