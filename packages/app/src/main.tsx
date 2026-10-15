import { accounts, accountLeaveHook } from './account/browser';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import { HOST_COMMANDS, HOST_QUERIES, Registry, makeFemProxy, FemError, STEP_ACCEPT, type AbaqusConversion, type AbaqusDependencies, type Capabilities, type Command, type DocumentSnapshot, type EngineSchema, type Fem, type ProjectMeta, type JournalDiff } from '@femlab/registry';
import { render } from 'preact';
import schema from '../../registry/src/generated/runtime-schema';
import { migratePersistentKeys } from './ai/key-storage';
import { browserScriptValidator } from './script-validation-host';
import { capabilityNotes, readHostCaps } from './capabilities';
import { appHostCommands, appHostQueries, makeHostContext, noteAutosave, primeAutosave, autosaveHistory, type ViewerRef } from './host';
import { benchmarkProvenance } from './benchmark';
import { ProjectRepository, indexedDbAtomicProjects, memoryAtomicProjects, type ProjectBinding, type SaveJob } from './project-repository';
import type { Projects } from './projects';
import { ResultsView } from './results';
import { ResultComparison } from './result-comparison';
import type { CameraState } from './viewer/viewer';
import { ScriptHost } from './script-host';
import { readShareFragment } from './share';
import { Store, unsaved } from './store';
import { retireProjectHost } from './project-host';
import { AnimationCapture, browserAnimationCaptureEnvironment } from './animation-capture';
import { App } from './ui/App';
import { SessionWorkspace } from './session-workspace';
import { SessionTransport, sameSession } from './session-transport';
import type { ReplacementSource } from './session-protocol';
import { bindRegistryProducer, type RegistryProducer } from './producer-registry';
import { browserAbaqusIo } from './abaqus-files';
import { StepImporter } from './step-import';
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
  readonly stepImport = new StepImporter(
    () => new Worker(new URL('./step.worker.ts', import.meta.url), { type: 'module' }),
    new URL(`${import.meta.env.BASE_URL}third-party/step-converter/`, window.location.href).href,
    stepImport => this.store.set({ stepImport }),
    stepReport => this.store.set({ stepReport, panels: { ...this.store.state.panels, step: false, stepReport: true } }),
  );
  readonly capture = new AnimationCapture(browserAnimationCaptureEnvironment());
  readonly viewer: ViewerRef = { current: null };
  readonly rightViewer: ViewerRef = { current: null };
  readonly validation = new ScriptHost(() => new Worker(new URL('./script.worker.ts', import.meta.url), { type: 'module' }), async () => undefined, async () => undefined,
    browserScriptValidator(() => new Worker(new URL('./script-validation.worker.ts', import.meta.url), { type: 'module' })));
  readonly results: ResultsView;
  readonly comparison: ResultComparison;
  uiTransport!: SessionTransport;
  consoleTransport!: SessionTransport;
  private binding: ProjectBinding | null = null;
  private projectDeleted = false;
  private savedMeta: ProjectMeta | null = null;
  private projects: ProjectMeta[] = [];
  private latest: SaveJob | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<unknown> = Promise.resolve();
  private refreshing: Promise<void> = Promise.resolve();
  private autosave = localStorage.getItem('femlab.autosave') !== 'off';
  private version: string | null = null;
  private fitAfterOpen = false;
  private initialCamera: CameraState | undefined;
  private detachAccount = () => {};
  disposed = false;
  constructor(readonly transport: SessionTransport) {
    this.detachAccount = accounts.subscribe(account => this.store.set({ account }));
    this.store.setJournalDiffQuery(async base => await transport.query({ query: 'query.journalDiff', base }) as JournalDiff);
    const playbackClock = { now: () => performance.now(), schedule: (cb: () => void, ms: number) => setTimeout(cb, ms), cancel: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
    this.results = new ResultsView(this.store, transport, this.viewer, playbackClock);
    this.comparison = new ResultComparison(this.store, transport, { left: this.viewer, right: this.rightViewer }, {
      pauseSingle: () => { this.results.invalidateTransient(); this.viewer.current?.animate(false); },
      restoreSingle: () => this.results.refresh(true),
    }, playbackClock);
    this.rightViewer.onReady = () => this.comparison.resume();
    this.viewer.onReady = () => {
      if (this.fitAfterOpen) this.initialCamera = this.viewer.current?.getCamera();
      void this.refresh().catch(error => this.fail(error));
    };
    this.viewer.onBounds = () => {
      const dispatch = this.store.dispatch;
      if (!this.fitAfterOpen || this.disposed || !this.viewer.current || !dispatch) return;
      this.fitAfterOpen = false;
      const viewer = this.viewer.current;
      const revision = this.store.state.revision;
      const camera = JSON.stringify(this.initialCamera ?? viewer.getCamera());
      // setSurface precedes Result deformation/legend publication. Let that task and the
      // shell's queued render finish before measuring the usable canvas. A person's camera
      // or physical edit during loading still wins; a replaced/disposed session cannot fit.
      playbackClock.schedule(() => {
        if (this.disposed || this.viewer.current !== viewer || this.store.state.revision !== revision) return;
        if (JSON.stringify(viewer.getCamera()) !== camera) return;
        void dispatch({ cmd: 'view.fit' }).catch(error => this.fail(error));
      }, 0);
    };
  }
  async initialize(snapshot: DocumentSnapshot, source?: ReplacementSource): Promise<void> {
    this.uiTransport = await this.transport.fork();
    this.consoleTransport = await this.transport.fork();
    const capabilities = await this.transport.query({ query: 'query.capabilities' }) as Capabilities;
    this.store.set({ hostCaps: host, engineCaps: capabilities, ready: true, notes: capabilityNotes(host, capabilities) });
    this.publishSnapshot(snapshot);
    this.fitAfterOpen = Boolean(source && snapshot.model.bodies.length > 0);
    if (snapshot.results.records.length) this.store.set({ viewMode: 'results', tab: 'results' });
    if (source) {
      const target = source.project ?? { meta: nextMeta(snapshot.model.name), expected: null };
      this.binding = await repository.claim(target.meta, snapshot, target.expected);
      this.savedMeta = target.meta;
      if (source.kind !== 'commands' || source.commands.length !== 1 || source.commands[0]?.cmd !== 'model.new') this.store.markOpened(snapshot.file.journal);
    }
    if (source?.benchmark) this.store.set({ benchmark: { ...source.benchmark, ...benchmarkProvenance(snapshot.model, snapshot.journal, snapshot.model.revision) } });
    if (source?.abaqusReport) this.store.set({ abaqusReport: structuredClone(source.abaqusReport), panels: { ...this.store.state.panels, abaqusReport: true }, viewMode: 'mesh' });
    await this.primeProjects();
  }
  private publishSnapshot(snapshot: DocumentSnapshot): boolean {
    if (this.disposed) throw expired();
    if (!sameSession(snapshot.stamp.session, this.transport.stamp.session)) throw expired();
    if (this.version !== null && BigInt(snapshot.stamp.stateVersion) <= BigInt(this.version)) return false;
    this.version = snapshot.stamp.stateVersion;
    this.store.set({ model: snapshot.model, journal: snapshot.journal, script: snapshot.script, objects: snapshot.objects.objects, revision: snapshot.model.revision });
    return true;
  }
  refresh(): Promise<void> {
    const result = this.refreshing.then(() => this.refreshSnapshot());
    this.refreshing = result.catch(() => undefined);
    return result;
  }
  private async refreshSnapshot(): Promise<void> {
    if (this.disposed) throw expired();
    const snapshot = await this.transport.snapshot();
    if (this.publishSnapshot(snapshot)) await this.store.refreshJournalComparison();
    await this.results.refresh();
    await this.comparison.refresh();
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
    await this.refreshing;
    const snapshot = await this.transport.snapshot();
    if (snapshot.file.journal.entries.length === 0 || !this.autosave || this.projectDeleted) return;
    if (!this.binding) this.binding = await repository.claim(nextMeta(snapshot.model.name), snapshot, null);
    this.latest = this.binding.capture(snapshot, Date.now());
    await this.save();
  }
  async prepareAccountReturn(): Promise<string | null> {
    await this.refreshing;
    const snapshot = await this.transport.snapshot();
    if (!snapshot.file.journal.entries.length) return null;
    if (this.projectDeleted) {
      if (unsaved(this.store.state)) throw new FemError('unsupported', 'Save a model file before leaving this deleted browser project.', 'account', 'file.save');
      return null;
    }
    if (!this.autosave && this.savedMeta?.hash !== snapshot.model.hash) throw new FemError('unsupported', 'Save this project or enable browser autosave before leaving for login or payment.', 'account', 'project.save');
    await this.prepareToLeave();
    return this.savedMeta?.id ?? null;
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
      setEnabled: (enabled) => { this.autosave = enabled; if (!enabled && this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; } },
      enabled: () => this.autosave, flush: async () => { await this.save(); await this.saving; },
    };
  }
  async abandon(): Promise<void> { await this.binding?.abandon(); }
  fail(error: unknown): void { if (!this.disposed) this.store.fail(error); }
  dispose(): void {
    this.disposed = true;
    retireProjectHost(this.store);
    this.stepImport.dispose();
    this.detachAccount();
    this.capture.cancel();
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.results.invalidateTransient();
    this.comparison.dispose();
    this.validation.stop();
    this.viewer.current = null;
    this.rightViewer.current = null;
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
      captureImport: () => {
        const admitted = transport.stamp;
        return {
          dependencies: async source => await transport.query({ query: 'query.abaqusDependencies', ...source }) as AbaqusDependencies,
          convert: async query => await transport.query(query) as AbaqusConversion,
          replace: async (commands, abaqusReport) => { await transport.replaceWith({ kind: 'commands', commands, abaqusReport }, admitted); },
        };
      },
    }, bundle.capture, undefined, accounts.services, bundle.comparison);
    ctx.step = {
      import: input => {
        const admitted = transport.stamp;
        const io = browserAbaqusIo(document, crypto, bundle.store.state.folder, STEP_ACCEPT);
        return bundle.stepImport.run(input, io, {
          signal: this.lifetime.signal,
          convert: async (quantity, to) => {
            const result = await transport.query({ query: 'query.convert', quantity, to });
            if (!('value' in result) || typeof result.value !== 'number') throw new FemError('internal', 'query.convert returned no numeric value');
            return result.value;
          },
          commit: command => transport.dispatchAtAdmission(command, admitted),
        });
      },
      cancel: name => bundle.stepImport.cancel(name),
    };
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
    ctx.script.stop = () => { for (const job of scriptJobs) { if (job.producer.bundle !== bundle) continue; job.runner.stop(); job.producer.lifetime.abort(); void job.producer.transport.release().catch(() => undefined); } };
    const registry = new Registry({ schema: schema as unknown as EngineSchema, host: ctx, hostCommands: [...HOST_COMMANDS, ...appHostCommands(bundle.store, transport, bundle.viewer, () => bundle.refresh(), bundle.results, () => this.registry, bundle.comparison)], hostQueries: [...HOST_QUERIES, ...appHostQueries(bundle.store)] });
    return registry;
  }
  async dispatch(command: { cmd: string } & Record<string, unknown>): Promise<unknown> {
    const before = this.bundle; const native = this.native; const transport = this.transport;
    const definition = native.describe(command.cmd);
    if (before.disposed) throw expired();
    if (definition.provider === 'host' && !['control', 'sessionView'].includes(definition.execution)) await transport.assertActive();
    before.store.set({ lastError: null });
    const long = command.cmd === 'solve.run' || command.cmd === 'study.converge';
    if (long) before.store.set({ solving: String(command['step'] ?? ''), progress: { phase: 'starting', fraction: 0 } });
    transport.onProgress(progress => { if (!before.disposed) before.store.set({ progress: { phase: progress.phase, fraction: progress.fraction ?? 0 } }); });
    let publication = before;
    try {
      const versionBefore = transport.stamp.stateVersion;
      const who = before.store.state.source;
      const ack = await native.dispatch(command);
      publication = this.bundle;
      const current = this.bundle;
      if (definition.execution === 'replacement' || (definition.execution === 'modelWrite' && transport.stamp.stateVersion !== versionBefore)) {
        const seq = (ack as { seq?: number } | undefined)?.seq;
        if (typeof seq === 'number' && seq >= 0) current.store.set({ journalWho: { ...current.store.state.journalWho, [seq]: { who, at: Date.now() } } });
        current.results.invalidateTransient();
        current.comparison.pausePlayback();
        await current.refresh();
        await current.results.onAck(ack);
        current.comparison.resume();
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

let displayed: Bundle | undefined;
export async function prepareAccountNavigation(): Promise<void> {
  const id = await displayed?.prepareAccountReturn();
  if (id) sessionStorage.setItem('femlab.accountReturnProject', id);
  else sessionStorage.removeItem('femlab.accountReturnProject');
}
accountLeaveHook(prepareAccountNavigation);
const workspace = new SessionWorkspace<Bundle>({
  spawn: () => new Worker(new URL('./session.worker.ts', import.meta.url), { type: 'module' }),
  epoch: () => crypto.randomUUID(), engine: engineOptions,
  build: async (transport, snapshot, source) => { const bundle = new Bundle(await transport.fork()); try { await bundle.initialize(snapshot, source); } catch (error) { try { await bundle.abandon(); } finally { bundle.dispose(); } throw error; } bundles.set(transport.channel, bundle); return bundle; },
  publish: ({ resources: bundle }) => {
    // A folder is a workspace capability; replacing the engine keeps the current selection.
    if (displayed) bundle.store.setFolder(displayed.store.state.folder);
    if (displayed && !bundle.store.state.result && bundle.store.state.viewMode !== 'results') bundle.store.set({ tab: displayed.store.state.tab });
    if (displayed) for (const [panel, open] of Object.entries(displayed.store.state.panels)) {
      if (panel === 'assistant' || panel.startsWith('assistant.') || panel === 'tutorial' || panel.startsWith('skill:')) bundle.store.togglePanel(panel, open);
    }
    displayed = bundle;
    const ui = new Producer(bundle, bundle.uiTransport);
    const dispatch: Registry['dispatch'] = async command => {
      if (['control', 'sessionView'].includes(ui.registry.describe(command.cmd).execution)) return ui.registry.dispatch(command);
      const producer = new Producer(bundle, await bundle.transport.fork());
      try { return await producer.registry.dispatch(command); }
      finally { await producer.transport.release().catch(() => undefined); }
    };
    // A console handle has its own producer. A UI activation never advances a retained one.
    let consoleProducer = new Producer(bundle, bundle.consoleTransport);
    // A top-level console call is a new admission, just like a click. Its session is captured
    // before the fork; a retained facade follows only a replacement it initiated itself.
    const consoleDispatch: Registry['dispatch'] = async command => {
      const owner = consoleProducer;
      const operation = new Producer(owner.bundle, await owner.transport.fork());
      try {
        const ack = await operation.registry.dispatch(command);
        if (operation.bundle !== owner.bundle) consoleProducer = operation;
        return ack;
      } finally { if (operation !== consoleProducer) await operation.transport.release().catch(() => undefined); }
    };
    const consoleRegistry = new Proxy(consoleProducer.registry, { get: (_target, key) => {
      if (key === 'dispatch') return consoleDispatch;
      const target = consoleProducer.registry;
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const proxy = makeFemProxy(consoleDispatch, query => consoleProducer.registry.query(query));
    window.fem = new Proxy({} as Window['fem'], { get: (_target, key) => key === 'registry' ? consoleRegistry : key === 'dispatch' ? consoleDispatch : key === 'gpuSelfTest' ? (n: number) => consoleProducer.transport.gpuSelfTest(n) : Reflect.get(proxy, key) });
    bundle.store.dispatch = dispatch;
    if (!root.querySelector('.shell, .start-layout, .start')) root.textContent = '';
    render(<App sessionKey={bundle.transport.stamp.session.backendEpoch} store={bundle.store} dispatch={dispatch} query={query => ui.registry.query(query)} viewer={bundle.viewer} rightViewer={bundle.rightViewer} comparison={bundle.comparison} commands={ui.registry.list().commands} registry={ui.registry} />, root);
  },
});
async function boot(): Promise<void> {
  bootStage('Checking graphics capabilities…', 20);
  migratePersistentKeys();
  // Select the initial backend from an actual adapter probe. Later candidate device failures
  // still abort replacement; they never silently change an established backend.
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  engineOptions.gpu = Boolean(await gpu?.requestAdapter());
  bootStage('Reading saved projects…', 40);
  await primeAutosave();
  bootStage('Loading the simulation engine…', 60);
  const active = await workspace.start();
  await active.resources.refresh();
  const accountReturn = sessionStorage.getItem('femlab.accountReturnProject');
  if (accountReturn) {
    sessionStorage.removeItem('femlab.accountReturnProject');
    try { await window.fem.dispatch({ cmd: 'project.open', id: accountReturn }); return; }
    catch (error) { workspace.active.resources.fail(error); }
  }
  const example = new URLSearchParams(location.search).get('example');
  if (example) await window.fem.dispatch({ cmd: 'file.openExample', name: example });
  const commands = await readShareFragment(location.hash);
  if (commands) await workspace.replace(workspace.active.transport, { kind: 'commands', commands: commands as Command[] });
}
function bootStage(message: string, progress: number): void {
  const status = root.querySelector('.boot-status');
  const bar = root.querySelector<HTMLElement>('.boot-fill');
  if (status) status.textContent = message;
  if (bar) bar.style.width = `${progress}%`;
}
void accounts.initialize();
void boot().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  if (root.querySelector('.boot')) {
    root.querySelector('h1')!.textContent = 'Could not start the workspace';
    root.querySelector('.boot')!.setAttribute('aria-busy', 'false');
    bootStage(message, 100);
  } else root.textContent = message;
});
