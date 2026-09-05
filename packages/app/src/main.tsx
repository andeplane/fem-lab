// Boot (plan B §7.4): capabilities → engine Worker → Registry → `window.fem` → `<App/>`.
// The shell renders first and the engine arrives into it, so the start screen is on screen
// before the 3.6 MB wasm module has finished downloading.
import { HOST_COMMANDS, Registry, makeFemProxy, type Capabilities, type EngineSchema, type Fem } from '@femlab/registry';
import { render } from 'preact';
import schema from '../../registry/src/generated/engine.schema.json';
import { capabilityNotes, readHostCaps } from './capabilities';
import { devApiKeys } from './dev-keys';
import { appHostCommands, makeHostContext, type ViewerRef } from './host';
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
  // renders while the 3.6 MB wasm module is still on the wire, and the transport's queue keeps
  // any early `window.fem` call behind the engine's construction.
  const booted = transport.init();

  const ctx = makeHostContext(store, transport, viewer, host);
  const refresh = async (): Promise<void> => {
    const model = (await transport.query({ query: 'query.model' })) as never;
    const journal = (await transport.query({ query: 'query.journal' })) as never;
    const script = ((await transport.query({ query: 'query.script' })) as { text: string }).text;
    store.set({ model, journal, script, revision: (model as { revision: number }).revision });
    viewer.current?.setSurface(await transport.surface());
  };
  const registry = new Registry({
    schema: schema as unknown as EngineSchema,
    host: ctx,
    hostCommands: [...HOST_COMMANDS, ...appHostCommands(store, transport, viewer, refresh)],
  });

  /** One entry point for the UI, the console and (later) the AI; every call is logged and re-reads the Model. */
  const dispatch: Registry['dispatch'] = async (cmd) => {
    store.set({ lastError: null });
    try {
      const ack = await registry.dispatch(cmd);
      store.log('command', cmd.cmd);
      if (registry.describe(cmd.cmd).provider === 'engine') await refresh();
      return ack;
    } catch (e) {
      store.fail(e);
      throw e;
    }
  };
  const query: Registry['query'] = (q) => registry.query(q);

  const proxy = makeFemProxy(dispatch, query) as unknown as Record<string, unknown>;
  window.fem = new Proxy({} as Window['fem'], {
    get: (_t, k: string | symbol) =>
      k === 'registry' ? registry : k === 'dispatch' ? dispatch : k === 'gpuSelfTest' ? (n: number) => transport.gpuSelfTest(n) : proxy[k as string],
  });

  render(<App store={store} dispatch={dispatch} viewer={viewer} />, root);

  await booted;
  const engineCaps = (await query({ query: 'query.capabilities' })) as Capabilities;
  store.set({ engineCaps, ready: true, notes: capabilityNotes(host, engineCaps) });
  store.log('engine', `engine ${engineCaps.engineVersion}, schema ${engineCaps.schemaVersion}`);
  if (devApiKeys()?.anthropic) store.log('engine', 'an ANTHROPIC_API_KEY from the dev shell is available to the assistant');
  await refresh();

  const example = new URLSearchParams(location.search).get('example');
  if (example) await dispatch({ cmd: 'file.openExample', name: example });
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
