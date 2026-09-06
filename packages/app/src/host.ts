// `HostContext` for the browser: the side effects every host Command in `@femlab/registry` is
// allowed to have, bound to this app's store and viewer. Nothing here reaches into the engine
// except through the transport, and nothing in the registry knows the DOM exists.
import { FemError, type AutosaveState, type HostContext, type HostDef, type Selection } from '@femlab/registry';
import { z } from 'zod';
import type { HostCaps } from './capabilities';
import type { ResultsView } from './results';
import type { ScriptHost } from './script-host';
import { type Autosave, applyShared, indexedDbStore, makeAutosave, memoryStore, shareUrl } from './share';
import { EMPTY_SELECTION, type Store, type ViewMode } from './store';
import type { ColormapName } from './viewer/colormap';
import type { CameraState, Viewer } from './viewer/viewer';
import type { WorkerTransport } from './worker-transport';
import { treeGroups } from './ui/Tree';

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

/**
 * The autosave, and the last thing it wrote. It is created once here rather than in `main.tsx`
 * so `file.autosave`, `file.restore` and `query.autosave` all see the same one; the boot hook
 * only has to call `note` after every Command and `primeAutosave` once.
 * `ponytail: one autosave slot, not a list of them — versioning is what file.save is for.`
 */
export const autosave: Autosave = makeAutosave({
  // a browser with IndexedDB blocked (private mode, or a headless test) keeps working: the
  // autosave is then simply per-session, and file.save is still there.
  store: typeof indexedDB === 'undefined' ? memoryStore() : indexedDbStore(indexedDB),
  initiallyOn: localStorage.getItem('femlab.autosave') !== 'off',
  onError: (e) => console.warn('autosave failed', e),
});

/** Read once at boot so `query.autosave` can answer without waiting on IndexedDB. */
let lastSaved: AutosaveState['saved'] = null;

/** The other half of the boot hook: `await primeAutosave();` before the start screen renders. */
export async function primeAutosave(): Promise<AutosaveState['saved']> {
  const saved = await autosave.read();
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
}

export function makeHostContext(store: Store, transport: WorkerTransport, viewer: ViewerRef, host: HostCaps, scripts?: ScriptHost, results?: ResultsView): HostContext {
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
      toggle: (layer, on) => v().setLayer(layer, on ?? true),
      setVisible: (bodies, on) => v().setVisible(bodies, on),
      highlight: (s) => viewer.current?.setHighlight(s),
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
      set: (s) => {
        store.select(s);
        const ref = s.refs?.[0];
        const item = ref ? treeGroups(store.state).flatMap((group) => group.items).find((candidate) => `${candidate.kind}:${candidate.name}` === ref) : undefined;
        if (item && !item.run) store.openForm(item.cmd, item.args);
      },
      clear: () => store.set({ selection: EMPTY_SELECTION }),
      setPickTarget: (t) => store.set({ pickTarget: t }),
      get: (): Selection => store.state.selection,
    },
    panels: { toggle: (panel, open) => store.togglePanel(panel, open) },
    script: {
      // A script's Commands are the AI's, not the person's: the Journal's `who` column says so.
      run: async (code, timeoutMs) => {
        if (!scripts) throw new FemError('unsupported', 'no script Worker is available in this host', 'script.run', 'run the app, not the test harness');
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
    skills: () => [],
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
      setAutosave: (on) => {
        autosave.setEnabled(on);
        localStorage.setItem('femlab.autosave', on ? 'on' : 'off');
        if (on) return;
        lastSaved = null;
        void autosave.clear();
      },
      restore: async () => {
        const saved = await autosave.read();
        if (!saved) return null;
        // As with an example: a restored Journal that ends on a solve comes back solved on screen.
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
      autosave: () => ({ enabled: autosave.enabled(), saved: lastSaved }),
    },
    project: {
      open: soon('the project folder', 'use file.open and file.save for now'),
      close: soon('the project folder', 'use file.open and file.save for now'),
      refresh: soon('the project folder', 'use file.open and file.save for now'),
      info: () => null,
      readText: soon('the project folder', 'use file.open for now'),
      writeText: soon('the project folder', 'use file.save for now'),
      writeBytes: soon('the project folder', 'use file.save for now'),
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
        const entries = JSON.parse(await fetchExample(name)) as { cmd: Record<string, unknown> }[];
        // An example that ends on solve.run opens solved, and a solved Model is shown as one:
        // the last solve's Ack goes where the Solve button's would (results tab, contours).
        let solved: unknown = null;
        for (const e of entries) {
          const ack = await transport.dispatch(e.cmd as never);
          if (String(e.cmd.cmd).startsWith('solve.') || e.cmd.cmd === 'study.converge') solved = ack;
        }
        // The gallery has done its job; leaving it up hides the Model it just opened.
        store.togglePanel('examples', false);
        await refresh();
        if (solved) await results?.onAck(solved);
        return { name, commands: entries.length };
      },
    },
  ] as HostDef[];
}
