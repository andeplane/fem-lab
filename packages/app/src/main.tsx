import { migratePersistentKeys } from './ai/key-storage';
import { browserScriptValidator } from './script-validation-host';
// Boot (plan B §7.4): capabilities → engine Worker → Registry → `window.fem` → `<App/>`.
// The shell renders first and the engine arrives into it, so the start screen is on screen
// before the 3.2 MB wasm module has finished downloading.
import { HOST_COMMANDS, HOST_QUERIES, Registry, makeFemProxy, type Capabilities, type EngineSchema, type Fem } from '@femlab/registry';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import { render } from 'preact';
import schema from '../../registry/src/generated/engine.schema.json';
import { capabilityNotes, readHostCaps } from './capabilities';
import { clearsBenchmark } from './benchmark';
import { devApiKeys } from './dev-keys';
import { appHostCommands, appHostQueries, autosaveHistory, noteAutosave, primeAutosave, forkProject, makeHostContext, noteProject, primeProjects, type ViewerRef } from './host';
import { ResultsView } from './results';
import { ScriptHost } from './script-host';
import { openShared } from './share';
import { Store } from './store';
import { App } from './ui/App';
import './ui/style.css';
import { WorkerTransport } from './worker-transport';
import { serializeModelDispatch } from './model-dispatch';

declare global {
  interface Window {
    fem: Fem & { registry: Registry; dispatch: Registry['dispatch']; gpuSelfTest(n: number): Promise<number> };
  }
}

const store = new Store();
const viewer: ViewerRef = { current: null };
const root = document.getElementById('app')!;

