// `HostContext` for the browser: the side effects every host Command in `@femlab/registry` is
// allowed to have, bound to this app's store and viewer. Nothing here reaches into the engine
// except through the transport, and nothing in the registry knows the DOM exists.
import { MAX_GEOMETRY_FILE_BYTES, MAX_MODEL_FILE_BYTES, FemError, type AiProvider, type AutosaveState, type AutosaveVersion, type EngineTransport, type HostContext, type HostDef, type Registry, type Journal, type JournalDiff, type Selection } from '@femlab/registry';

import { z } from 'zod';
import { attachComparison, type ActiveBenchmark, type ExampleEntry } from './benchmark';
import { storeKey } from './ai/key-storage';
import { AnimationCapture, browserAnimationCaptureEnvironment, type AnimationCaptureEnvironment } from './animation-capture';
import type { HostCaps } from './capabilities';
import { choiceOf } from './fields';
import type { Projects } from './projects';
import type { ResultsView } from './results';
import type { ScriptHost } from './script-host';
import { type Autosave, type ShareCommand, indexedDbStore, makeAutosave, memoryStore, shareUrl } from './share';
import { EMPTY_SELECTION, type ExampleDifficulty, type Store, type ViewMode, visibilityReducer } from './store';
import type { ColormapName } from './viewer/colormap';
import type { CameraState, Viewer } from './viewer/viewer';
import { treeGroups } from './ui/Tree';
import type { TransientInput } from './transient';

/**
 * The viewer exists only once the canvas is mounted and its chunk has arrived, so every host
 * Command reaches it lazily — and anything pushed to it before then (an example that opened
 * solved, a restored Journal) would be lost, which is what `onReady` is for: the shell calls it
 * the moment a Viewer exists, and the host answers by pushing the current surface and Result.
 */
export interface ViewerRef {
  current: Viewer | null;
  onReady?: () => void;
  /** A scrub preview; only the final gesture is dispatched as a host Command. */
  previewTransient?: (input: TransientInput) => Promise<void>;
}

const soon = (what: string, suggestion: string) => (): never => {
  throw new FemError('unsupported', `${what} is not built yet`, what, suggestion);
};

async function fetchExample(name: string): Promise<string> {
  const res = await fetch(`${import.meta.env.BASE_URL}examples/${name}.json`);
  if (!res.ok) throw new FemError('file.not-found', `no bundled example named '${name}'`, name, 'open the Examples panel for the list');
  return res.text();
}

async function fetchExampleMetadata(name: string): Promise<ActiveBenchmark> {
  const res = await fetch(`${import.meta.env.BASE_URL}examples/index.json`);
  if (!res.ok) throw new FemError('file.not-found', 'the bundled example index could not be read', name, 'reload the app and open Examples again');
  const entry = ((await res.json()) as { examples?: ExampleEntry[] }).examples?.find((example) => example.name === name);
  if (!entry || typeof entry.theory !== 'string' || typeof entry.expected?.reference !== 'string') {
    throw new FemError('file.not-found', `no bundled example named '${name}'`, name, 'open the Examples panel for the list');
  }
  return attachComparison(entry);
}

export const autosave: Autosave = makeAutosave({
  // a browser with IndexedDB blocked (private mode, or a headless test) keeps working: the
  // autosave is then simply per-session, and file.save is still there.
  store: typeof indexedDB === 'undefined' ? memoryStore() : indexedDbStore(indexedDB),
  initiallyOn: localStorage.getItem('femlab.autosave') !== 'off',
  onError: (e) => console.warn('autosave failed', e),
});

/** Read once at boot so `query.autosave` can answer without waiting on IndexedDB. */
let lastSaved: AutosaveState['saved'] = null;
let lastAutosaves: AutosaveVersion[] = [];

const summary = (saved: { id?: string; name: string; at: number; cmds: unknown[] }): AutosaveVersion => ({
  id: saved.id ?? `legacy-${saved.at}`,
  name: saved.name,
  at: saved.at,
  commands: saved.cmds.length,
});

