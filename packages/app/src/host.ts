// `HostContext` for the browser: the side effects every host Command in `@femlab/registry` is
// allowed to have, bound to this app's store and viewer. Nothing here reaches into the engine
// except through the transport, and nothing in the registry knows the DOM exists.
import { MAX_MODEL_FILE_BYTES, FemError, type AiProvider, type AutosaveState, type AutosaveVersion, type EngineTransport, type HostContext, type HostDef, type JournalEntry, type ProjectMeta, type Selection } from '@femlab/registry';
import { z } from 'zod';
import { storeKey } from './ai/key-storage';
import type { HostCaps } from './capabilities';
import { indexedDbProjects, makeProjects, memoryProjects, type Projects } from './projects';
import type { ResultsView } from './results';
import type { ScriptHost } from './script-host';
import { type Autosave, type ShareCommand, applyShared, indexedDbStore, makeAutosave, memoryStore, shareUrl } from './share';
import { EMPTY_SELECTION, type ExampleDifficulty, type Store, type ViewMode, visibilityReducer } from './store';
import type { ColormapName } from './viewer/colormap';
import type { CameraState, Viewer } from './viewer/viewer';
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

/**
 * The projects of this browser. Built by `makeHostContext`, because `project.open` replays a
 * Journal through the transport and `project.save` shoots the viewer, and neither exists at
 * import time; the three hooks below are what `main.tsx` needs and are safe to call before it.
 */
let projects: Projects | null = null;

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


/** A viewer screenshot cut down to a Recent card. `view.screenshot` renders at the canvas size
 *  and ignores `width`/`height`, so the downscale is a canvas draw here, not a screenshot option. */
async function thumbnailOf(viewer: ViewerRef, width = 320, height = 180): Promise<string | null> {
  const png = viewer.current?.screenshot();
  if (!png || typeof document === 'undefined') return null;
  const image = new Image();
  image.src = png;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL('image/webp', 0.7);
}

/** `await primeProjects();` at boot, before the start screen needs its Recent list. */
export async function primeProjects(): Promise<ProjectMeta[]> {
  return (await projects?.prime()) ?? [];
}

/**
 * The boot hook proper: one line at the end of `main.tsx`'s `refresh()`, which already runs
 * after every journaled Command and has just re-read the Model and the Journal. With no project
 * open and a non-empty Journal this is what creates one (issue #41).
 */
export function noteProject(name: string, entries: JournalEntry[], hash: string | null): void {
  // Boot refreshes before any Command; an empty Journal is not a project yet (issue #48).
  projects?.note(name, { entries }, hash);
}

/** Called before every Command that replaces the whole Model, so the next one forks a project. */
export function forkProject(): void {
  projects?.fork();
}

export function makeHostContext(store: Store, transport: EngineTransport, viewer: ViewerRef, host: HostCaps, scripts?: ScriptHost, results?: ResultsView, save: Autosave = autosave, refresh: () => Promise<void> = async () => undefined): HostContext {
  // A Journal replayed onto the engine, one Command at a time. As with an example: a Journal
  // that ends on a solve comes back solved on screen rather than as a Model with no Result.
  const replay = async (cmds: ShareCommand[]): Promise<void> => {
    let solved: unknown = null;
    for (const cmd of cmds) {
      const ack = await transport.dispatch(cmd as never);
      if (String(cmd.cmd).startsWith('solve.') || cmd.cmd === 'study.converge') solved = ack;
    }
    // Capture normalized replay output before Result restoration yields to another edit.
    const opened = await transport.exportFile();
    if (solved) await results?.onAck(solved);
    store.markSaved(opened.journal);
  };
  const own = makeProjects({
    // A browser with IndexedDB blocked (private mode, or a headless harness) keeps working:
    // projects are then per-session, the start screen says so, and file.save is still there.
    store: typeof indexedDB === 'undefined' ? memoryProjects() : indexedDbProjects(indexedDB),
    replay,
    reset: async (name) => void (await transport.dispatch({ cmd: 'model.new', name } as never)),
    thumbnail: () => thumbnailOf(viewer),
    initiallyOn: localStorage.getItem('femlab.autosave') !== 'off',
    onError: (e) => console.warn('the project save failed', e),
    onChange: () => store.set({ projects: own.list(), project: own.current() }),
  });
  projects = own;
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
    },
    selection: {
      set: (s) => store.select(s),
      clear: () => store.set({ selection: EMPTY_SELECTION }),
      setPickTarget: (t) => store.set({ pickTarget: t }),
      get: (): Selection => store.state.selection,
    },
    panels: {
      toggle: (panel, open) => store.togglePanel(panel, open),
      resize: (panel, size) => store.resizePanel(panel, size),
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
      setSource: (code, append) => store.set({ scriptDraft: append === true ? `${store.state.scriptDraft ?? store.state.script}${code}` : code, tab: 'script' }),
    },
    // The drawer rebinds these the moment it mounts; until then they are no-ops, so a
    // `chat.send` from a script or the palette never throws at a person. The `import()` keeps
    // the two AI SDKs off the boot path: a static `chatBridge` import would drag `src/ai/**`,
    // and with it @anthropic-ai/sdk and openai, into the landing chunk.
    chat: {
      send: (text) => void import('./ai').then((m) => m.chatBridge.send(text)),
      insertMention: (ref) => void import('./ai').then((m) => m.chatBridge.insertMention(ref)),
      setDraft: (text) => import('./ai').then((m) => m.chatBridge.setDraft(text)),
      clear: () => void import('./ai').then((m) => m.chatBridge.clear()),
    },
    skills: () => store.state.skills,
    clipboard: { writeText: (text) => navigator.clipboard.writeText(text) },
    files: {
      markSaved: (journal) => store.markSaved(journal),
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
        // As with an example: a restored Journal that ends on a solve comes back solved on screen.
        own.fork();
        let solved: unknown = null;
        await applyShared(
          {
            dispatch: async (cmd) => {
              const ack = await transport.dispatch(cmd as never);
              if (String(cmd.cmd).startsWith('solve.') || cmd.cmd === 'study.converge') solved = ack;
              return ack;
            },
          },
          saved.cmds,
        );
        if (solved) await results?.onAck(solved);
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
      writeText: soon('the folder on disk', 'use file.save for now'),
      writeBytes: soon('the folder on disk', 'use file.save for now'),
    },
    examples: { open: (name) => openExample(name, store, transport, refresh, results) },
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

