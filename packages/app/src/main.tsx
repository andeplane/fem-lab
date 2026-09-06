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
import { devApiKeys } from './dev-keys';
import { appHostCommands, appHostQueries, forkProject, makeHostContext, noteProject, primeProjects, type ViewerRef } from './host';
import { ResultsView } from './results';
import { ScriptHost } from './script-host';
import { openShared } from './share';
import { Store } from './store';
import { App } from './ui/App';
import './ui/style.css';
import { WorkerTransport } from './worker-transport';

declare global {
  interface Window {
    fem: Fem & { registry: Registry; dispatch: Registry['dispatch']; gpuSelfTest(n: number): Promise<number> };
  }
}

const store = new Store();
const viewer: ViewerRef = { current: null };
const root = document.getElementById('app')!;

async function boot(): Promise<void> {
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

  const results = new ResultsView(store, transport, viewer);
  const ctx = makeHostContext(store, transport, viewer, host, scripts, results);
  // One sink is enough: the transport runs one Command at a time, so `Solving n %` can only
  // ever be about the Command the person is waiting for.
  transport.onProgress((p) => store.set({ progress: { phase: p.phase, fraction: p.fraction ?? 0 } }));
  // A Viewer that arrives after the Model did (the canvas mounts with the workspace, three.js is
  // a lazy chunk) asks for everything again, so an example that opened solved is drawn solved.
  viewer.onReady = () => {
    viewer.current?.setMode(store.state.viewMode);
    void refresh().catch(() => undefined);
  };
  const refresh = async (): Promise<void> => {
    const model = (await transport.query({ query: 'query.model' })) as never;
    const journal = (await transport.query({ query: 'query.journal' })) as never;
    const script = ((await transport.query({ query: 'query.script' })) as { text: string }).text;
    const objects = ((await transport.query({ query: 'query.objects' })) as { objects: never[] }).objects;
    store.set({ model, journal, script, objects, revision: (model as { revision: number }).revision });
    await store.refreshJournalComparison();
    viewer.current?.setSurface(await transport.surface());
    await results.refresh();
    // Where a project comes from: with none open and a non-empty Journal this creates one named
    // after the Model, and otherwise it debounces a write into the one that is open (issue #41).
    noteProject(store.state.model?.name ?? 'untitled', store.state.journal?.entries ?? [], (model as { hash: string | null }).hash);
  };
  const registry = new Registry({
    schema: schema as unknown as EngineSchema,
    host: ctx,
    hostCommands: [...HOST_COMMANDS, ...appHostCommands(store, transport, viewer, refresh, results)],
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
   * has to catch up. `file.open` and `example.open` replace the whole Model through the
   * transport, so without this the tree, the Journal and the new project all lag a Command
   * behind; `file.openExample` refreshes on its own way out and needs no row here.
   */
  const REFRESHES = new Set(['file.export', 'file.save', 'file.open', 'example.open', 'project.new', 'project.open']);

  /** One entry point for the UI, the console and (later) the AI; every call is logged and re-reads the Model. */
  const dispatch: Registry['dispatch'] = async (cmd) => {
    store.set({ lastError: null });
    // Before, not after: `file.openExample` refreshes on its own way out, and by then the fork
    // has to have happened or the example is written over the project it replaced.
    if (REPLACES_MODEL.has(cmd.cmd)) forkProject();
    // A long Command owns the Solve button and the solving card until it settles either way.
    const long = cmd.cmd === 'solve.run' || cmd.cmd === 'study.converge';
    if (long) store.set({ solving: String(cmd['step'] ?? ''), progress: { phase: 'starting', fraction: 0 } });
    try {
      const ack = await registry.dispatch(cmd);
      if (cmd.cmd === 'model.new') store.newDocument();
      store.log('command', cmd.cmd);
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
  };
  const query: Registry['query'] = (q) => registry.query(q);
  late.dispatch = dispatch;
  late.query = query;

  const proxy = makeFemProxy(dispatch, query) as unknown as Record<string, unknown>;
  window.fem = new Proxy({} as Window['fem'], {
    get: (_t, k: string | symbol) =>
      k === 'registry' ? registry : k === 'dispatch' ? dispatch : k === 'gpuSelfTest' ? (n: number) => transport.gpuSelfTest(n) : proxy[k as string],
  });

  // The Assistant's tool calls and the tutorial's "do it for me" go through the same wrapper
  // as a click, so the Journal, the tree and the viewer surface all catch up either way.
  const panelRegistry = new Proxy(registry, { get: (t, k) => (k === 'dispatch' ? dispatch : Reflect.get(t, k, t)) });
  store.dispatch = dispatch;
  render(<App store={store} dispatch={dispatch} viewer={viewer} query={query} commands={registry.list().commands} registry={panelRegistry} />, root);

  // The Recent projects list is what the start screen leads with, so it is read before the
  // 3.2 MB wasm module rather than after it.
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
