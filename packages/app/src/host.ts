// `HostContext` for the browser: the side effects every host Command in `@femlab/registry` is
// allowed to have, bound to this app's store and viewer. Nothing here reaches into the engine
// except through the transport, and nothing in the registry knows the DOM exists.
import { FemError, type HostContext, type HostDef, type Selection } from '@femlab/registry';
import { z } from 'zod';
import { chatBridge } from './ai';
import type { HostCaps } from './capabilities';
import type { ResultsView } from './results';
import type { ScriptHost } from './script-host';
import { EMPTY_SELECTION, type Store, type ViewMode } from './store';
import type { ColormapName } from './viewer/colormap';
import type { CameraState, Viewer } from './viewer/viewer';
import type { WorkerTransport } from './worker-transport';

/** The viewer exists only once the canvas is mounted, so every host Command reaches it lazily. */
export interface ViewerRef {
  current: Viewer | null;
}

const soon = (what: string, suggestion: string) => (): never => {
  throw new FemError('unsupported', `${what} is not built yet`, what, suggestion);
};

async function fetchExample(name: string): Promise<string> {
  const res = await fetch(`${import.meta.env.BASE_URL}examples/${name}.json`);
  if (!res.ok) throw new FemError('file.not-found', `no bundled example named '${name}'`, name, 'open the Examples panel for the list');
  return res.text();
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
    // `chat.send` from a script or the palette never throws at a person.
    chat: chatBridge,
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
      shareLink: soon('file.shareLink', 'use file.save and send the file'),
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
export function appHostCommands(store: Store, transport: WorkerTransport, viewer: ViewerRef, refresh: () => Promise<void>): HostDef[] {
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
        for (const e of entries) await transport.dispatch(e.cmd as never);
        await refresh();
        return { name, commands: entries.length };
      },
    },
  ] as HostDef[];
}
