import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import { HOST_COMMANDS, HOST_QUERIES, Registry, makeFemProxy, FemError, type Capabilities, type Command, type DocumentSnapshot, type EngineSchema, type Fem, type ProjectMeta, type JournalDiff } from '@femlab/registry';
import { render } from 'preact';
import schema from '../../registry/src/generated/engine.schema.json';
import { migratePersistentKeys } from './ai/key-storage';
import { browserScriptValidator } from './script-validation-host';
import { capabilityNotes, readHostCaps } from './capabilities';
import { appHostCommands, appHostQueries, makeHostContext, noteAutosave, primeAutosave, autosaveHistory, type ViewerRef } from './host';
import { benchmarkProvenance } from './benchmark';
import { ProjectRepository, indexedDbAtomicProjects, memoryAtomicProjects, type ProjectBinding, type SaveJob } from './project-repository';
import type { Projects } from './projects';
import { ResultsView } from './results';
import { ScriptHost } from './script-host';
import { readShareFragment } from './share';
import { Store } from './store';
import { App } from './ui/App';
import { SessionWorkspace } from './session-workspace';
import { SessionTransport, sameSession } from './session-transport';
import type { ReplacementSource } from './session-protocol';
import { bindRegistryProducer, type RegistryProducer } from './producer-registry';
import './ui/style.css';

declare global {
  interface Window { fem: Fem & { registry: Registry; dispatch: Registry['dispatch']; gpuSelfTest(n: number): Promise<number> } }
}
const root = document.getElementById('app')!;
const host = readHostCaps();
const engineOptions = { gpu: false, threads: host.threads };
const repository = new ProjectRepository(typeof indexedDB === 'undefined' ? memoryAtomicProjects() : indexedDbAtomicProjects(indexedDB), () => crypto.randomUUID());
const bundles = new WeakMap<object, Bundle>();
const scriptJobs = new Set<{ runner: ScriptHost; producer: Producer }>();
const nextMeta = (name: string): ProjectMeta => ({ id: crypto.randomUUID(), name, at: Date.now(), createdAt: Date.now(), commands: 0, hash: null, thumbnail: null });
const expired = (): FemError => new FemError('session.expired', 'this action belongs to an inactive project');