/** The other half of the boot hook: `await primeAutosave();` before the start screen renders. */
export async function primeAutosave(): Promise<AutosaveState['saved']> {
  const saved = await autosave.read();
  lastAutosaves = (await autosave.readAll()).map(summary);
  lastSaved = saved && { name: saved.name, at: saved.at, commands: saved.cmds.length };
  return lastSaved;
}

/**
 * The boot hook proper: one line at the end of `main.tsx`'s `refresh()`, which already runs
 * after every journaled Command and has just re-read the Model and the Journal.
 */
export function noteAutosave(name: string, journal: { cmd: unknown }[]): void {
  // Boot refreshes before any Command; an empty Journal is nothing to restore (issue #48).
  if (!autosave.enabled() || journal.length === 0) return;
  autosave.note(name, journal as never);
  lastSaved = { name, at: Date.now(), commands: journal.length };
  lastAutosaves = autosave.history().map(summary);
}

/** The UI copy of the bounded history, including a debounced newest snapshot. */
export function autosaveHistory(): AutosaveVersion[] {
  return lastAutosaves.slice();
}


export interface SessionHostServices {
  projects: Projects;
  active(): Promise<void>;
  replay(commands: ShareCommand[], benchmark?: ActiveBenchmark): Promise<void>;
}

const missingSession = (): never => { throw new FemError('session.expired', 'this host has no captured project session'); };
const unboundSession: SessionHostServices = {
  active: missingSession, replay: missingSession,
  projects: { prime: missingSession, list: missingSession, current: missingSession, new: missingSession,
    open: missingSession, rename: missingSession, delete: missingSession, save: missingSession,
    setEnabled: missingSession, enabled: missingSession, flush: missingSession },
};