/** Replay bundled Journals through the engine and publish a baseline only after a complete open. */
export async function openExample(name: string, store: Store, transport: EngineTransport, refresh: () => Promise<void>, results?: ResultsView) {
  const entries = JSON.parse(await fetchExample(name)) as { cmd: Record<string, unknown> }[];
  // An example that ends on solve.run opens solved, and a solved Model is shown as one:
  // the last solve's Ack goes where the Solve button's would (results tab, contours).
  let solved: unknown = null;
  let opened: Awaited<ReturnType<EngineTransport['exportFile']>>;
  try {
    for (const e of entries) {
      const ack = await transport.dispatch(e.cmd as never);
      if (String(e.cmd.cmd).startsWith('solve.') || e.cmd.cmd === 'study.converge') solved = ack;
    }
    opened = await transport.exportFile();
  } finally {
    // A rejected later Command can leave a partial Journal. Show that state, but never
    // replace the preceding saved baseline unless the entire open finishes successfully.
    await refresh();
  }
  // The gallery has done its job; leaving it up hides the Model it just opened.
  store.togglePanel('examples', false);
  if (solved) await results?.onAck(solved);
  // An example is an explicit open. Use the normalized Journal captured from the engine
  // before UI hydration, and establish the baseline only after the whole open succeeded.
  store.markSaved(opened.journal);
  return { name, commands: entries.length };
}

/**
 * Shell Commands outside the shared registry include display controls, an example-open alias,
 * and putting a Command into the Properties form without running it (every
 * `+ add …` chip, every blocker fix link and the palette's ⇥). They go in through `Registry`'s
 * `hostCommands` option, so `registry.list()` still covers every `[data-cmd]` in the DOM.
 */
export function appHostCommands(store: Store, transport: EngineTransport, viewer: ViewerRef, refresh: () => Promise<void>, results?: ResultsView): HostDef[] {
  let editRequest = 0;
  return [
    {
      name: 'view.setMode',
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
      description: 'Open an existing Model object in Properties using its complete current definition from query.definition. Preserves its type, quantities and optional parameters; Apply dispatches the returned upsert Command. Nothing changes until Apply.',
      schema: z.object({ kind: z.enum(['body', 'material', 'set', 'constraint', 'load', 'step']), name: z.string() }),
      tool: true,
      run: async (input) => {
        const target = input as { kind: 'body' | 'material' | 'set' | 'constraint' | 'load' | 'step'; name: string };
        const request = ++editRequest;
        const previousForm = store.state.form;
        const revision = store.state.revision;
        const { command } = await transport.query({ query: 'query.definition', ...target }) as { command: { cmd: string } & Record<string, unknown> };
        if (request !== editRequest || store.state.form !== previousForm || store.state.revision !== revision) return;
        const { cmd, ...args } = command;
        store.openForm(cmd, args);
      },
    },
    {
      name: 'chat.setDraft',
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
      description: "Open a bundled example by name (see the Examples panel). Alias of example.open: replay its Journal, refresh the Model and Results, and establish the saved baseline only after a complete open.",
      schema: z.object({ name: z.string() }),
      tool: true,
      run: async (input, ctx) => {
        const { name } = input as { name: string };
        return ctx.examples.open(name);
      },
    },
  ] as HostDef[];
}