async function boot(): Promise<void> {
  migratePersistentKeys();
  const host = readHostCaps();
  store.set({ hostCaps: host, notes: capabilityNotes(host, null) });

  const transport = new WorkerTransport(() => new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' }), {
    gpu: host.webgpu,
    threads: host.threads,
  });

  // Queue `create` before anything else can be dispatched, but do not wait for it: the shell
  // renders while the 3.2 MB wasm module is still on the wire, and the transport's queue keeps
  // any early `window.fem` call behind the engine's construction.
  const booted = transport.init();

  // The script Worker's `fem` goes back through the Registry, which does not exist yet, so its
  // two calls are bound late.
  const late: { dispatch: Registry['dispatch']; query: Registry['query'] } = { dispatch: async () => undefined, query: async () => undefined };
  const scripts = new ScriptHost(
    () => new Worker(new URL('./script.worker.ts', import.meta.url), { type: 'module' }),
    (p) => late.dispatch(p as { cmd: string }),
    (p) => late.query(p as { query: string }),
    browserScriptValidator(() => new Worker(new URL('./script-validation.worker.ts', import.meta.url), { type: 'module' })),
  );

  const results = new ResultsView(store, transport, viewer, {
    now: () => performance.now(),
    schedule: (callback, ms) => setTimeout(callback, ms),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
  const ctx = makeHostContext(store, transport, viewer, host, scripts, results, undefined, undefined, undefined, () => refresh());
  // One sink is enough: the transport runs one Command at a time, so `Solving n %` can only
  // ever be about the Command the person is waiting for.
  transport.onProgress((p) => store.set({ progress: { phase: p.phase, fraction: p.fraction ?? 0 } }));
  // A Viewer that arrives after the Model did (the canvas mounts with the workspace, three.js is
  // a lazy chunk) asks for everything again, so an example that opened solved is drawn solved.
  viewer.onReady = () => {
    viewer.current?.setMode(store.state.viewMode);
    for (const [layer, visible] of Object.entries(store.state.layerVisibility)) viewer.current?.setLayer(layer, visible);
    viewer.current?.setVisible(store.state.hiddenBodies, false);
    void refresh().catch(() => undefined);
  };
  const refresh = async (): Promise<void> => {
    const model = (await transport.query({ query: 'query.model' })) as never;
    const journal = (await transport.query({ query: 'query.journal' })) as never;
    const script = ((await transport.query({ query: 'query.script' })) as { text: string }).text;
    const objects = ((await transport.query({ query: 'query.objects' })) as { objects: never[] }).objects;
    store.set({ model, journal, script, objects, revision: (model as { revision: number }).revision });
    await store.refreshJournalComparison();
    await results.refresh();
    // Where a project comes from: with none open and a non-empty Journal this creates one named
    // after the Model, and otherwise it debounces a write into the one that is open (issue #41).
    noteAutosave(store.state.model?.name ?? 'untitled', store.state.journal?.entries ?? []);
    store.set({ autosaves: autosaveHistory() });
    noteProject(store.state.model?.name ?? 'untitled', store.state.journal?.entries ?? [], (model as { hash: string | null }).hash);
  };
  const registry: Registry = new Registry({
    schema: schema as unknown as EngineSchema,
    host: ctx,
    hostCommands: [...HOST_COMMANDS, ...appHostCommands(store, transport, viewer, refresh, results, () => registry)],
    hostQueries: [...HOST_QUERIES, ...appHostQueries(store)],
  });

  /**
   * The Commands that replace the whole Model, and so start a project rather than overwrite the
   * one that is open. `example.open` is the registry's own and easy to miss; a share link's
   * replay is covered because its first Command is `model.new`. `project.new` and `project.open`
   * do their own bookkeeping and go through the transport, so they are deliberately absent.
   */
  const REPLACES_MODEL = new Set(['model.new', 'file.open', 'file.openExample', 'example.open']);
  /**
   * Host Commands after which the Model, the Journal or the project has changed and the shell
   * has to catch up. `file.open` replaces the whole Model through the
   * transport, so without this the tree, the Journal and the new project all lag a Command
   * behind; both example-open Commands refresh internally and need no row here.
   * `geometry.importFile` reads a file the host owns and dispatches `geometry.import`, so the
   * Model gains a Body the tree and the viewer have to see.
   */
  const REFRESHES = new Set(['file.restore', 'file.export', 'file.save', 'file.open', 'project.new', 'project.open', 'geometry.importFile']);

  // Preserve the provider dispatch before decorating the public registry. Instrumentation can
  // wrap registry.dispatch without the provider call recursing back through that wrapper.
  const registryDispatch = registry.dispatch.bind(registry);
  /** One entry point for the UI, the console and (later) the AI; every call is logged and re-reads the Model. */
  registry.dispatch = serializeModelDispatch(registry, async (cmd) => {
    store.set({ lastError: null });
    // Both example Commands refresh internally, so the fork must happen before dispatch: it
    // prevents that refresh from writing over the project being replaced.
    const opensExample = cmd.cmd === 'file.openExample' || cmd.cmd === 'example.open';
    if (opensExample) forkProject();
    if (registry.describe(cmd.cmd).provider === 'engine' || ['file.open', 'file.restore', 'example.open', 'script.run', 'geometry.importFile'].includes(cmd.cmd)) results.invalidateTransient();
    // A long Command owns the Solve button and the solving card until it settles either way.
    const long = cmd.cmd === 'solve.run' || cmd.cmd === 'study.converge';
    if (long) store.set({ solving: String(cmd['step'] ?? ''), progress: { phase: 'starting', fraction: 0 } });
    try {
      const ack = await registryDispatch(cmd);
      if (cmd.cmd === 'model.new') store.newDocument();
      if (REPLACES_MODEL.has(cmd.cmd) && !opensExample) forkProject();
      store.log('command', cmd.cmd);
      if (clearsBenchmark(cmd.cmd, ack)) store.set({ benchmark: null });
      if (clearsBenchmark(cmd.cmd, ack) || opensExample) {
        // A replacement owns a fresh set of model targets. Invalidate pending definition
        // reads before clearing their form, even when both Models have the same revision.
        ctx.selection.clear();
        viewer.current?.setHighlight({});
        viewer.current?.setVisible(store.state.hiddenBodies, true);
        if (cmd.cmd === 'project.new' || cmd.cmd === 'model.new') {
          viewer.current?.setMode('geometry');
          store.set({ viewMode: 'geometry' });
        }
        store.set({
          form: null, formError: null, formHints: null,
          pickInto: null, pickTarget: 'off', hiddenBodies: [], paletteIntent: null,
          journalWho: {}, lastError: null,
          panels: Object.fromEntries(Object.entries(store.state.panels).filter(([key]) => !key.startsWith('tree.menu.'))),
        });
      }
      // `file.export` is a host Command that runs the engine's `mesh.export`, which the engine
      // journals like any other, and `file.open` / `example.open` replace the engine Model and
      // Journal outright, so the store, viewer and Results have to catch up after those too.
      if (registry.describe(cmd.cmd).provider === 'engine' || REFRESHES.has(cmd.cmd)) {
        const { seq } = ack as { seq?: number };
        if (typeof seq === 'number' && seq >= 0) store.set({ journalWho: { ...store.state.journalWho, [seq]: { who: store.state.source, at: Date.now() } } });
        await refresh();
      }
      await results.onAck(ack);
      return ack;
    } catch (e) {
      store.fail(e);
      throw e;
    } finally {
      if (long) store.set({ solving: null, progress: null });
    }
  });
  const dispatch: Registry['dispatch'] = (cmd) => registry.dispatch(cmd);
  const query: Registry['query'] = (q) => registry.query(q);
  late.dispatch = dispatch;
  late.query = query;

  // Expose the same dispatch through the explicit registry, panels and generated proxy.
  const proxy = makeFemProxy(dispatch, query) as unknown as Record<string, unknown>;
  window.fem = new Proxy({} as Window['fem'], {
    get: (_t, k: string | symbol) =>
      k === 'registry' ? registry : k === 'dispatch' ? dispatch : k === 'gpuSelfTest' ? (n: number) => transport.gpuSelfTest(n) : proxy[k as string],
  });

  // The Assistant's tool calls and the tutorial's "do it for me" go through the same wrapper
  // as a click, so the Journal, the tree and the viewer surface all catch up either way.
  store.dispatch = dispatch;
  render(<App store={store} dispatch={dispatch} viewer={viewer} query={query} commands={registry.list().commands} registry={registry} />, root);

  // The Recent projects list is what the start screen leads with, so it is read before the
  // 3.2 MB wasm module rather than after it.
  void primeAutosave().then(() => store.set({ autosaves: autosaveHistory() })).catch((e: unknown) => store.fail(e));
  void primeProjects().catch((e: unknown) => store.fail(e));

  // Lazy, but not late: three.js is the chunk the very next click needs, so it is fetched now,
  // in parallel with the wasm, rather than when the first Body appears. `<link rel=modulepreload>`
  // in the built `index.html` (vite.config.ts) has already started this fetch by here.
  void import('./viewer/viewer').catch(() => undefined);

  await booted;
  const engineCaps = (await query({ query: 'query.capabilities' })) as Capabilities;
  store.set({ engineCaps, ready: true, notes: capabilityNotes(host, engineCaps) });
  store.log('engine', `engine ${engineCaps.engineVersion}, schema ${engineCaps.schemaVersion}`);
  if (devApiKeys()?.anthropic) store.log('engine', 'an ANTHROPIC_API_KEY from the dev shell is available to the assistant');
  await refresh();

  const example = new URLSearchParams(location.search).get('example');
  if (example) await dispatch({ cmd: 'file.openExample', name: example });
  await openShared({ dispatch }, location.hash);
}

if (typeof WebAssembly === 'undefined') {
  root.textContent = 'This browser cannot run FEM Lab: it has no WebAssembly.';
} else {
  boot().catch((e: unknown) => {
    store.fail(e);
    store.set({ ready: false });
    render(<App store={store} dispatch={async () => undefined} viewer={viewer} />, root);
  });
}