export function makeHostContext(
  store: Store,
  transport: EngineTransport,
  viewer: ViewerRef,
  host: HostCaps,
  scripts?: ScriptHost,
  results?: ResultsView,
  save: Autosave = autosave,
  printPage: () => void = () => window.print(),
  captureEnvironment: AnimationCaptureEnvironment = browserAnimationCaptureEnvironment(),
  _refresh: () => Promise<void> = async () => undefined,
  session: SessionHostServices = unboundSession,
): HostContext {
  const own = session.projects;
  const capture = new AnimationCapture(captureEnvironment);
  const v = (): Viewer => {
    if (!viewer.current) throw new FemError('unsupported', 'the viewer has not been mounted yet', 'viewer', 'wait for the start screen to hand over to the app');
    return viewer.current;
  };
  return {
    transport,
    view: {
      fit: () => v().fit(),
      setCamera: (c) => v().setCamera(c as CameraState),
      preset: (p) => v().preset(p),
      setProjection: (p) => v().setProjection(p),
      showField: (f) => {
        v();
        return results?.showField(f as { field: string | null; component?: number | null });
      },
      setLegend: (l) => {
        if (!results) {
          if (!l.colormap) return;
          store.set({ colormap: l.colormap as ColormapName });
          v().setColormap(l.colormap as ColormapName);
          return;
        }
        return results.setLegend(l as { colormap?: string; range?: [number, number] | 'auto' });
      },
      setDeformScale: (s) => {
        if (!results) return store.set({ deformScale: typeof s === 'number' ? s : 1 });
        v();
        results.setDeformScale(s);
      },
      setClip: (p) => {
        store.set({ clipOn: p !== null });
        v().setClip(p ? { normal: p.normal, offset: p.offset } : null);
      },
      toggle: (layer, on) => {
        const visible = v().setLayer(layer, on);
        store.set({ layerVisibility: { ...store.state.layerVisibility, [layer]: visible } });
      },
      setVisible: (bodies, on) => {
        v().setVisible(bodies, on);
        store.set({ hiddenBodies: visibilityReducer(store.state.hiddenBodies, bodies, on) });
      },
      highlight: (s) => viewer.current?.setHighlight(s),
      setTheme: (t) => {
        store.set({ theme: t });
        document.documentElement.dataset['theme'] = t;
        v().setTheme(t);
      },
      animate: (a) => {
        v();
        if (!results) throw new FemError('unsupported', 'no Result host is available', 'view.animate', 'solve a Step in the app');
        return results.animate(a);
      },
      playTransient: (a) => {
        v();
        if (!results) throw new FemError('unsupported', 'no Result host is available', 'view.playTransient', 'solve a transient Step in the app');
        return results.playTransient(a);
      },
      camera: () => v().getCamera() as never,
      screenshot: async (o) => {
        const burn = o.legend === false ? null : results?.legendBurn();
        return { png: v().screenshot(burn ? { ...burn, colormap: burn.colormap as ColormapName } : undefined, o) };
      },
      captureAnimation: (o) =>
        capture.run(async (record) => {
          const s = store.state;
          const mode = choiceOf(s.fieldKey).mode;
          const modes = s.result?.frequencies?.length ?? 0;
          if (mode === undefined || mode < 1 || mode > modes) {
            throw new FemError('export.unavailable', 'the selected field is not a mode in the current modal Result', 'file.export', 'solve a modal Step and select one of its mode fields');
          }
          const target = v();
          const before = target.animationState();
          const ui = { playing: s.playing, phase: s.phase };
          store.set({ capturingAnimation: true, playing: false });
          target.setPhase(0);
          try {
            const webm = await target.atCaptureSize(o.width, o.height, (canvas) => record(canvas, o, (phase) => target.setPhase(phase)));
            return { webm };
          } finally {
            target.restoreAnimation(before);
            store.set({ capturingAnimation: false, ...ui });
          }
        }),
      cancelAnimationCapture: () => capture.cancel(),
    },
    selection: {
      set: async (s) => {
        invalidateDefinition(store);
        store.select(s);
        const ref = s.refs?.[0];
        const item = ref ? treeGroups(store.state).flatMap((group) => group.items).find((candidate) => `${candidate.kind}:${candidate.name}` === ref) : undefined;
        if (item?.cmd === 'form.edit') await editDefinition(store, transport, item.args as DefinitionTarget);
        else if (item && !item.run) store.openForm(item.cmd, item.args);
      },
      clear: () => {
        invalidateDefinition(store);
        store.set({ selection: EMPTY_SELECTION });
      },
      setPickTarget: (t) => store.set({ pickTarget: t }),
      get: (): Selection => store.state.selection,
    },
    panels: {
      toggle: (panel, open) => store.togglePanel(panel, open),
      resize: (panel, size) => store.resizePanel(panel, size),
    },
    report: {
      print: () => {
        if (!store.state.panels['report'] || !store.state.reportReady) {
          throw new FemError('unsupported', 'the calculation note is not ready to print', 'report', 'open Report and wait for its paper and viewer figure');
        }
        printPage();
      },
    },
    script: {
      validate: (code, timeoutMs) => {
        if (!scripts) throw new FemError('unsupported', 'no validation Worker is available', 'query.validateScript', 'run the app with script workers');
        return scripts.validate(code, timeoutMs);
      },
      // A script's Commands are the AI's, not the person's: the Journal's `who` column says so.
      run: async (code, timeoutMs) => {
        if (!scripts) throw new FemError('unsupported', 'no script Worker is available in this host', 'script.run', 'run the app, not the test harness');
        if (scripts.running) throw new FemError('unsupported', 'a script or validation is already running', 'script.run', 'stop it with script.stop first');
        store.set({ scriptRunning: true, scriptOut: [], source: 'ai', tab: 'script' });
        try {
          const out = await scripts.run(code, timeoutMs);
          store.set({ scriptOut: [...out.console, ...(out.error ? [`✕ ${out.error}`] : [`› ${out.result === null ? 'done' : JSON.stringify(out.result)}`])] });
          if (out.error) store.log('error', `script: ${out.error}`);
          return out;
        } finally {
          store.set({ scriptRunning: false, source: 'you' });
        }
      },
      stop: () => scripts?.stop(),
      setSource: (code, append) =>
        store.set({
          scriptDraft: append === true ? `${store.state.scriptDraft ?? store.state.script}${code}` : code,
          scriptEditing: true,
          tab: 'script',
        }),
      setEditing: (scriptEditing) =>
        store.set({
          scriptDraft: scriptEditing ? (store.state.scriptDraft ?? store.state.script) : store.state.scriptDraft,
          scriptEditing,
          tab: 'script',
        }),
    },
    // The drawer rebinds these the moment it mounts; until then they are no-ops, so a
    // `chat.send` from a script or the palette never throws at a person. The `import()` keeps
    // the two AI SDKs off the boot path: a static `chatBridge` import would drag `src/ai/**`,
    // and with it @anthropic-ai/sdk and openai, into the landing chunk.
    chat: {
      send: (text) => import('./ai').then(async (m) => { await session.active(); return m.chatBridge.send(text); }),
      insertMention: (ref) => import('./ai').then(async (m) => { await session.active(); return m.chatBridge.insertMention(ref); }),
      setDraft: (text) => import('./ai').then(async (m) => { await session.active(); return m.chatBridge.setDraft(text); }),
      clear: () => import('./ai').then(async (m) => { await session.active(); return m.chatBridge.clear(); }),
    },
    skills: () => store.state.skills,
    clipboard: { writeText: (text) => navigator.clipboard.writeText(text) },
    files: {
      beginSave: () => store.beginSave(),
      markSaved: (journal) => store.markOpened(journal),
      pick: () =>
        new Promise<string>((resolve, reject) => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = '.json,application/json';
          input.onchange = () => {
            const file = input.files?.[0];
            if (!file) return reject(new FemError('file.not-found', 'no file was chosen', 'picker'));
            if (file.size > MAX_MODEL_FILE_BYTES) return reject(new FemError('schema', 'Model file exceeds the 16 MiB import limit', 'picker', 'open a smaller file written by file.save'));
            file.text().then(resolve, reject);
          };
          input.click();
        }),
      pickBytes: (accept) =>
        new Promise<Uint8Array>((resolve, reject) => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = accept;
          input.onchange = () => {
            const file = input.files?.[0];
            if (!file) return reject(new FemError('file.not-found', 'no file was chosen', 'picker'));
            if (file.size > MAX_GEOMETRY_FILE_BYTES) return reject(new FemError('schema', 'the geometry file exceeds the 32 MiB import limit', 'picker', 'decimate the mesh in the tool that wrote it'));
            file.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
          };
          input.click();
        }),
      download: (name, mime, data) => {
        const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }));
        const a = Object.assign(document.createElement('a'), { href: url, download: name });
        a.click();
        URL.revokeObjectURL(url);
      },
      // The Journal alone, not the whole `femlab/1` file: replay rebuilds the Model, and the
      // Commands deflate to a fraction of a Model snapshot.
      shareLink: async (file) => {
        const url = await shareUrl(
          file.journal.entries.map((e) => e.cmd as unknown as { cmd: string } & Record<string, unknown>),
          location.href,
        );
        await navigator.clipboard.writeText(url).catch(() => store.log('error', 'the link is below, but the clipboard refused it'));
        store.log('command', 'share link copied');
        return { url };
      },
      // The privacy switch. It stops writing; it never deletes what is already saved, because
      // with a background save into a project there is no "unsaved" copy to throw away.
      setAutosave: (on) => {
        own.setEnabled(on);
        save.setEnabled(on);
        localStorage.setItem('femlab.autosave', on ? 'on' : 'off');
      },
      restore: async (id) => {
        const revisions = await save.readAll();
        lastAutosaves = revisions.map(summary);
        const saved = id === undefined ? revisions[0] : revisions.find((revision) => revision.id === id);
        if (id !== undefined && !saved) {
          throw new FemError('not-found', `autosave revision '${id}' was not found`, 'file.restore.id', 'query.autosaveHistory to choose an available revision, then call file.restore with its id');
        }
        if (!saved) return null;
        await session.replay(saved.cmds);
        return { name: saved.name, at: saved.at, commands: saved.cmds.length };
      },
      autosave: () => ({ enabled: save.enabled(), saved: save.history()[0] ? summary(save.history()[0]!) : null }),
      autosaves: () => save.history().map(summary),
    },
    projects: {
      new: (name) => own.new(name),
      open: (id) => own.open(id),
      rename: (id, name) => own.rename(id, name),
      delete: (id) => own.delete(id),
      save: () => own.save(),
      list: () => own.list(),
      current: () => own.current(),
    },
    folder: {
      // The Assistant picker supplies the folder skill source; full folder I/O is #13.
      open: soon('the folder on disk', 'use file.open and file.save for now'),
      close: () => store.setFolder(null),
      refresh: async () => {
        const folder = store.state.folder;
        if (!folder) throw new FemError('file.not-found', 'no folder is open', 'folder', 'open a project folder in the Assistant');
        await folder.refresh();
        // Closing/replacing a folder while this read is in flight must not restore the old one.
        if (store.state.folder === folder) store.setFolder(folder);
      },

      info: () => null,
      readText: soon('the folder on disk', 'use file.open for now'),
      readBytes: soon('the folder on disk', 'use geometry.importFile with the picker for now'),
      writeText: soon('the folder on disk', 'use file.save for now'),
      writeBytes: soon('the folder on disk', 'use file.save for now'),
    },
    examples: { open: async (name) => {
      return openExample(name, session);
    } },
    ai: {
      setKey: (key, provider: AiProvider) => {
        storeKey(provider, key);
      },
      setModel: (model) => {
        localStorage.setItem('femlab.ai.model', model);
        store.set({ assistantModel: model });
      },
    },
    env: { webgpu: host.webgpu, crossOriginIsolated: host.crossOriginIsolated, threads: host.threads, userAgent: host.userAgent, engine: 'local' },
  };
}