class Bundle {
  readonly store = new Store();
  readonly viewer: ViewerRef = { current: null };
  readonly validation = new ScriptHost(() => new Worker(new URL('./script.worker.ts', import.meta.url), { type: 'module' }), async () => undefined, async () => undefined,
    browserScriptValidator(() => new Worker(new URL('./script-validation.worker.ts', import.meta.url), { type: 'module' })));
  readonly results: ResultsView;
  uiTransport!: SessionTransport;
  consoleTransport!: SessionTransport;
  private binding: ProjectBinding | null = null;
  private projectDeleted = false;
  private savedMeta: ProjectMeta | null = null;
  private projects: ProjectMeta[] = [];
  private latest: SaveJob | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<unknown> = Promise.resolve();
  private autosave = localStorage.getItem('femlab.autosave') !== 'off';
  private version = '0';
  disposed = false;
  constructor(readonly transport: SessionTransport) {
    this.store.setJournalDiffQuery(async base => await transport.query({ query: 'query.journalDiff', base }) as JournalDiff);
    this.results = new ResultsView(this.store, transport, this.viewer, { now: () => performance.now(), schedule: (cb, ms) => setTimeout(cb, ms), cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) });
    this.viewer.onReady = () => { void this.refresh().catch(error => this.fail(error)); };
  }
  async initialize(snapshot: DocumentSnapshot, source?: ReplacementSource): Promise<void> {
    this.uiTransport = await this.transport.fork();
    this.consoleTransport = await this.transport.fork();
    const capabilities = await this.transport.query({ query: 'query.capabilities' }) as Capabilities;
    this.store.set({ hostCaps: host, engineCaps: capabilities, ready: true, notes: capabilityNotes(host, capabilities) });
    this.publishSnapshot(snapshot);
    if (source) {
      const target = source.project ?? { meta: nextMeta(snapshot.model.name), expected: null };
      this.binding = await repository.claim(target.meta, snapshot, target.expected);
      this.savedMeta = target.meta;
      this.store.markOpened(snapshot.file.journal);
    }
    if (source?.benchmark) this.store.set({ benchmark: { ...source.benchmark, ...benchmarkProvenance(snapshot.model, snapshot.journal, snapshot.model.revision) } });
    await this.primeProjects();
  }
  private publishSnapshot(snapshot: DocumentSnapshot): void {
    if (!sameSession(snapshot.stamp.session, this.transport.stamp.session)) throw expired();
    if (BigInt(snapshot.stamp.stateVersion) < BigInt(this.version)) return;
    this.version = snapshot.stamp.stateVersion;
    this.store.set({ model: snapshot.model, journal: snapshot.journal, script: snapshot.script, objects: snapshot.objects.objects, revision: snapshot.model.revision });
  }
  async refresh(): Promise<void> {
    if (this.disposed) throw expired();
    const snapshot = await this.transport.snapshot();
    this.publishSnapshot(snapshot);
    await this.store.refreshJournalComparison();
    const surface = await this.transport.surface();
    if (this.disposed) throw expired();
    this.viewer.current?.setSurface(surface);
    await this.results.refresh();
    if (this.disposed) throw expired();
    if (snapshot.file.journal.entries.length && !this.projectDeleted) {
      if (!this.binding) {
        this.binding = await repository.claim(nextMeta(snapshot.model.name), snapshot, null);
        this.savedMeta = this.binding.meta;
      }
      this.latest = this.binding.capture(snapshot, Date.now());
      if (this.autosave && this.timer === undefined) this.timer = setTimeout(() => { this.timer = undefined; void this.save().catch(error => this.fail(error)); }, 500);
      noteAutosave(snapshot.model.name, snapshot.file.journal.entries);
      this.store.set({ autosaves: autosaveHistory() });
    }
  }
  async prepareToLeave(): Promise<void> {
    const snapshot = await this.transport.snapshot();
    if (snapshot.file.journal.entries.length === 0 || !this.autosave || this.projectDeleted) return;
    if (!this.binding) this.binding = await repository.claim(nextMeta(snapshot.model.name), snapshot, null);
    this.latest = this.binding.capture(snapshot, Date.now());
    await this.save();
  }
  async recoverySource(source: ReplacementSource): Promise<ReplacementSource> {
    if (this.projectDeleted || !this.binding) return source;
    if (this.autosave) await this.save();
    await this.saving;
    const expected = await repository.read(this.binding.meta.id);
    return { ...source, project: { meta: expected.meta!, expected } };
  }
  recoveryFailed(error: unknown): void { this.store.set({ ready: false }); this.fail(error); }
  async primeProjects(): Promise<ProjectMeta[]> {
    this.projects = await repository.list();
    if (this.savedMeta) this.savedMeta = this.projects.find(meta => meta.id === this.savedMeta!.id) ?? null;
    this.store.set({ projects: this.projects, project: this.savedMeta ? { ...this.savedMeta, saving: false, autosave: this.autosave } : null });
    return this.projects;
  }
  async save() {
    const binding = this.binding; const job = this.latest;
    if (!binding || !job) return null;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    // Capture before any await; an old session can finish saving only its own generation.
    const operation = binding.save(job);
    this.saving = operation.catch(() => undefined);
    const meta = await operation;
    this.savedMeta = meta;
    await this.primeProjects();
    return { ...meta, saving: false, autosave: this.autosave, journal: job.journal };
  }
  projectApi(transport: SessionTransport): Projects {
    return {
      prime: () => this.primeProjects(), list: () => this.projects,
      current: () => this.savedMeta ? { ...this.savedMeta, saving: false, autosave: this.autosave } : null,
      new: async (name = 'model') => {
        const meta = nextMeta(name);
        await transport.replaceWith({ kind: 'commands', commands: [{ cmd: 'model.new', name }], project: { meta, expected: null } });
        return meta;
      },
      open: async (id) => {
        await this.prepareToLeave();
        await this.saving;
        const expected = await repository.read(id);
        await transport.replaceWith({ kind: 'commands', commands: expected.cmds as Command[], project: { meta: expected.meta!, expected } });
        return expected.meta!;
      },
      rename: async (id, name) => { const meta = await repository.rename(id ?? this.savedMeta?.id ?? '', name); await this.primeProjects(); return meta; },
      delete: async (id) => {
        await repository.delete(id);
        if (this.binding?.meta.id === id) {
          this.projectDeleted = true; this.latest = null;
          if (this.timer !== undefined) clearTimeout(this.timer);
          this.timer = undefined;
        }
        await this.primeProjects();
      },
      save: () => this.save(),
      // Main publishes coherent snapshots directly; legacy note/fork are not part of this path.
      note: () => { throw new FemError('internal', 'use the session snapshot save path'); },
      fork: () => { throw new FemError('internal', 'use atomic session replacement'); },
      setEnabled: (enabled) => { this.autosave = enabled; if (!enabled && this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; } },
      enabled: () => this.autosave, flush: async () => { await this.save(); await this.saving; },
    };
  }
  async abandon(): Promise<void> { await this.binding?.abandon(); }
  fail(error: unknown): void { if (!this.disposed) this.store.fail(error); }
  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.results.invalidateTransient();
    this.validation.stop();
    this.viewer.current = null;
  }
}

