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
import { prepareKeyStorage } from './ai/key-storage';
import { browserScriptValidator } from './script-validation-host';
import { capabilityNotes, readHostCaps } from './capabilities';
import { appHostCommands, appHostQueries, makeHostContext, browserDownload, type CloudProjectHost,type ViewerRef } from './host';
import { createCompletedFiles } from './completed-files';
import type { CompletedFilesHost } from '@femlab/registry';
import { benchmarkProvenance } from './benchmark';
import { ProjectRepository, indexedDbAtomicProjects, memoryAtomicProjects, type ProjectBinding, type SaveJob,type AtomicProjects,type ProjectRecord } from './project-repository';
import type { Projects } from './projects';
import { ResultsView } from './results';
import { ResultComparison } from './result-comparison';
import type { CameraState } from './viewer/viewer';
import { ScriptHost } from './script-host';
import { readShareFragment,makeAutosave,indexedDbStore,memoryStore,type Autosave } from './share';
import {partitionedAtomicProjects} from './project-partitions';
import {CloudProjectApi} from './cloud-project-api';
import {ProjectSync} from './project-sync';
import {createProjectFileInventory,encodeProjectArtifact,decodeProjectArtifact,MAX_PROJECT_ARTIFACT_BYTES,type ProjectAsset,type ProjectArtifact} from './project-artifact';
import { Store, initialState, unsaved } from './store';
import { retireProjectHost,browserProjectAccessFor } from './project-host';
import { AnimationCapture, browserAnimationCaptureEnvironment } from './animation-capture';
import { App } from './ui/App';
import { StartupHost, startupWait, WORKSPACE_STATUS, workspaceStatus } from './startup';
import { SessionWorkspace } from './session-workspace';
import { WorkspaceNavigation, browserNavigationHistory } from './navigation';
import { SessionTransport, sameSession } from './session-transport';
import type { ReplacementSource } from './session-protocol';
import { bindRegistryProducer, type RegistryProducer } from './producer-registry';
import { browserAbaqusIo } from './abaqus-files';
import { StepImporter } from './step-import';
import {captureProjectInputs} from './project-inputs';
import './ui/style.css';
import { GeometryDraft, geometryDraftRenderer } from './geometry-draft';
import { defaultFormValues, fieldsOf, type Defs } from './ui/schema';

declare global {
  interface Window { fem: Fem & { registry: Registry; dispatch: Registry['dispatch']; gpuSelfTest(n: number): Promise<number> } }
}
const root = document.getElementById('app')!;
const host = readHostCaps();
const engineOptions = { gpu: false, threads: host.threads };
const projectStorage = typeof indexedDB === 'undefined' ? memoryAtomicProjects() : indexedDbAtomicProjects(indexedDB);
const projectAccesses=new Map<string|null,ReturnType<typeof browserProjectAccessFor>>();
const projectAccessFor=(owner:string|null)=>{let access=projectAccesses.get(owner);if(!access){access=browserProjectAccessFor(owner);projectAccesses.set(owner,access);}return access;};
const ownerStorage=new Map<string|null,AtomicProjects>(),repositories=new Map<string|null,ProjectRepository>(),histories=new Map<string|null,Autosave>();
const storageFor=(owner:string|null):AtomicProjects=>{let value=ownerStorage.get(owner);if(!value){value=partitionedAtomicProjects(projectStorage,owner);ownerStorage.set(owner,value);}return value;};
const repositoryFor=(owner:string|null):ProjectRepository=>{let value=repositories.get(owner);if(!value){value=new ProjectRepository(storageFor(owner),()=>crypto.randomUUID());repositories.set(owner,value);}return value;};
const historyFor=(owner:string|null):Autosave=>{let value=histories.get(owner);if(!value){value=makeAutosave({store:typeof indexedDB==='undefined'?memoryStore():indexedDbStore(indexedDB,owner),initiallyOn:localStorage.getItem('femlab.autosave')!=='off',onError:()=>undefined});histories.set(owner,value);}return value;};
const hashBytes=async(bytes:Uint8Array):Promise<string>=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as Uint8Array<ArrayBuffer>))].map(x=>x.toString(16).padStart(2,'0')).join('');
const cloudApi=new CloudProjectApi({origin:__AI_API_ORIGIN__??'',fetch:(...args)=>fetch(...args),identity:()=>({uid:accounts.state.uid,epoch:accounts.version}),token:uid=>accounts.token(uid),sha256:hashBytes,maxArtifactBytes:MAX_PROJECT_ARTIFACT_BYTES});
const sync=new ProjectSync({api:cloudApi,storage:storageFor,nextId:()=>crypto.randomUUID(),isOpen:(owner,id)=>displayed?.ownerUid===owner&&displayed.currentId===id,online:()=>navigator.onLine});
const restoredArtifacts=new WeakMap<ReplacementSource,{artifact:ProjectArtifact;bytes:Uint8Array;cloud?:ProjectRecord['cloud'];restoreDeleted?:boolean}>();
const sourceInputs=new WeakMap<ReplacementSource,ProjectAsset[]>();
const sourceRecovery=new WeakMap<ReplacementSource,{error:string;artifact?:Uint8Array;artifactTag?:string}>();

const bundles = new WeakMap<object, Bundle>();
// Private host identity distinguishes same-document Worker recovery from an explicit open/new.
// No cache or capability is serialized to the engine, a Model file or browser storage.
const recoveredFiles = new WeakMap<ReplacementSource, CompletedFilesHost>();
const completedFileStores = new WeakMap<CompletedFilesHost, Store>();
const completedBundles=new WeakMap<CompletedFilesHost,Bundle>();
const scriptJobs = new Set<{ runner: ScriptHost; producer: Producer }>();
const nextMeta = (name: string): ProjectMeta => ({ id: crypto.randomUUID(), name, at: Date.now(), createdAt: Date.now(), commands: 0, hash: null, thumbnail: null });
const expired = (): FemError => new FemError('session.expired', 'this action belongs to an inactive project');

