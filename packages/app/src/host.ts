// `HostContext` for the browser: the side effects every host Command in `@femlab/registry` is
// allowed to have, bound to this app's store and viewer. Nothing here reaches into the engine
// except through the transport, and nothing in the registry knows the DOM exists.
import { FemError, type HostContext, type HostDef, type JournalEntry, type ProjectMeta, type Selection } from '@femlab/registry';
import { z } from 'zod';
import { attachComparison, benchmarkProvenance, type ActiveBenchmark, type ExampleEntry } from './benchmark';
import type { HostCaps } from './capabilities';
import { indexedDbProjects, makeProjects, memoryProjects, type Projects } from './projects';
import type { ResultsView } from './results';
import type { ScriptHost } from './script-host';
import { type ShareCommand, shareUrl } from './share';
import { EMPTY_SELECTION, type Store, type ViewMode } from './store';
import type { ColormapName } from './viewer/colormap';
import type { CameraState, Viewer } from './viewer/viewer';
import type { WorkerTransport } from './worker-transport';

/**
 * The viewer exists only once the canvas is mounted and its chunk has arrived, so every host
 * Command reaches it lazily — and anything pushed to it before then (an example that opened
 * solved, a restored Journal) would be lost, which is what `onReady` is for: the shell calls it
 * the moment a Viewer exists, and the host answers by pushing the current surface and Result.
 */
export interface ViewerRef {
  current: Viewer | null;
  onReady?: () => void;
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

/**
 * The projects of this browser. Built by `makeHostContext`, because `project.open` replays a
 * Journal through the transport and `project.save` shoots the viewer, and neither exists at
 * import time; the three hooks below are what `main.tsx` needs and are safe to call before it.
 */
let projects: Projects | null = null;

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

export function makeHostContext(
  store: Store,
  transport: WorkerTransport,
  viewer: ViewerRef,
  host: HostCaps,
  scripts?: ScriptHost,
  results?: ResultsView,
  printPage: () => void = () => window.print(),
): HostContext {
  // A Journal replayed onto the engine, one Command at a time. As with an example: a Journal
  // that ends on a solve comes back solved on screen rather than as a Model with no Result.
  const replay = async (cmds: ShareCommand[]): Promise<void> => {
    let solved: unknown = null;
    for (const cmd of cmds) {
      const ack = await transport.dispatch(cmd as never);
      if (String(cmd.cmd).startsWith('solve.') || cmd.cmd === 'study.converge') solved = ack;
    }
    if (solved) await results?.onAck(solved);
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
      setVisible: (bodies, on) => v().setVisible(bodies, on),
      setTheme: (t) => {
        store.set({ theme: t });
        document.documentElement.dataset['theme'] = t;
        v().setTheme(t);
      },
      animate: (a) => v().animate(a.playing),
      camera: () => v().getCamera() as never,
      screenshot: async (o) => {
        const burn = o.legend === false ? null : results?.legendBurn();
        return { png: v().screenshot(burn ? { ...burn, colormap: burn.colormap as ColormapName } : undefined) };
      },
    },
    selection: {
      set: (s) => store.select(s),
      clear: () => store.set({ selection: EMPTY_SELECTION }),
      setPickTarget: (t) => store.set({ pickTarget: t }),
      get: (): Selection => store.state.selection,
    },
    panels: { toggle: (panel, open) => store.togglePanel(panel, open) },
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
      setSource: (code, append) => store.set({ scriptDraft: append === true ? `${store.state.scriptDraft ?? store.state.script}${code}` : code, tab: 'script' }),
    },
    // The drawer rebinds these the moment it mounts; until then they are no-ops, so a
    // `chat.send` from a script or the palette never throws at a person. The `import()` keeps
    // the two AI SDKs off the boot path: a static `chatBridge` import would drag `src/ai/**`,
    // and with it @anthropic-ai/sdk and openai, into the landing chunk.
    chat: {
      send: (text) => void import('./ai').then((m) => m.chatBridge.send(text)),
      insertMention: (ref) => void import('./ai').then((m) => m.chatBridge.insertMention(ref)),
      clear: () => void import('./ai').then((m) => m.chatBridge.clear()),
    },
    skills: () => store.state.skills,
    clipboard: { writeText: (text) => navigator.clipboard.writeText(text) },
    files: {
      pick: () =>
        new Promise<string>((resolve, reject) => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = '.json,application/json';
          input.onchange = () => {
            const file = input.files?.[0];
            if (!file) return reject(new FemError('file.not-found', 'no file was chosen', 'picker'));
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
        localStorage.setItem('femlab.autosave', on ? 'on' : 'off');
      },
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
    examples: { fetch: fetchExample },
    ai: {
      setKey: (key) => (key === null ? localStorage.removeItem('femlab.ai.key') : localStorage.setItem('femlab.ai.key', key)),
      setModel: (model) => localStorage.setItem('femlab.ai.model', model),
    },
    env: { webgpu: host.webgpu, crossOriginIsolated: host.crossOriginIsolated, threads: host.threads, userAgent: host.userAgent, engine: 'local' },
  };
}

/**
 * Three Commands the design's shell needs that `@femlab/registry` does not declare: the display
 * mode segmented control, opening a bundled example that is a Journal rather than a saved
 * `femlab/1` file, and putting a Command into the Properties form without running it (every
 * `+ add …` chip, every blocker fix link and the palette's ⇥). They go in through `Registry`'s
 * `hostCommands` option, so `registry.list()` still covers every `[data-cmd]` in the DOM.
 */
export function appHostCommands(store: Store, transport: WorkerTransport, viewer: ViewerRef, refresh: () => Promise<void>, results?: ResultsView): HostDef[] {
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
      name: 'file.openExample',
      description: "Open a bundled example by name (see the Examples panel). Its Journal is dispatched Command by Command onto the current Model, so you end up with the example's own Journal rather than an opaque file. Use query.model afterwards to see what it built.",
      schema: z.object({ name: z.string() }),
      tool: true,
      run: async (input) => {
        const { name } = input as { name: string };
        const benchmark = await fetchExampleMetadata(name);
        const entries = JSON.parse(await fetchExample(name)) as { cmd: Record<string, unknown> }[];
        // From this point the current Model is being replaced. Do not leave the old example's
        // theory beside a partial replay if a later Command fails.
        store.set({ benchmark: null, study: null });
        // An example that ends on solve.run opens solved, and a solved Model is shown as one:
        // the last solve's Ack goes where the Solve button's would (results tab, contours).
        let solved: unknown = null;
        let study: unknown = null;
        for (const e of entries) {
          const ack = await transport.dispatch(e.cmd as never);
          if (String(e.cmd.cmd).startsWith('solve.')) solved = ack;
          if (e.cmd.cmd === 'study.converge') study = ack;
        }
        // The gallery has done its job; leaving it up hides the Model it just opened.
        store.togglePanel('examples', false);
        await refresh();
        if (study) await results?.onAck(study);
        if (solved) await results?.onAck(solved);
        store.set({ benchmark: { ...benchmark, ...benchmarkProvenance(store.state.model, store.state.journal, store.state.revision) } });
        return { name, commands: entries.length };
      },
    },
  ] as HostDef[];
}