/** Metadata and inputs are prepared before the session owner attempts activation. */
export async function openExample(name: string, session: SessionHostServices) {
  const benchmark = await fetchExampleMetadata(name);
  const entries = JSON.parse(await fetchExample(name)) as { cmd: ShareCommand }[];
  await session.replay(entries.map(entry => entry.cmd), benchmark);
  return { name, commands: entries.length };
}

type DefinitionTarget = { kind: 'body' | 'material' | 'set' | 'constraint' | 'load' | 'step'; name: string };
const definitionRequests = new WeakMap<Store, number>();

function invalidateDefinition(store: Store): number {
  const request = (definitionRequests.get(store) ?? 0) + 1;
  definitionRequests.set(store, request);
  return request;
}

/** Journal selection and form.edit share one request fence and the complete engine definition. */
async function editDefinition(store: Store, transport: EngineTransport, target: DefinitionTarget): Promise<void> {
  const request = invalidateDefinition(store);
  const previousForm = store.state.form;
  const revision = store.state.revision;
  const { command } = await transport.query({ query: 'query.definition', ...target }) as { command: { cmd: string } & Record<string, unknown> };
  if (request !== definitionRequests.get(store) || store.state.form !== previousForm || store.state.revision !== revision) return;
  const { cmd, ...args } = command;
  store.openForm(cmd, args);
}