class Bundle {
  readonly ownerUid=accounts.state.uid;
  readonly ownerEpoch=accounts.version;
  readonly repository=repositoryFor(this.ownerUid);
  readonly history=historyFor(this.ownerUid);
  readonly inventory:ReturnType<typeof createProjectFileInventory>;
  revoked=false;
  freshStart=false;
  get currentId():string|null{return this.savedMeta?.id??null;}
  // Physical delivery admitted by this owner may finish after a document replacement.
  // Authentication epochs remain absolute, including A → B → A transitions.
  assertIdentity():void{if(this.revoked||accounts.version!==this.ownerEpoch||accounts.state.uid!==this.ownerUid)throw expired();}
  assertOwner():void{this.assertIdentity();if(this.disposed)throw expired();}
  readonly store = new Store();
  readonly stepImport = new StepImporter(
    () => new Worker(new URL('./step.worker.ts', import.meta.url), { type: 'module' }),
    new URL(`${import.meta.env.BASE_URL}third-party/step-converter/`, window.location.href).href,
    stepImport => {if(!this.revoked&&!this.disposed)this.store.set({ stepImport });},
    stepReport => {if(!this.revoked&&!this.disposed)this.store.set({ stepReport, panels: { ...this.store.state.panels, step: false, stepReport: true } });},
  );
  readonly capture = new AnimationCapture(browserAnimationCaptureEnvironment());
  readonly viewer: ViewerRef = { current: null };
  readonly rightViewer: ViewerRef = { current: null };
  readonly geometryDraft: GeometryDraft;
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
  private recoverySyncPending = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<unknown> = Promise.resolve();
  private refreshing: Promise<void> = Promise.resolve();
  private artifactFailure:string|null=null;
  private autosave = localStorage.getItem('femlab.autosave') !== 'off';
  private version: string | null = null;
  private fitAfterOpen = false;
  private initialCamera: CameraState | undefined;
  private detachAccount = () => {};
  private detachFiles = () => {};
  private detachSync = () => {};
  private ownsFiles: boolean;
  readonly completedFiles: CompletedFilesHost;
  disposed = false;
  constructor(readonly transport: SessionTransport, recovered?: CompletedFilesHost) {
    if(recovered){const previous=completedBundles.get(recovered);if(previous&&(previous.ownerUid!==this.ownerUid||previous.ownerEpoch!==this.ownerEpoch||previous.revoked))throw expired();}
    this.inventory=recovered?completedBundles.get(recovered)?.inventory??createProjectFileInventory(()=>crypto.randomUUID()):createProjectFileInventory(()=>crypto.randomUUID());
    this.ownsFiles = !recovered;
    const engineSchema = schema as unknown as EngineSchema;
    const definitions: Defs = { ...engineSchema.commands.$defs, ...engineSchema.queries.$defs };
    this.geometryDraft = new GeometryDraft(this.store, geometryDraftRenderer(
      () => new Worker(new URL('./session.worker.ts', import.meta.url), { type: 'module' }), () => crypto.randomUUID()),
      () => this.viewer.current,
      { schedule: (fn, ms) => setTimeout(fn, ms), cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) },
      form => {
        const variant = engineSchema.commands.oneOf.find(variant => variant.properties['cmd']?.const === form.cmd);
        return variant ? defaultFormValues(form.values, fieldsOf(variant, definitions)) : form.values;
      });
    this.completedFiles = recovered ?? createCompletedFiles({ download: (name,mime,data)=>{this.assertIdentity();browserDownload(name,mime,data);}, nextId: () => crypto.randomUUID(),
      archive: input=>{this.assertIdentity();let staged:ReturnType<typeof this.inventory.prepare>|undefined;try{staged=this.inventory.prepare('output',input.name,input.mime,input.data);}catch(error){this.artifactFailure=error instanceof Error?error.message:'Project output could not be retained.';this.store.set({projectArtifactError:this.artifactFailure});}return {complete:()=>{if(staged?.complete()){const owner=completedBundles.get(this.completedFiles);if(owner)void owner.refresh().catch(error=>owner.fail(error));}},discard:()=>staged?.discard()};},
      changed: () => { const store = completedFileStores.get(this.completedFiles); if (store) store.set({ completedFilesVersion: store.state.completedFilesVersion + 1 }); } });
    this.detachAccount = accounts.subscribe(account => {
      if(account.uid!==this.ownerUid||accounts.version!==this.ownerEpoch){
        this.revoked=true;retireProjectHost(this.store);this.stepImport.dispose();this.validation.stop();this.capture.cancel();this.results?.invalidateTransient();this.comparison?.dispose();
        for(const job of scriptJobs)if(job.producer.bundle===this)job.runner.stop();
        this.store.state={...structuredClone(initialState),account,hostCaps:host};this.store.set({});
        queueIdentityReset();
      }else this.store.set({account});
    });
    this.detachSync=sync.subscribe(state=>{if(!this.revoked&&!this.disposed&&state.uid===this.ownerUid){this.store.set({projectSync:state});void this.primeProjects().catch(error=>this.fail(error));}});
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
      this.geometryDraft.restore();
      void this.refresh().catch(error => this.fail(error));
    };
    this.viewer.onBounds = () => {
      const dispatch = this.store.dispatch;
      if (!this.fitAfterOpen || this.disposed || this.revoked || !this.viewer.current || !dispatch) return;
      this.fitAfterOpen = false;
      const viewer = this.viewer.current;
      const revision = this.store.state.revision;
      const camera = JSON.stringify(this.initialCamera ?? viewer.getCamera());
      // setSurface precedes Result deformation/legend publication. Let that task and the
      // shell's queued render finish before measuring the usable canvas. A person's camera
      // or physical edit during loading still wins; a replaced/disposed session cannot fit.
      playbackClock.schedule(() => {
        if (this.disposed || this.revoked || this.viewer.current !== viewer || this.store.state.revision !== revision) return;
        if (JSON.stringify(viewer.getCamera()) !== camera) return;
        void dispatch({ cmd: 'view.fit' }).catch(error => this.fail(error));
      }, 0);
    };
  }
  async initialize(snapshot: DocumentSnapshot, source?: ReplacementSource): Promise<void> {
    this.assertOwner();
    this.freshStart=source===undefined;
    await this.history.read();
    const restored=source?restoredArtifacts.get(source):undefined;
    const recovering=Boolean(source&&recoveredFiles.has(source));
    this.artifactFailure=restored?null:(source?sourceRecovery.get(source)?.error:undefined)??(recovering?null:source?.project?.expected?.artifactError??null);
    if(this.artifactFailure)this.store.set({projectArtifactError:this.artifactFailure});
    if(restored)this.inventory.replace(restored.artifact.files);
    if(sourceInputs.has(source!))this.inventory.replace([...this.inventory.snapshot(),...sourceInputs.get(source!)!]);
    this.uiTransport = await this.transport.fork();
    this.consoleTransport = await this.transport.fork();
    const capabilities = await this.transport.query({ query: 'query.capabilities' }) as Capabilities;
    this.store.set({ hostCaps: host, engineCaps: capabilities, ready: true, notes: capabilityNotes(host, capabilities) });
    this.publishSnapshot(snapshot);
    this.fitAfterOpen = Boolean(source && snapshot.model.bodies.length > 0);
    if (snapshot.results.records.length) this.store.set({ viewMode: 'results', tab: 'results' });
    if (source&&!(source.kind==='commands'&&source.commands.length===0)) {
      const target = source.project ?? { meta: nextMeta(snapshot.model.name), expected: null };
      let recoveredArchive:Pick<SaveJob,'artifact'|'artifactTag'|'artifactError'>|undefined;
      if(recovering){
        // The cancelled Worker is closed. Only this fresh private session can export it.
        const exported=await this.transport.exportProject();
        if(exported.stamp.stateVersion!==snapshot.stamp.stateVersion)throw new FemError('session.conflict','recovered project changed while taking its complete snapshot','project','project.save');
        recoveredArchive=await this.archiveSnapshot(exported.project,target.meta,this.inventory.snapshot());
        this.recoverySyncPending=this.autosave&&this.ownerUid!==null;
      }
      this.binding = await this.repository.claim(target.meta, snapshot, target.expected,recoveredArchive??(restored?{artifact:restored.bytes,artifactTag:await hashBytes(restored.bytes),artifactError:undefined,cloud:restored.cloud,restoreDeleted:restored.restoreDeleted}:sourceRecovery.has(source)?{artifact:sourceRecovery.get(source)!.artifact,artifactTag:sourceRecovery.get(source)!.artifactTag,artifactError:sourceRecovery.get(source)!.error,cloud:this.ownerUid?{remote:null,dirty:true,deleted:false}:undefined}:{}));
      this.savedMeta = target.meta;
      if (source.kind !== 'commands' || source.commands.length !== 1 || source.commands[0]?.cmd !== 'model.new') this.store.markOpened(snapshot.file.journal);
    }
    if (source?.benchmark) this.store.set({ benchmark: { ...source.benchmark, ...benchmarkProvenance(snapshot.model, snapshot.journal, snapshot.model.revision) } });
    if (source?.abaqusReport) this.store.set({ abaqusReport: structuredClone(source.abaqusReport), panels: { ...this.store.state.panels, abaqusReport: true }, viewMode: 'mesh' });
    this.assertOwner();
    this.publishFiles();
    if(source?.kind==='legacy-project'||source?.kind==='journal'&&source.project)this.store.set({notes:[...this.store.state.notes,'Recovered model inputs without rerunning saved solves. Previous Results are unavailable; select Solve explicitly to compute new Results.']});
    await this.primeProjects();
  }
  private publishSnapshot(snapshot: DocumentSnapshot): boolean {
    this.assertOwner();
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
    this.assertOwner();
    const snapshot = await this.transport.snapshot();
    if (this.publishSnapshot(snapshot)) await this.store.refreshJournalComparison();
    await this.results.refresh();
    await this.comparison.refresh();
    this.assertOwner();
    if (snapshot.file.journal.entries.length && !this.projectDeleted) {
      if (!this.binding) {
        this.binding = await this.repository.claim(nextMeta(snapshot.model.name), snapshot, null);
        this.savedMeta = this.binding.meta;
      }
      this.latest = this.binding.capture(snapshot, Date.now());
      if (this.autosave && this.timer === undefined) this.timer = setTimeout(() => { this.timer = undefined; void this.save().catch(error => this.fail(error)); }, 500);
      this.history.note(snapshot.model.name,snapshot.file.journal.entries);
      this.store.set({autosaves:this.history.history().map(row=>({id:row.id??`legacy-${row.at}`,name:row.name,at:row.at,commands:row.cmds.length}))});
    }
  }
  async prepareToLeave(): Promise<void> {
    await this.refreshing;
    const snapshot = await this.transport.snapshot();
    if (snapshot.file.journal.entries.length === 0 || !this.autosave || this.projectDeleted) return;
    if (!this.binding) this.binding = await this.repository.claim(nextMeta(snapshot.model.name), snapshot, null);
    this.latest = this.binding.capture(snapshot, Date.now());
    await this.save();
  }
  async prepareIdentityReset():Promise<void>{
    if(!this.autosave||this.projectDeleted)return;
    try{await this.prepareToLeave();}
    catch{if(this.binding&&this.latest){await this.binding.save({...this.latest,artifactError:'The interrupted workspace has a saved browser Journal. Its complete artifact could not refresh; export the recovered Model before uploading.'}).catch(()=>undefined);}}
    await this.saving;
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
    if(this.timer!==undefined)clearTimeout(this.timer);this.timer=undefined;
    // Cancellation already terminated the Worker; keep captured host bytes without RPC.
    await this.saving;
    const expected=this.projectDeleted||!this.binding?undefined:await this.repository.read(this.binding.meta.id);
    const recovery=expected?{...source,project:{meta:expected.meta!,expected}}:source;
    if(this.artifactFailure)sourceRecovery.set(recovery,{error:this.artifactFailure});
    recoveredFiles.set(recovery,this.completedFiles);
    return recovery;
  }
  activateProjectSync():void {
    if(!this.recoverySyncPending||!this.ownerUid||!this.currentId)return;
    this.recoverySyncPending=false;
    // Cloud work starts only after the replacement and its atomic cache claim publish.
    void sync.changed(this.ownerUid,this.currentId).catch(error=>{if(!this.revoked&&!this.disposed)this.fail(error);});
  }
  activateFiles(previous?: Bundle): void {
    if (previous?.completedFiles === this.completedFiles) previous.ownsFiles = false;
    this.ownsFiles = true;
    completedFileStores.set(this.completedFiles, this.store);
    completedBundles.set(this.completedFiles,this);
    let folder = this.store.state.folder;
    this.detachFiles = this.store.subscribe(() => {
      if (!this.ownsFiles || folder === this.store.state.folder) return;
      folder = this.store.state.folder;
      this.completedFiles.clear();
    });
  }
  recoveryFailed(error: unknown): void { this.store.set({ ready: false }); this.fail(error); }
  async primeProjects(): Promise<ProjectMeta[]> {
    const projects=await this.repository.list();
    if(this.revoked||this.disposed)return projects;
    this.projects=projects;
    const anonymousProjects=this.ownerUid?await repositoryFor(null).list():[];
    if(this.revoked||this.disposed)return projects;
    this.store.set({anonymousProjects});
    if (this.savedMeta) this.savedMeta = this.projects.find(meta => meta.id === this.savedMeta!.id) ?? null;
    this.store.set({ projects: this.projects, project: this.savedMeta ? { ...this.savedMeta, saving: false, autosave: this.autosave } : null });
    return this.projects;
  }
  private async archiveSnapshot(engine:ProjectArtifact['engine'],meta:ProjectMeta,files:ProjectAsset[]):Promise<Pick<SaveJob,'artifact'|'artifactTag'|'artifactError'>> {
    try{
      if(this.artifactFailure)throw new Error(this.artifactFailure);
      const artifact=encodeProjectArtifact({name:meta.name,createdAt:meta.createdAt??meta.at,engine,files});
      return {artifact,artifactTag:await hashBytes(artifact),artifactError:undefined};
    }catch(error){
      const cause=error instanceof Error?error.message:'The complete project snapshot could not be retained.';
      if(!this.revoked)this.store.set({projectArtifactError:cause});
      return {artifactError:cause};
    }
  }
  async save() {
    const binding = this.binding; let job = this.latest;
    if (!binding || !job) return null;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    // Capture before any await; an old session can finish saving only its own generation.
    // Engine results and the Journal come from one stamped read; never join different revisions.
    const exported=await this.transport.exportProject();
    const snapshot=await this.transport.snapshot();if(snapshot.stamp.stateVersion!==exported.stamp.stateVersion)throw new FemError('session.conflict','project changed while taking its complete snapshot','project','project.save');job=binding.capture(snapshot,Date.now());
    const files=this.inventory.snapshot();
    job={...job,...await this.archiveSnapshot(exported.project,job.meta,files)};
    const captured=job;
    const operation = binding.save(captured);
    this.saving = operation.catch(() => undefined);
    const meta = await operation;
    const savedRecord=this.ownerUid?await storageFor(this.ownerUid).read(meta.id):null;
    if(this.ownerUid&&(!savedRecord?.cloud||savedRecord.cloud.dirty||savedRecord.cloud.upload))await sync.changed(this.ownerUid,meta.id);
    if(this.revoked||this.disposed)return null;
    this.store.set({projectArtifactError:job.artifactError??null,projectFiles:files.map(({data,...file})=>({...file,bytes:data.length}))});
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
        const expected = await this.repository.read(id);
        await this.openProject(transport,expected);
        return expected.meta!;
      },
      rename: async (id, name) => { const meta = await this.repository.rename(id ?? this.savedMeta?.id ?? '', name); await sync.changed(this.ownerUid,meta.id);await this.primeProjects(); return meta; },
      delete: async (id) => {
        await this.repository.delete(id);
        await sync.changed(this.ownerUid,id);
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
  publishFiles():void{if(!this.revoked&&!this.disposed)this.store.set({projectFiles:this.inventory.snapshot().map(({data,...file})=>({...file,bytes:data.length}))});}
  async openProject(transport:SessionTransport,expected:ProjectRecord,restore=false):Promise<void>{
    this.assertOwner();let bytes=expected.artifactError?undefined:expected.artifact,remote=expected.cloud?.remote??null;
    if(this.ownerUid&&(restore||!expected.artifactError&&!bytes&&remote)){const prepared=await sync.prepareOpen(expected.id,restore);expected=prepared.record;bytes=prepared.bytes;remote=prepared.remote;}
    this.assertOwner();
    if(bytes){
      const artifact=decodeProjectArtifact(bytes),fromCloud=Boolean(this.ownerUid)&&(restore||!expected.artifact);
      const saved=expected.meta??{...nextMeta(remote?.name??artifact.name),id:expected.id};
      const project=fromCloud&&remote?{...saved,name:remote.name,at:Date.parse(remote.updatedAt)}:saved;
      const source:ReplacementSource={kind:'portable',portable:artifact.engine as import('@femlab/registry').PortableProject,project:{meta:project,expected}};
      // A downloaded snapshot adopts its verified server revision; cached opens preserve pending operations.
      restoredArtifacts.set(source,{artifact,bytes,cloud:fromCloud?{remote,dirty:false,deleted:false}:undefined,restoreDeleted:restore});await transport.replaceWith(source);
    }
    else {const source:ReplacementSource=expected.journal?{kind:'journal',entries:expected.journal.entries,skipSolves:true,project:{meta:expected.meta!,expected}}:{kind:'legacy-project',commands:expected.cmds as Command[],project:{meta:expected.meta!,expected}};if(expected.artifact&&expected.artifactError)sourceInputs.set(source,decodeProjectArtifact(expected.artifact).files);await transport.replaceWith(source);}
  }
  cloudHost(transport:SessionTransport):CloudProjectHost {
    const owner=()=>{this.assertOwner();if(!this.ownerUid)throw new FemError('unsupported','Sign in to sync private projects','account');return this.ownerUid;};
    const restore=async(id:string)=>{owner();await this.prepareToLeave();const row=await storageFor(this.ownerUid).read(id);this.assertOwner();if(!row)throw new FemError('not-found','the project is no longer available','project');
      const remote=row.cloud?.conflict;
      if(remote?.deletedAt){const generation=crypto.randomUUID();await storageFor(this.ownerUid).update(id,current=>{if(!current||current.generation!==row.generation||current.artifactTag!==row.artifactTag||current.cloud?.conflict?.revision!==remote.revision)throw new FemError('session.conflict','The browser project changed before accepting cloud deletion.','project');return {...current,generation,meta:null,artifact:undefined,artifactTag:undefined,cloud:{remote,dirty:false,deleted:true}};});if(this.currentId===id){this.projectDeleted=true;this.latest=null;await transport.replaceWith({kind:'commands',commands:[]});}else await this.primeProjects();await sync.refresh();return;}
      await this.openProject(transport,row,true);};
    return {
      refresh:async()=>{owner();await sync.refresh();await this.primeProjects();},
      adopt:async id=>{
        owner();const original=await repositoryFor(null).read(id);this.assertOwner();const project=nextMeta(original.meta!.name);
        if(original.artifact&&!original.artifactError){const artifact=decodeProjectArtifact(original.artifact);const source:ReplacementSource={kind:'portable',portable:artifact.engine as import('@femlab/registry').PortableProject,project:{meta:project,expected:null}};restoredArtifacts.set(source,{artifact,bytes:original.artifact,cloud:{remote:null,dirty:true,deleted:false}});await transport.replaceWith(source);}
        else {const source:ReplacementSource=original.journal?{kind:'journal',entries:original.journal.entries,skipSolves:true,project:{meta:project,expected:null}}:{kind:'legacy-project',commands:original.cmds as Command[],project:{meta:project,expected:null}};
          if(original.artifactError){sourceRecovery.set(source,{error:original.artifactError,artifact:original.artifact,artifactTag:original.artifactTag});if(original.artifact)sourceInputs.set(source,decodeProjectArtifact(original.artifact).files);}
          await transport.replaceWith(source);
        }
      },
      restore,
      keepCopy:async id=>{owner();await this.prepareToLeave();const copy=await sync.keepCopy(id);this.assertOwner();if(this.currentId===id){this.projectDeleted=true;this.latest=null;}await this.openProject(transport,copy);},
      download:async id=>{this.assertOwner();if(!id||id===this.currentId){await this.refresh();await this.save();id=this.currentId??undefined;}if(!id)throw new FemError('not-found','Create and save a project before downloading its bundle','project');const row=await this.repository.read(id);this.assertOwner();if(row.artifactError)throw new FemError('unsupported',row.artifactError,'project');if(!row.artifact)throw new FemError('not-found','Open and save this legacy project to create its complete bundle','project');browserDownload(row.meta!.name+'.femlab','application/octet-stream',row.artifact);},
      downloadAsset:async id=>{this.assertOwner();const file=this.inventory.snapshot().find(file=>file.id===id);if(!file)throw new FemError('not-found','The retained project file is no longer available','project');browserDownload(file.name,file.mime,file.data);},
      importBundle:async()=>{this.assertOwner();const admission=transport.stamp;const selected=await new Promise<File|null>(resolve=>{const input=document.createElement('input');input.type='file';input.accept='.femlab,application/octet-stream';input.oncancel=()=>resolve(null);input.onchange=()=>resolve(input.files?.[0]??null);input.click();});if(!selected)return;this.assertOwner();if(selected.size>MAX_PROJECT_ARTIFACT_BYTES)throw new FemError('schema','Project bundle exceeds 128 MiB','project');const bytes=new Uint8Array(await selected.arrayBuffer());this.assertOwner();const artifact=decodeProjectArtifact(bytes),source:ReplacementSource={kind:'portable',portable:artifact.engine as import('@femlab/registry').PortableProject,project:{meta:nextMeta(artifact.name),expected:null}};restoredArtifacts.set(source,{artifact,bytes,cloud:this.ownerUid?{remote:null,dirty:true,deleted:false}:undefined});await transport.replaceWith(source,admission);},
    };
  }
  async abandon(): Promise<void> { await this.binding?.abandon(); }
  fail(error: unknown): void { if (!this.disposed&&!this.revoked) this.store.fail(error); }
  dispose(): void {
    this.disposed = true;
    retireProjectHost(this.store);
    this.stepImport.dispose();
    this.geometryDraft.dispose();
    this.detachAccount();
    this.detachFiles();
    this.detachSync();
    if (this.ownsFiles) { completedFileStores.delete(this.completedFiles); this.completedFiles.dispose(); }
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
  private inputs:ProjectAsset[]=[];
  private captureInputReads=false;
  private pickedInput(name:string,mime:string,data:string|Uint8Array):void{const inventory=createProjectFileInventory(()=>crypto.randomUUID());inventory.replace(this.inputs);inventory.capture('input',name,mime,data);this.inputs=inventory.snapshot();}
  private withInputs(source:ReplacementSource):ReplacementSource{if(this.inputs.length){sourceInputs.set(source,this.inputs.map(file=>({...file,data:file.data.slice()})));this.inputs=[];}return source;}
  readonly registry: Registry;
  private native: Registry;
  private readonly lifetime = new AbortController();
  private detach = () => {};
  constructor(public bundle: Bundle, public transport: SessionTransport, private readonly recordsNavigation = true) {
    this.native = this.makeNative();
    this.registry = this.makeNative();
    this.registry.dispatch = (command) => this.dispatch(command);
    this.registry.query = (query) => this.query(query);
    bindRegistryProducer(this.registry, async () => {
      const owner = this.bundle; const transport = this.transport;
      const child = new Producer(owner, await transport.fork(), this.recordsNavigation);
      return child.handle();
    });
    this.listen();
  }
  handle(): RegistryProducer {
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
      for (const panel of ['assistant', 'tutorial']) if (!this.bundle.revoked&&bundle.ownerUid===this.bundle.ownerUid&&this.bundle.store.state.panels[panel]) bundle.store.togglePanel(panel, true);
      this.bundle = bundle; this.transport = next; this.native = this.makeNative(); this.listen();
    });
  }
  private makeNative(): Registry {
    const bundle = this.bundle; const transport = this.transport;
    const ctx = makeHostContext(bundle.store, transport, bundle.viewer, host, bundle.validation, bundle.results, bundle.history, undefined, undefined, () => bundle.refresh(), {
      projects: bundle.projectApi(transport), active: () => transport.assertActive(),
      completedFiles: bundle.completedFiles,
      pickedInput:(name,mime,data)=>this.pickedInput(name,mime,data),
      replay: async (commands, benchmark) => { await transport.replaceWith(this.withInputs({ kind: 'commands', commands: commands as Command[], ...(benchmark ? { benchmark } : {}) })); },
      captureImport: () => {
        const admitted = transport.stamp;
        const captured=captureProjectInputs(browserAbaqusIo(document,crypto,bundle.store.state.folder),()=>crypto.randomUUID());
        return {
          io:captured.io,
          dependencies: async source => await transport.query({ query: 'query.abaqusDependencies', ...source }) as AbaqusDependencies,
          convert: async query => {const files=captured.snapshot();if(!files.length)captured.add(query.sourceName??'model.inp','text/plain',query.text??'');for(const [name,text] of Object.entries(query.sourceFiles??{}))if(text!==undefined)captured.add(name,'text/plain',text);this.inputs=captured.snapshot();return await transport.query(query) as AbaqusConversion;},
          replace: async (commands, abaqusReport) => { await transport.replaceWith(this.withInputs({ kind: 'commands', commands, abaqusReport }), admitted); },
        };
      },
    }, bundle.capture, undefined, accounts.services, bundle.comparison,projectAccessFor(bundle.ownerUid));
    const download=ctx.files.download;
    ctx.files.download=(name,mime,data)=>{bundle.assertIdentity();download(name,mime,data);};
    const folder=ctx.folder;
    ctx.folder={...folder,writeText:async(path,text)=>{bundle.assertIdentity();await folder.writeText(path,text);},writeBytes:async(path,bytes)=>{bundle.assertIdentity();await folder.writeBytes(path,bytes);},readText:async(path,limit)=>{const data=await folder.readText(path,limit);if(this.captureInputReads)this.pickedInput(path,'text/plain',data);return data;},readBytes:async path=>{const data=await folder.readBytes(path);if(this.captureInputReads)this.pickedInput(path,'application/octet-stream',data);return data;}};
    ctx.transport=new Proxy(transport,{get:(target,key)=>key==='importFile'?async (file:import('@femlab/registry').ModelFile)=>{const source=this.withInputs({kind:'file',file});const next=await target.replaceWith(source);const snapshot=await next.snapshot();return {seq:-1,revision:snapshot.model.revision,hash:snapshot.model.hash!,warnings:[],output:{type:'none'},journal:snapshot.file.journal};}:typeof Reflect.get(target,key)==='function'?Reflect.get(target,key).bind(target):Reflect.get(target,key)});
    ctx.step = {
      import: input => {
        const admitted = transport.stamp;
        const io = browserAbaqusIo(document, crypto, bundle.store.state.folder, STEP_ACCEPT);
        return bundle.stepImport.run(input, io, {
          signal: this.lifetime.signal,
          retainSource:(name,bytes)=>{const staged=bundle.inventory.prepare('input',name,'application/step',bytes);return {complete:()=>{staged.complete();},discard:()=>staged.discard()};},
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
        child.bundle.assertOwner();
        child.bundle.store.set({ scriptOut: [...result.console, result.error ?? 'done'] });
        return result;
      } finally { child.lifetime.signal.removeEventListener('abort', stop); child.bundle.store.set({ scriptRunning: false, source: 'you' }); scriptJobs.delete(job); }
    };
    ctx.script.stop = () => { for (const job of scriptJobs) { if (job.producer.bundle !== bundle) continue; job.runner.stop(); job.producer.lifetime.abort(); void job.producer.transport.release().catch(() => undefined); } };
    const registry = new Registry({ schema: schema as unknown as EngineSchema, host: ctx, hostCommands: [...HOST_COMMANDS, ...appHostCommands(bundle.store, transport, bundle.viewer, () => bundle.refresh(), bundle.results, () => this.registry, bundle.comparison,bundle.cloudHost(transport))], hostQueries: [...HOST_QUERIES, ...appHostQueries(bundle.store), { ...WORKSPACE_STATUS, run: () => workspaceStatus(bundle.store.state.ready) }] });
    return registry;
  }
  async dispatch(command: { cmd: string } & Record<string, unknown>): Promise<unknown> {
    const before = this.bundle; const native = this.native; const transport = this.transport;
    const definition = native.describe(command.cmd);
    before.assertOwner();
    if (this.recordsNavigation && interruptsNavigation(command, definition.execution)) {
      await admitUserNavigation(definition.execution);
      before.assertOwner();
    }
    // Expired retained output is a local delivery status, never an engineering failure or a
    // reason to erase a currently displayed solve error. The private cache owns its authority.
    if (command.cmd === 'file.download') return native.dispatch(command);
    if (definition.provider === 'host' && !['control', 'sessionView'].includes(definition.execution)) await transport.assertActive();
    this.inputs=[];this.captureInputReads=command.cmd==='file.open'||command.cmd==='geometry.importFile';
    before.store.set({ lastError: null });
    const long = command.cmd === 'solve.run' || command.cmd === 'study.converge';
    if (long) before.store.set({ solving: String(command['step'] ?? ''), progress: { phase: 'starting', fraction: 0 } });
    transport.onProgress(progress => { if (!before.disposed&&!before.revoked) before.store.set({ progress: { phase: progress.phase, fraction: progress.fraction ?? 0, message: progress.message } }); });
    let publication = before;
    try {
      const versionBefore = transport.stamp.stateVersion;
      const who = before.store.state.source;
      const ack = await native.dispatch(command);
      // Only the trusted captured file.save path may finish across a document change.
      // Its physical I/O is identity-fenced above; never publish it into the new bundle.
      if(command.cmd==='file.save'&&definition.provider==='host'&&(before.disposed||this.bundle!==before)){before.assertIdentity();return ack;}
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
      // Cancellation can finish by recovering into a fresh same-owner session without
      // adopting this initiating handle. Return its control acknowledgement only; do not
      // publish old state or retarget a retained producer onto that recovered session.
      if(current.disposed&&!current.revoked&&definition.execution==='control'&&current.ownerUid===accounts.state.uid&&current.ownerEpoch===accounts.version)return ack;
      current.assertOwner();
      if(this.inputs.length){current.inventory.replace([...current.inventory.snapshot(),...this.inputs]);this.inputs=[];await current.refresh();}
      current.publishFiles();
      current.store.log('command', command.cmd);
      if (displayed === current) {
        if (definition.execution === 'replacement') {
          // Only a newly opened Model/example needs its first complete snapshot here.
          // Restores already claimed their artifact; saving them again would upload an
          // unchanged cloud revision. Empty new projects keep normal autosave batching.
          if (command.cmd !== 'project.new' && command.cmd !== 'model.new' && current.currentId) {
            const saved = await current.repository.read(current.currentId);
            if (!saved.artifact && !saved.artifactError) await current.prepareToLeave();
          }
          current.assertOwner();
          if (this.recordsNavigation) navigation.record();
        } else if (this.recordsNavigation && (command.cmd === 'navigation.home' || command.cmd === 'panel.toggle' && ['projects', 'examples'].includes(String(command['panel'])))) navigation.record();
        else if (this.recordsNavigation && definition.execution === 'modelWrite' && (!location.hash || location.hash.startsWith('#/'))) navigation.record();
      }
      return ack;
    } catch (error) { if (this.recordsNavigation || !this.lifetime.signal.aborted) publication.fail(error); throw error; }
    finally { if (long) this.bundle.store.set({ solving: null, progress: null }); }
  }
  async query(query: { query: string } & Record<string, unknown>): Promise<unknown> {
    this.bundle.assertOwner();
    const native = this.native; const transport = this.transport;
    if (native.describe(query.query).provider === 'host') await transport.assertActive();
    return native.query(query);
  }
}

let displayed: Bundle | undefined;
let publishedOnce=false;
let navigationBooted = false;
let initialUserActivation = false;
function interruptsNavigation(command: { cmd: string } & Record<string, unknown>, execution: string): boolean {
  return ['replacement', 'modelWrite', 'workspace'].includes(execution) || command.cmd === 'navigation.home' || command.cmd === 'panel.toggle' && ['projects', 'examples'].includes(String(command['panel']));
}
async function admitUserNavigation(execution: string): Promise<void> {
  // Mark the intention before any fork/await, including the initial boot's asynchronous reads.
  initialUserActivation = true;
  // Menus have no document targets and stay responsive during a private download.
  if (execution === 'sessionView') { navigation.interrupt(); return; }
  await navigation.interruptAndWait();
  await workspace.whenIdle();
}
const navigation = new WorkspaceNavigation(browserNavigationHistory(window), {
  current: () => ({ id: displayed?.currentId ?? null, home: displayed?.store.state.panels['projects'] === true, examples: displayed?.store.state.panels['examples'] === true }),
  show: page => {
    if (!displayed || displayed.revoked) return;
    const store = displayed.store;
    const started = Boolean(store.state.model && (store.state.model.bodies.length || store.state.revision));
    store.set({ panels: { ...store.state.panels, projects: page === 'home' && started, examples: page === 'examples' } });
  },
  open: async (id, signal) => {
    signal.throwIfAborted();
    const owner = displayed;
    if (!owner) throw expired();
    if (owner.store.state.project?.autosave === false && unsaved(owner.store.state)) throw new FemError('unsupported', 'Save this project before opening another workspace with browser history.', 'navigation', 'project.save');
    if (owner.ownerUid && accounts.state.status === 'loading') await new Promise<void>(resolve => {
      const stop = accounts.subscribe(account => {
        if (account.status !== 'loading' || accounts.version !== owner.ownerEpoch) { queueMicrotask(stop); resolve(); }
      });
    });
    owner.assertOwner();
    // A fresh signed-in browser may need the private catalogue before its uncached open.
    if (owner.ownerUid && !owner.store.state.projects.some(project => project.id === id)) await sync.refresh();
    signal.throwIfAborted();
    owner.assertOwner();
    if (displayed !== owner) throw expired();
    const producer = new Producer(owner, await owner.transport.fork(), false);
    const lease = producer.handle();
    const cancel = () => { void lease.release(); };
    signal.addEventListener('abort', cancel, { once: true });
    try { signal.throwIfAborted(); await producer.registry.dispatch({ cmd: 'project.open', id }); }
    finally { signal.removeEventListener('abort', cancel); await lease.release(); }
  },
  fail: error => displayed?.fail(error),
});
export async function prepareAccountNavigation(): Promise<void> {
  const id = await displayed?.prepareAccountReturn();
  if (id) sessionStorage.setItem('femlab.accountReturnProject', JSON.stringify({id,owner:displayed!.ownerUid}));
  else sessionStorage.removeItem('femlab.accountReturnProject');
}
accountLeaveHook(prepareAccountNavigation);
let resettingIdentity=false;
function queueIdentityReset():void{if(resettingIdentity)return;resettingIdentity=true;queueMicrotask(async()=>{try{await workspace.whenIdle();while(displayed?.revoked){const previous=displayed,epoch=accounts.version;try{await workspace.reset();}catch(error){if(accounts.version!==epoch){await workspace.whenIdle();continue;}if(displayed===previous){previous.store.fail(error);break;}}await workspace.whenIdle();}}finally{resettingIdentity=false;}});}
const workspace = new SessionWorkspace<Bundle>({
  spawn: () => new Worker(new URL('./session.worker.ts', import.meta.url), { type: 'module' }),
  epoch: () => crypto.randomUUID(), engine: engineOptions,
  build: async (transport, snapshot, source) => { if(displayed?.revoked&&source!==undefined)throw expired();const bundle = new Bundle(await transport.fork(), source ? recoveredFiles.get(source) : undefined); try { await bundle.initialize(snapshot, source); } catch (error) { try { await bundle.abandon(); } finally { bundle.dispose(); } throw error; } bundles.set(transport.channel, bundle); return bundle; },
  publish: ({ resources: bundle }) => {
    const priorPublication=publishedOnce;publishedOnce=true;
    const identityChanged = displayed && (displayed.ownerUid !== bundle.ownerUid || displayed.ownerEpoch !== bundle.ownerEpoch);
    // A folder is a workspace capability; replacing the engine keeps the current selection.
    if (displayed&&!displayed.revoked&&displayed.ownerUid===bundle.ownerUid) bundle.store.setFolder(displayed.store.state.folder);
    if (displayed&&!displayed.revoked&&displayed.ownerUid===bundle.ownerUid && !bundle.store.state.result && bundle.store.state.viewMode !== 'results') bundle.store.set({ tab: displayed.store.state.tab });
    if (displayed&&!displayed.revoked&&displayed.ownerUid===bundle.ownerUid) for (const [panel, open] of Object.entries(displayed.store.state.panels)) {
      if (panel === 'assistant' || panel.startsWith('assistant.') || panel === 'tutorial' || panel.startsWith('skill:')) bundle.store.togglePanel(panel, open);
    }
    bundle.activateFiles(displayed);
    displayed = bundle;
    const ui = new Producer(bundle, bundle.uiTransport);
    const dispatch: Registry['dispatch'] = async command => {
      if (interruptsNavigation(command, ui.registry.describe(command.cmd).execution)) await admitUserNavigation(ui.registry.describe(command.cmd).execution);
      bundle.assertOwner();
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
      if (interruptsNavigation(command, owner.registry.describe(command.cmd).execution)) await admitUserNavigation(owner.registry.describe(command.cmd).execution);
      owner.bundle.assertOwner();
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
    if (identityChanged) navigation.reset();
    if (!root.querySelector('.shell, .start-layout, .start')) root.textContent = '';
    startup.retire();
    detachStartupAccount();
    render(<App sessionKey={bundle.transport.stamp.session.backendEpoch} store={bundle.store} dispatch={dispatch} query={query => ui.registry.query(query)} viewer={bundle.viewer} rightViewer={bundle.rightViewer} comparison={bundle.comparison} commands={ui.registry.list().commands} registry={ui.registry} />, root);
    bundle.activateProjectSync();
    if(priorPublication)queueMicrotask(()=>{void finishBoot(bundle).catch(error=>bundle.fail(error));});
  },
});
const startup = new StartupHost({
  schema: schema as unknown as EngineSchema, caps: host, account: accounts.state,
  listProjects: async()=>{const epoch=accounts.version,owner=accounts.state.uid;const projects=await repositoryFor(owner).list();if(epoch!==accounts.version)throw expired();return projects;},
  start: async signal => {
    prepareKeyStorage(__HOSTED_AI__);
    // A late non-cancellable adapter probe cannot spawn a Worker after cancellation.
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    engineOptions.gpu = Boolean(await startupWait(Promise.resolve(gpu?.requestAdapter()), signal));
    await startupWait(historyFor(accounts.state.uid).read(), signal);
    signal.throwIfAborted();
    const active = await workspace.start(signal);
    void finishBoot(active.resources).catch(error => active.resources.fail(error));
  },
});
const detachStartupAccount = accounts.subscribe(account => startup.setAccount(account));
accounts.subscribe(account=>sync.activate(account.status==='active'&&account.uid?{uid:account.uid,epoch:accounts.version}:null));
window.addEventListener('online',()=>{void sync.refresh().catch(()=>undefined);});
// The existing Start component is mounted before any awaited adapter, storage or engine work.
render(<App startup={startup} />, root);
void startup.loadProjects();
const accountReady = accounts.initialize();
void startup.start().catch(() => undefined); // Failure remains visible, with registered Retry.

async function finishBoot(owner: Bundle): Promise<void> {
  await accountReady;
  if (displayed !== owner || owner.revoked) return;
  await owner.refresh();
  // Never retarget initial navigation onto a session that replaced this startup publication.
  if (displayed !== owner) return;
  if (navigationBooted) {
    if (owner.freshStart) await resumeAccountReturn(owner);
    return;
  }
  navigationBooted = true;
  if (initialUserActivation) { await navigation.start(false); return; }
  // Managed routes acquire their cancellation scope synchronously, before any producer fork.
  if (location.hash.startsWith('#/') && !sessionStorage.getItem('femlab.accountReturnProject')) { await navigation.start(); return; }
  // Use the ordinary producer lease: automatic navigation can follow only replacements it
  // initiates, and a late share decode cannot target a project selected by the person.
  const operation = new Producer(owner, await owner.transport.fork());
  const lease = operation.handle();
  try {
    if (initialUserActivation) { await navigation.start(false); return; }
    if(await resumeAccountReturn(owner)) { await navigation.start(false); return; }
    if (location.hash.startsWith('#/')) { await navigation.start(); return; }
    const example = new URLSearchParams(location.search).get('example');
    if (example) await lease.registry.dispatch({ cmd: 'file.openExample', name: example });
    const commands = await readShareFragment(location.hash);
    if (commands) {
      await operation.transport.replaceWith({ kind: 'commands', commands: commands as Command[] });
    }
    await navigation.start(!example);
  } finally { await lease.release(); }
}

/** An auth return never selects another account's or an anonymous browser project's bytes. */
async function resumeAccountReturn(owner:Bundle):Promise<boolean>{
  if(displayed!==owner||owner.revoked||owner.ownerUid===null&&accounts.state.status==='loading')return false;
  const raw=sessionStorage.getItem('femlab.accountReturnProject');if(!raw)return false;
  sessionStorage.removeItem('femlab.accountReturnProject');
  let pointer:{id?:unknown;owner?:unknown};try{pointer=JSON.parse(raw) as typeof pointer;}catch{return false;}
  if(pointer?.owner!==owner.ownerUid||typeof pointer.id!=='string')return false;
  const producer=new Producer(owner,await owner.transport.fork());
  try{owner.assertOwner();await producer.registry.dispatch({cmd:'project.open',id:pointer.id});return true;}finally{await producer.handle().release();}
}