class Producer {
  readonly registry: Registry;
  private native: Registry;
  private readonly lifetime = new AbortController();
  private detach = () => {};
  constructor(public bundle: Bundle, public transport: SessionTransport) {
    this.native = this.makeNative();
    this.registry = this.makeNative();
    this.registry.dispatch = (command) => this.dispatch(command);
    this.registry.query = (query) => this.query(query);
    bindRegistryProducer(this.registry, async () => {
      const owner = this.bundle; const transport = this.transport;
      const child = new Producer(owner, await transport.fork());
      return child.handle();
    });
    this.listen();
  }
  private handle(): RegistryProducer {
    return { registry: this.registry, signal: this.lifetime.signal, store: () => this.bundle.store,
      release: async () => { this.lifetime.abort(); this.detach(); await this.transport.release().catch(() => undefined); } };
  }
  private listen(): void {
    this.detach();
    const signal = this.transport.channel.signal;
    const expire = () => this.lifetime.abort(signal.reason);
    signal.addEventListener('abort', expire, { once: true });
    this.detach = () => signal.removeEventListener('abort', expire);
    if (signal.aborted) expire();
    this.transport.onReplacement(next => {
      const bundle = bundles.get(next.channel);
      if (!bundle) throw new FemError('internal', 'replacement has no published resource bundle');
      // These two application panels own producer lifetimes; their visibility contains no model targets.
      for (const panel of ['assistant', 'tutorial']) if (this.bundle.store.state.panels[panel]) bundle.store.togglePanel(panel, true);
      this.bundle = bundle; this.transport = next; this.native = this.makeNative(); this.listen();
    });
  }
  private makeNative(): Registry {
    const bundle = this.bundle; const transport = this.transport;
    const ctx = makeHostContext(bundle.store, transport, bundle.viewer, host, bundle.validation, bundle.results, undefined, undefined, undefined, () => bundle.refresh(), {
      projects: bundle.projectApi(transport), active: () => transport.assertActive(),
      replay: async (commands, benchmark) => { await transport.replaceWith({ kind: 'commands', commands: commands as Command[], ...(benchmark ? { benchmark } : {}) }); },
    });
    ctx.chat.send = async text => {
      const child = new Producer(bundle, await transport.fork());
      try {
        const { chatBridge } = await import('./ai');
        if (child.lifetime.signal.aborted) throw expired();
        chatBridge.send(text, Promise.resolve(child.handle()));
      } catch (error) { await child.handle().release(); throw error; }
    };
    ctx.script.run = async (code, timeoutMs) => {
      const child = this;
      const runner = new ScriptHost(() => new Worker(new URL('./script.worker.ts', import.meta.url), { type: 'module' }), p => child.registry.dispatch(p as { cmd: string }), p => child.registry.query(p as { query: string }), browserScriptValidator(() => new Worker(new URL('./script-validation.worker.ts', import.meta.url), { type: 'module' })));
      const stop = () => runner.stop();
      child.lifetime.signal.addEventListener('abort', stop, { once: true });
      const job = { runner, producer: child }; scriptJobs.add(job);
      child.bundle.store.set({ scriptRunning: true, source: 'ai' });
      try {
        const result = await runner.run(code, timeoutMs);
        child.bundle.store.set({ scriptOut: [...result.console, result.error ?? 'done'] });
        return result;
      } finally { child.lifetime.signal.removeEventListener('abort', stop); child.bundle.store.set({ scriptRunning: false, source: 'you' }); scriptJobs.delete(job); }
    };
    ctx.script.stop = () => { for (const job of scriptJobs) { job.runner.stop(); job.producer.lifetime.abort(); void job.producer.transport.release().catch(() => undefined); } };
    const registry = new Registry({ schema: schema as unknown as EngineSchema, host: ctx, hostCommands: [...HOST_COMMANDS, ...appHostCommands(bundle.store, transport, bundle.viewer, () => bundle.refresh(), bundle.results, () => this.registry)], hostQueries: [...HOST_QUERIES, ...appHostQueries(bundle.store)] });
    return registry;
  }
  async dispatch(command: { cmd: string } & Record<string, unknown>): Promise<unknown> {
    const before = this.bundle; const native = this.native; const transport = this.transport;
    const definition = native.describe(command.cmd);
    if (before.disposed) throw expired();
    if (definition.provider === 'host' && definition.execution !== 'control') await transport.assertActive();
    before.store.set({ lastError: null });
    const long = command.cmd === 'solve.run' || command.cmd === 'study.converge';
    if (long) before.store.set({ solving: String(command['step'] ?? ''), progress: { phase: 'starting', fraction: 0 } });
    transport.onProgress(progress => { if (!before.disposed) before.store.set({ progress: { phase: progress.phase, fraction: progress.fraction ?? 0 } }); });
    let publication = before;
    try {
      const ack = await native.dispatch(command);
      publication = this.bundle;
      const current = this.bundle;
      if (definition.execution === 'modelWrite' || definition.execution === 'replacement') {
        current.results.invalidateTransient();
        await current.refresh();
        await current.results.onAck(ack);
      }
      current.store.log('command', command.cmd);
      return ack;
    } catch (error) { publication.fail(error); throw error; }
    finally { if (long) this.bundle.store.set({ solving: null, progress: null }); }
  }
  async query(query: { query: string } & Record<string, unknown>): Promise<unknown> {
    if (this.bundle.disposed) throw expired();
    const native = this.native; const transport = this.transport;
    if (native.describe(query.query).provider === 'host') await transport.assertActive();
    return native.query(query);
  }
}