/**
 * Shell Commands outside the shared registry include display controls, an example-open alias,
 * and putting a Command into the Properties form without running it (every
 * `+ add …` chip, every blocker fix link and the palette's ⇥). They go in through `Registry`'s
 * `hostCommands` option, so `registry.list()` still covers every `[data-cmd]` in the DOM.
 */
export function appHostCommands(store: Store, transport: EngineTransport, viewer: ViewerRef, _refresh: () => Promise<void>, _results?: ResultsView, registry?: () => Registry): HostDef[] {
  let intentRun = 0;
  return [
    {
      name: 'palette.resolve',
      execution: 'sessionView',
      description: 'Prepare natural-language intent as editable engine Command previews using the configured Assistant provider. Never executes the proposed Commands. Ambiguity and missing parameters are shown for clarification before opening Properties.',
      schema: z.object({ text: z.string().min(1) }),
      tool: false,
      run: async (input) => {
        const { text } = input as { text: string };
        if (store.state.paletteIntent?.status === 'loading' && store.state.paletteIntent.text === text) return null;
        const run = ++intentRun;
        const base = { text, modelHash: store.state.model?.hash ?? null, proposals: [], clarification: '' };
        store.set({ paletteIntent: { ...base, status: 'loading' } });
        try {
          if (!registry) throw new Error('Intent resolution is unavailable in this host.');
          const { resolvePaletteIntent } = await import('./ai/palette-intent');
          const result = await resolvePaletteIntent(text, registry(), store.state.objects);
          if (run === intentRun) store.set({ paletteIntent: { ...base, ...result, status: 'ready' } });
          return result;
        } catch (error) {
          if (run === intentRun) store.set({ paletteIntent: { ...base, status: 'error', clarification: error instanceof Error ? error.message : String(error) } });
          return null;
        }
      },
    },
    {
      name: 'view.setMode',
      execution: 'sessionView',
      description: 'Choose what the viewer draws: the Bodies (`geometry`), the Mesh (`mesh`) or the Result contours (`results`). Display only — the Model and the Journal are untouched and the mode survives every solve.',
      schema: z.object({ mode: z.enum(['geometry', 'mesh', 'results']) }),
      tool: true,
      run: (input) => {
        const { mode } = input as { mode: ViewMode };
        store.set({ viewMode: mode });
        viewer.current?.setMode(mode);
      },
    },
    {
      name: 'form.edit',
      execution: 'sessionView',
      description: 'Open an existing Model object in Properties using its complete current definition from query.definition. Preserves its type, quantities and optional parameters; Apply dispatches the returned upsert Command. Nothing changes until Apply.',
      schema: z.object({ kind: z.enum(['body', 'material', 'set', 'constraint', 'load', 'step']), name: z.string() }),
      tool: true,
      run: (input) => editDefinition(store, transport, input as DefinitionTarget),
    },
    {
      name: 'chat.setDraft',
      execution: 'sessionView',
      description: 'Replace the unsent Assistant draft with explicit text and open the drawer. Use this to insert a skill name for the person to complete with arguments; it does not invoke the skill or send a message.',
      schema: z.object({ text: z.string() }),
      tool: true,
      run: async (input, ctx) => {
        const { text } = input as { text: string };
        store.togglePanel('assistant', true);
        await ctx.chat.setDraft(text);
      },
    },
    {
      name: 'form.pick',
      execution: 'sessionView',
      description: 'Arm the next viewer face click to fill the explicit field path of an open Command form. `command` must name the currently open form; `field` names its argument path. This sets both the picking target and the form destination, without editing the Model or Journal.',
      schema: z.object({ command: z.string(), field: z.array(z.string().min(1)).min(1) }),
      tool: true,
      run: (input) => {
        const { command, field } = input as { command: string; field: string[] };
        if (store.state.form?.cmd !== command) throw new FemError('schema', 'the requested Command form is not open', 'command', `form.open for ${command} before form.pick`);
        store.set({ pickInto: field, pickTarget: 'face' });
      },
    },
    {
      name: 'form.open',
      execution: 'sessionView',
      description: 'Put a Command into the Properties form, pre-filled with `args`, without running it: `command` names the Command, `args` are its parameters so far. The person reads the fields, edits them and presses Apply; nothing reaches the Journal until they do. Use it to propose a Command rather than perform one.',
      schema: z.object({ command: z.string(), args: z.record(z.string(), z.unknown()).optional(), keepInitial: z.boolean().optional() }),
      tool: true,
      run: (input) => {
        const { command, args, keepInitial } = input as { command: string; args?: Record<string, unknown>; keepInitial?: boolean };
        store.openForm(command, args ?? {}, keepInitial === true);
      },
    },
    {
      name: 'example.filter',
      execution: 'workspace',
      description: 'Filter the Examples gallery by one metadata tag and one difficulty level. Pass `null` for either field to show every value in that dimension; this changes only the gallery view.',
      schema: z.object({ tag: z.string().nullable(), difficulty: z.number().int().min(1).max(3).nullable() }),
      tool: true,
      run: (input) => {
        const { tag, difficulty } = input as { tag: string | null; difficulty: ExampleDifficulty | null };
        store.set({ exampleFilter: { tag, difficulty } });
      },
    },
    {
      name: 'file.openExample',
      execution: 'replacement',
      description: "Open a bundled example by name (see the Examples panel). Alias of example.open: replay its Journal, refresh the Model and Results, and establish the saved baseline only after a complete open.",
      schema: z.object({ name: z.string() }),
      tool: true,
      run: async (input, ctx) => {
        const { name } = input as { name: string };
        return ctx.examples.open(name);
      },
    },
    {
      name: 'file.compare',
      execution: 'sessionView',
      description: 'Select a saved femlab/1 file as the Journal comparison baseline without opening it or changing the current Model. Returns ordered added and removed Command entries; the imported file is never replayed. The imported baseline remains selected until the next successful explicit save/open or new Model.',
      schema: z.union([z.object({ json: z.string() }), z.object({ picker: z.literal(true) })]),
      tool: true,
      run: async (input) => {
        const current = store.beginJournalComparison();
        const how = input as { json?: string; picker?: true };
        const text = how.json ?? await new Promise<string>((resolve, reject) => {
          const picker = document.createElement('input');
          picker.type = 'file';
          picker.accept = '.json,application/json';
          picker.onchange = () => {
            const file = picker.files?.[0];
            if (!file) return reject(new FemError('file.not-found', 'no file was chosen', 'picker'));
            file.text().then(resolve, reject);
          };
          picker.addEventListener('cancel', () => reject(new FemError('file.not-found', 'no file was chosen', 'picker')), { once: true });
          picker.click();
        });
        let file: { format?: unknown; journal?: unknown } | null;
        try {
          file = JSON.parse(text) as { format?: unknown; journal?: unknown };
        } catch (e) {
          throw new FemError('schema', `not a femlab/1 JSON file: ${(e as Error).message}`, 'json', 'use file.save to write a comparable Model file');
        }
        if (!file || typeof file !== 'object' || file.format !== 'femlab/1' || !file.journal || typeof file.journal !== 'object' || !Array.isArray((file.journal as { entries?: unknown }).entries)) {
          throw new FemError('schema', 'the comparison file is not a femlab/1 file with a Journal', 'file', 'use file.save to write a comparable Model file');
        }
        const importedJournal = file.journal as Journal;
        const diff = (await transport.query({ query: 'query.journalDiff', base: importedJournal })) as JournalDiff;
        if (current(diff)) store.set({ journalComparison: diff, comparisonSource: 'imported', comparisonBaseline: structuredClone(importedJournal.entries) });
        return diff;
      },
    },
  ] as HostDef[];
}

/** The current causal Journal comparison, exposed to the AI without exposing Store internals. */
export function appHostQueries(store: Store): HostDef[] {
  return [{
    name: 'query.journalComparison',
      execution: 'modelRead',
    description: 'Compare the current Journal with the selected imported file, or with the last successful explicit save/open when no imported comparison is selected. Returns ordered added and removed entries, or null when no baseline exists or a newer request/state supersedes this query. file.compare selects an imported baseline; a successful explicit save/open resets it to the saved baseline, and a new Model clears it. Autosave does not select a baseline.',
    schema: z.object({}),
    tool: true,
    run: () => store.refreshJournalComparison(),
  }];
}
