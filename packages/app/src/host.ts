// `HostContext` for the browser: the side effects every host Command in `@femlab/registry` is
// allowed to have, bound to this app's store and viewer. Nothing here reaches into the engine
// except through the transport, and nothing in the registry knows the DOM exists.
import { FemError, type HostContext, type HostDef, type Selection } from '@femlab/registry';
import { z } from 'zod';
import type { HostCaps } from './capabilities';
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

export function makeHostContext(store: Store, transport: WorkerTransport, viewer: ViewerRef, host: HostCaps): HostContext {
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
      // No Result exists yet, so a field can only be turned off; the mode still follows the ask.
      showField: (f) => {
        v().setField(null, [0, 1]);
        store.set({ viewMode: 'field' in f && f.field ? 'results' : 'geometry' });
      },
      setLegend: (l) => {
        if (!l.colormap) return;
        store.set({ colormap: l.colormap as ColormapName });
        v().setColormap(l.colormap as ColormapName);
      },
      setDeformScale: (s) => {
        const scale = typeof s === 'number' ? s : s === 'true' ? 1 : 100;
        store.set({ deformScale: scale });
        v().setDeformed(null, scale);
      },
      setClip: (p) => v().setClip(p ? { normal: p.normal, offset: p.offset } : null),
      toggle: (layer, on) => v().setLayer(layer, on ?? true),
      setVisible: (bodies, on) => v().setVisible(bodies, on),
      setTheme: (t) => {
        store.set({ theme: t });
        document.documentElement.dataset['theme'] = t;
        v().setTheme(t);
      },
      animate: (a) => v().animate(a.playing),
      camera: () => v().getCamera() as never,
      screenshot: async () => ({ png: v().screenshot() }),
    },
    selection: {
      set: (s) => store.select(s),
      clear: () => store.set({ selection: EMPTY_SELECTION }),
      setPickTarget: (t) => store.set({ pickTarget: t }),
      get: (): Selection => store.state.selection,
    },
    panels: { toggle: (panel, open) => store.togglePanel(panel, open) },
    script: {
      run: soon('script.run', 'call window.fem from the console until the script Worker lands'),
      stop: soon('script.stop', 'no script Worker runs yet'),
      setSource: soon('script.setSource', 'the Script tab is read-only until the script Worker lands'),
    },
    chat: {
      send: soon('the AI assistant', 'drive the registry with window.fem for now'),
      insertMention: soon('the AI assistant', 'drive the registry with window.fem for now'),
      clear: soon('the AI assistant', 'drive the registry with window.fem for now'),
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
 * Two Commands the design's shell needs that `@femlab/registry` does not declare: the display
 * mode segmented control, and opening a bundled example that is a Journal rather than a saved
 * `femlab/1` file. They go in through `Registry`'s `hostCommands` option, so `registry.list()`
 * still covers every `[data-cmd]` in the DOM.
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