const workspace = new SessionWorkspace<Bundle>({
  spawn: () => new Worker(new URL('./session.worker.ts', import.meta.url), { type: 'module' }),
  epoch: () => crypto.randomUUID(), engine: engineOptions,
  build: async (transport, snapshot, source) => { const bundle = new Bundle(await transport.fork()); try { await bundle.initialize(snapshot, source); } catch (error) { try { await bundle.abandon(); } finally { bundle.dispose(); } throw error; } bundles.set(transport.channel, bundle); return bundle; },
  publish: ({ resources: bundle }) => {
    const ui = new Producer(bundle, bundle.uiTransport);
    const dispatch: Registry['dispatch'] = async command => {
      if (ui.registry.describe(command.cmd).execution === 'control') return ui.registry.dispatch(command);
      const producer = new Producer(bundle, await bundle.transport.fork());
      try { return await producer.registry.dispatch(command); }
      finally { await producer.transport.release().catch(() => undefined); }
    };
    // A console handle has its own producer. A UI activation never advances a retained one.
    const consoleProducer = new Producer(bundle, bundle.consoleTransport);
    const proxy = makeFemProxy(command => consoleProducer.registry.dispatch(command), query => consoleProducer.registry.query(query));
    window.fem = new Proxy({} as Window['fem'], { get: (_target, key) => key === 'registry' ? consoleProducer.registry : key === 'dispatch' ? consoleProducer.registry.dispatch : key === 'gpuSelfTest' ? (n: number) => consoleProducer.transport.gpuSelfTest(n) : Reflect.get(proxy, key) });
    bundle.store.dispatch = dispatch;
    if (!root.querySelector('.shell, .start-layout, .start')) root.textContent = '';
    render(<App sessionKey={bundle.transport.stamp.session.backendEpoch} store={bundle.store} dispatch={dispatch} query={query => ui.registry.query(query)} viewer={bundle.viewer} commands={ui.registry.list().commands} registry={ui.registry} />, root);
  },
});
async function boot(): Promise<void> {
  migratePersistentKeys();
  // Select the initial backend from an actual adapter probe. Later candidate device failures
  // still abort replacement; they never silently change an established backend.
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  engineOptions.gpu = Boolean(await gpu?.requestAdapter());
  await primeAutosave();
  const active = await workspace.start();
  await active.resources.refresh();
  const example = new URLSearchParams(location.search).get('example');
  if (example) await window.fem.dispatch({ cmd: 'file.openExample', name: example });
  const commands = await readShareFragment(location.hash);
  if (commands) await workspace.replace(workspace.active.transport, { kind: 'commands', commands: commands as Command[] });
}
root.textContent = 'Starting FEM Lab…';
void boot().catch(error => { root.textContent = error instanceof Error ? error.message : String(error); });
