import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
import type { ComponentProps, VNode } from 'preact';
import type { ActiveAppProps, App } from '../src/ui/App';
import type { Progress } from '@femlab/registry';
import type { Viewer, CameraState } from '../src/viewer/viewer';
import type { SessionRequest, SessionResponse } from '../src/session-protocol';
import { SessionRuntime } from '../src/session-runtime';
import { SessionTransport } from '../src/session-transport';
import { FileDelivery, FileArtifactMetadata } from '@femlab/registry';
import { fakeDir } from './project-fake';
import { IDBFactory } from 'fake-indexeddb';
import type { AccountController, AuthPort, Identity } from '../src/account/controller';
import { indexedDbAtomicProjects } from '../src/project-repository';
import { partitionedAtomicProjects } from '../src/project-partitions';
import { indexedDbStore } from '../src/share';
import { decodeProjectArtifact } from '../src/project-artifact';

const identityFixture = vi.hoisted(() => ({ changed: null as ((identity: Identity | null) => void) | null, account: null as AccountController | null, beforeLeave: (async () => undefined) as () => Promise<void> }));
vi.mock('../src/account/browser', async () => {
  const { AccountController } = await import('../src/account/controller');
  const auth: AuthPort = {
    initialize: async changed => { identityFixture.changed = changed; changed(null); return { emailLinkPending: false }; },
    signIn: async () => 'signed-in', signOut: async () => undefined,
    token: async uid => `test-token-${uid}`,
  };
  const account = new AccountController({ auth, googleEnabled: true, origin: 'https://test-account.invalid',
    fetch: async (_url, options) => {
      const token = new Headers(options?.headers).get('Authorization')!;
      const uid = token.replace('Bearer test-token-', '');
      return new Response(JSON.stringify({ id: uid, email: `${uid}@example.test`, createdAt: '2026-10-16T12:00:00Z', status: 'active', billingAvailable: false }), { status: 200 });
    }, beforeLeave: () => identityFixture.beforeLeave(), navigate: () => undefined,
  });
  identityFixture.account = account;
  return { accounts: account, accountLeaveHook: (hook: () => Promise<void>) => { identityFixture.beforeLeave = hook; } };
});
function emitIdentity(uid: string | null): void { identityFixture.changed!(uid === null ? null : { uid, email: `${uid}@example.test` }); }

const mounted = vi.hoisted(() => ({ props: null as ActiveAppProps | null, makeViewer: null as ((props: ActiveAppProps) => Viewer) | null, afterReady: null as ((viewer: Viewer) => void) | null }));
vi.mock('preact', async original => ({ ...await original<typeof import('preact')>(), render: (node: VNode<ComponentProps<typeof App>>) => {
  if ('startup' in node.props) return;
  mounted.props = node.props;
  const viewer = mounted.makeViewer?.(node.props);
  if (viewer) {
    node.props.viewer.current = viewer;
    node.props.viewer.onReady?.();
    mounted.afterReady?.(viewer);
  }
} }));
vi.mock('../src/ui/App', () => ({ App: () => null }));
const wasm = createRequire(import.meta.url)('../../../tools/wasm-node/femlab_engine_wasm.js') as typeof import('../src/generated/wasm/femlab_engine_wasm.js');
const workers: LocalWorker[] = [];
class LocalWorker {
  onmessage: ((event: MessageEvent<SessionResponse>) => void) | null = null;
  onerror = null;
  private owner: InstanceType<typeof wasm.SessionEngine> | undefined;
  private closed = false;
  progressSample: Progress | null = null;
  private runtime = new SessionRuntime(async (_options, epoch) => this.owner = new wasm.SessionEngine(1, epoch), wasm.PreparedEngine.create, () => 0);
  constructor() { workers.push(this); }
  postMessage(request: SessionRequest) {
    // Typed public transport fixture; the real checked owner still executes the Command.
    if (request.op === 'dispatch' && this.progressSample) {
      this.onmessage?.({ data: { id: request.id, context: request.context, progress: this.progressSample } } as MessageEvent<SessionResponse>);
    }
    void this.runtime.accept(structuredClone(request), (reply, raw = []) => {
      if (!this.closed) this.onmessage?.({ data: structuredClone(reply, { transfer: raw }) } as MessageEvent<SessionResponse>);
    });
  }
  terminate() { if (!this.closed) { this.closed = true; this.owner?.free(); } }
}
afterEach(() => { for (const worker of workers) worker.terminate(); mounted.makeViewer = null; mounted.afterReady = null; vi.unstubAllGlobals(); localStorage.clear(); });

function drawing(onBounds: () => void) {
  let camera: CameraState = { position: [20,20,20], target: [0,0,0], up: [0,0,1] };
  const surface = vi.fn<Viewer['setSurface']>((installed) => { if (installed.indices.length || installed.edges?.length) onBounds(); });
  const viewer = {
    hasSurface: true,
    setGeometryDraft: vi.fn<Viewer['setGeometryDraft']>(),
    setSurface: surface, setField: vi.fn(), setDeformed: vi.fn(), setDim: vi.fn(), setMode: vi.fn(), animate: vi.fn(),
    autoScale: vi.fn<Viewer['autoScale']>(() => 1), setColormap: vi.fn<Viewer['setColormap']>(),
    getCamera: () => structuredClone(camera), setCamera: (next: CameraState) => { camera = structuredClone(next); },
    fit: vi.fn(() => {
      expect(surface.mock.lastCall?.[0].positions.length).toBeGreaterThan(0);
      camera = { position: [1.5,1.5,1.5], target: [0.5,0.5,0.5], up: [0,0,1] };
    }),
  } satisfies Pick<Viewer, 'hasSurface' | 'setGeometryDraft' | 'setSurface' | 'setField' | 'setDeformed' | 'setDim' | 'setMode' | 'animate' | 'autoScale' | 'setColormap' | 'getCamera' | 'setCamera' | 'fit'>;
  return viewer;
}

it('boots the real session host, saves and reopens projects, and revokes retained console and UI handles', async () => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.setItem('femlab.autosave', 'off');
  const drawings: ReturnType<typeof drawing>[] = [];
  mounted.makeViewer = props => { const next = drawing(() => props.viewer.onBounds?.()); drawings.push(next); return next as unknown as Viewer; };
  vi.stubGlobal('Worker', LocalWorker);
  const localDb = new IDBFactory();
  vi.stubGlobal('indexedDB', localDb);
  // Hosted storage is deliberately offline here. This test exercises real local ownership,
  // engine snapshots and account epochs; resumable HTTP is covered by the typed API tests.
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => { throw new TypeError('test cloud storage offline'); }));
  const appHost = await import('../src/main');
  await vi.waitFor(() => expect(mounted.props?.store.state.ready).toBe(true));
  const initial = window.fem;
  const originalUi = mounted.props!;
  expect((await initial.query.model()).name).toBeTruthy();
  expect(initial.registry.list().commands.length).toBeGreaterThan(50);
  const galleryFilter = { query: 'cantilever', tag: 'beam', difficulty: 1 } as const;
  await initial.dispatch({ cmd: 'example.filter', ...galleryFilter });
  const originalFilter = mounted.props!.store.state.exampleFilter;
  const first = await initial.dispatch({ cmd: 'project.new', name: 'first' }) as { id: string };
  expect(mounted.props!.store.state.exampleFilter).toEqual(galleryFilter);
  expect(mounted.props!.store.state.exampleFilter).not.toBe(originalFilter);
  const sample: Required<Progress> = { phase: 'solve', fraction: 0.5, message: 'refinement 2: relative residual 2.5e-6' };
  workers.at(-1)!.progressSample = sample;
  const received: unknown[] = [];
  const store = mounted.props!.store;
  const stop = store.subscribe(() => received.push(store.state.progress));
  await initial.dispatch({ cmd: 'geometry.addBox', name: 'body', size: ['1 m', '1 m', '1 m'] });
  stop(); workers.at(-1)!.progressSample = null;
  expect(received).toContainEqual(sample);
  expect(drawings.at(-1)!.fit).not.toHaveBeenCalled();
  await expect(appHost.prepareAccountNavigation()).rejects.toMatchObject({ code: 'unsupported', suggestion: 'project.save' });
  const saved = await initial.dispatch({ cmd: 'project.save' }) as { commands: number };
  expect(saved.commands).toBe(2);
  await vi.waitFor(() => expect(location.hash).toBe(`#/projects/${first.id}`));
  const beforeMenu = await window.fem.query.document();
  await window.fem.dispatch({ cmd: 'navigation.home' });
  expect(location.hash).toBe('#/');
  expect(mounted.props!.store.state.panels['projects']).toBe(true);
  expect(await window.fem.query.document()).toEqual(beforeMenu);
  await window.fem.dispatch({ cmd: 'panel.toggle', panel: 'projects', open: false });
  expect(location.hash).toBe(`#/projects/${first.id}`);
  const beforeLogin = await window.fem.query.journal();
  await appHost.prepareAccountNavigation();
  expect(JSON.parse(sessionStorage.getItem('femlab.accountReturnProject')!)).toEqual({ id: first.id, owner: null });
  expect((await window.fem.query.journal()).hash).toBe(beforeLogin.hash);
  sessionStorage.removeItem('femlab.accountReturnProject');
  await initial.dispatch({ cmd: 'project.rename', id: first.id, name: 'renamed' });
  expect(mounted.props!.store.state.project?.name).toBe('renamed');
  await expect(originalUi.query!({ query: 'query.model' })).rejects.toMatchObject({ code: 'session.expired' });
  const firstUi = mounted.props!;
  const custom: CameraState = { position: [7,8,9], target: [0.5,0.5,0.5], up: [0,0,1] };
  await firstUi.dispatch({ cmd: 'view.setCamera', ...custom });
  await firstUi.dispatch({ cmd: 'view.setMode', mode: 'mesh' });
  expect(firstUi.store.state.viewMode).toBe('mesh');
  await firstUi.dispatch({ cmd: 'model.setName', name: 'first edited' });
  expect(firstUi.store.state.model?.name).toBe('first edited');
  expect(await firstUi.query!({ query: 'query.view' })).toEqual(custom);
  await firstUi.dispatch({ cmd: 'project.save' });
  await expect(firstUi.dispatch({ cmd: 'geometry.remove', name: 'missing' })).rejects.toMatchObject({ code: 'not-found' });
  expect(firstUi.store.state.lastError?.code).toBe('not-found');
  const second = await firstUi.dispatch({ cmd: 'project.new', name: 'second' }) as { id: string };
  expect(mounted.props!.store.state.exampleFilter).toEqual(galleryFilter);
  await expect(initial.query.model()).rejects.toMatchObject({ code: 'session.expired' });
  await expect(initial.dispatch({ cmd: 'geometry.remove', name: 'body' })).rejects.toMatchObject({ code: 'session.expired' });
  expect((await window.fem.query.model()).bodies).toHaveLength(0);
  await window.fem.dispatch({ cmd: 'project.open', id: first.id });
  expect(mounted.props!.store.state.exampleFilter).toEqual(galleryFilter);
  expect((await window.fem.query.model()).bodies).toHaveLength(1);
  expect(mounted.props!.store.state.model?.name).toBe('first edited');
  // Replacement Fit waits until the Result and shell have published their overlays.
  await vi.waitFor(() => expect(drawings.at(-1)!.fit).toHaveBeenCalledTimes(1));
  expect((await window.fem.query.journal()).entries).toHaveLength(3);
  const reopened = mounted.props!;
  mounted.afterReady = viewer => viewer.setCamera(custom);
  await window.fem.dispatch({ cmd: 'project.open', id: first.id });
  mounted.afterReady = null;
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(drawings.at(-1)!.fit).not.toHaveBeenCalled();
  expect(await window.fem.registry.query({ query: 'query.view' })).toEqual(custom);
  reopened.viewer.onBounds?.();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(drawings.at(-1)!.fit).not.toHaveBeenCalled();
  expect(await window.fem.registry.query({ query: 'query.view' })).toEqual(custom);
  await window.fem.dispatch({ cmd: 'project.delete', id: second.id });
  await window.fem.dispatch({ cmd: 'project.delete', id: first.id });
  expect(mounted.props!.store.state.projects).toEqual([]);
  await window.fem.dispatch({ cmd: 'model.setName', name: 'deleted stays deleted' });
  expect(await window.fem.dispatch({ cmd: 'project.save' })).toBeNull();
  expect(mounted.props!.store.state.projects).toEqual([]);
  // Actual host ownership follows this document through Worker recovery, but expires when
  // the person changes document/folder/conversation. The download boundary is injected here;
  // actual browser delivery is a separate scheduled acceptance case.
  const payloads: Blob[] = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { if (blob instanceof Blob) payloads.push(blob); return 'blob:unit-completed-file'; });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  await window.fem.dispatch({ cmd: 'project.new', name: 'file-history' });
  const file = FileDelivery.parse(await window.fem.dispatch({ cmd: 'file.save', to: 'download' }));
  expect(file.id).toBeTruthy();
  const originalBytes = await payloads.at(-1)!.text();
  expect(file.bytes).toBe(new TextEncoder().encode(originalBytes).byteLength);
  await window.fem.dispatch({ cmd: 'model.setName', name: 'changed after delivery' });
  await window.fem.dispatch({ cmd: 'solve.cancel' });
  const meta = await window.fem.registry.query({ query: 'query.fileDelivery', id: file.id });
  expect(meta).toEqual({ file: FileArtifactMetadata.parse(file) });
  const repeated = FileDelivery.parse(await window.fem.dispatch({ cmd: 'file.download', id: file.id }));
  expect(repeated.id).toBe(file.id);
  expect(await payloads.at(-1)!.text()).toBe(originalBytes);
  expect((await window.fem.query.model()).name).toBe('changed after delivery');
  await window.fem.dispatch({ cmd: 'folder.open', handle: fakeDir({}, 'other') });
  expect(await window.fem.registry.query({ query: 'query.fileDelivery', id: file.id })).toEqual({ file: null });
  const beforeFileVersion = mounted.props!.store.state.completedFilesVersion;
  const inFolder = FileDelivery.parse(await window.fem.dispatch({ cmd: 'file.save' }));
  expect(mounted.props!.store.state.completedFilesVersion).toBeGreaterThan(beforeFileVersion);
  expect(inFolder.to).toBe('folder');
  await window.fem.dispatch({ cmd: 'folder.close' });
  expect(await window.fem.registry.query({ query: 'query.fileDelivery', id: inFolder.id })).toEqual({ file: null });
  const beforeClear = FileDelivery.parse(await window.fem.dispatch({ cmd: 'file.save' }));
  await window.fem.dispatch({ cmd: 'chat.clear' });
  expect(await window.fem.registry.query({ query: 'query.fileDelivery', id: beforeClear.id })).toEqual({ file: null });
  const beforeNew = FileDelivery.parse(await window.fem.dispatch({ cmd: 'file.save' }));
  await window.fem.dispatch({ cmd: 'project.new', name: 'other-document' });
  expect(await window.fem.registry.query({ query: 'query.fileDelivery', id: beforeNew.id })).toEqual({ file: null });
  await expect(window.fem.dispatch({ cmd: 'geometry.remove', name: 'missing' })).rejects.toMatchObject({ code: 'not-found' });
  const engineeringError = mounted.props!.store.state.lastError;
  await expect(window.fem.dispatch({ cmd: 'file.download', id: beforeNew.id })).rejects.toMatchObject({ code: 'file.not-found' });
  expect(mounted.props!.store.state.lastError).toBe(engineeringError);
  // Account boundaries exercise the actual AccountController and main/session resources,
  // including a complete portable project containing authored inputs and delivered outputs.
  const anonymousStorage = indexedDbAtomicProjects(localDb);
  const failedArchive = await window.fem.dispatch({ cmd: 'project.new', name: 'anonymous archive recovery' }) as { id: string };
  await window.fem.dispatch({ cmd: 'geometry.addBox', name: 'older_backup_body', size: ['1 m', '1 m', '1 m'] });
  await window.fem.dispatch({ cmd: 'file.save', to: 'download' });
  await window.fem.dispatch({ cmd: 'project.save' });
  const oldComplete = (await anonymousStorage.read(failedArchive.id))!;
  await window.fem.dispatch({ cmd: 'geometry.remove', name: 'older_backup_body' });
  await window.fem.dispatch({ cmd: 'geometry.addBox', name: 'latest_journal_body', size: ['2 m', '2 m', '2 m'] });
  await window.fem.dispatch({ cmd: 'project.save' });
  const anonymous = await window.fem.dispatch({ cmd: 'project.new', name: 'anonymous legacy' }) as { id: string };
  await window.fem.dispatch({ cmd: 'geometry.addBox', name: 'anonymous-only', size: ['1 m', '1 m', '1 m'] });
  await window.fem.dispatch({ cmd: 'project.save' });
  const archiveError = 'A completed output exceeded the project archive capacity.';
  const anonymousRecovery = await anonymousStorage.update(failedArchive.id, previous => ({ ...previous!, artifact: oldComplete.artifact, artifactTag: oldComplete.artifactTag, artifactError: archiveError }));
  const anonymousUi = mounted.props!;
  await window.fem.dispatch({ cmd: 'example.filter', ...galleryFilter });
  emitIdentity('A');
  expect(anonymousUi.store.state.exampleFilter).toEqual({ tag: null, difficulty: null });
  expect(anonymousUi.store.state.model).toBeNull(); expect(anonymousUi.store.state.projects).toEqual([]);
  await vi.waitFor(() => { expect(mounted.props).not.toBe(anonymousUi); expect(mounted.props!.store.state.account.uid).toBe('A'); expect(mounted.props!.store.state.ready).toBe(true); });
  expect(mounted.props!.store.state.exampleFilter).toEqual({ tag: null, difficulty: null });
  expect(mounted.props!.store.state.projects).toEqual([]);
  await expect(anonymousUi.query!({ query: 'query.model' })).rejects.toMatchObject({ code: 'session.expired' });
  await window.fem.dispatch({ cmd: 'account.uploadProject', id: failedArchive.id });
  const adoptedId = mounted.props!.store.state.project!.id;
  expect(adoptedId).not.toBe(failedArchive.id);
  expect((await window.fem.query.model()).bodies.map(body => body.name)).toEqual(['latest_journal_body']);
  expect(await window.fem.registry.query({ query: 'query.results' })).toMatchObject({ records: [] });
  expect(mounted.props!.store.state.projectArtifactError).toBe(archiveError);
  const backedUpFiles = decodeProjectArtifact(oldComplete.artifact!).files;
  expect(mounted.props!.store.state.projectFiles.map(file => file.id)).toEqual(backedUpFiles.map(file => file.id));
  await window.fem.dispatch({ cmd: 'project.save' });
  const adoptedStorage = partitionedAtomicProjects(anonymousStorage, 'A');
  const adopted = (await adoptedStorage.read(adoptedId))!;
  expect(adopted.artifactError).toBe(archiveError); expect(adopted.artifact).toEqual(oldComplete.artifact);
  expect(adopted.cmds).toEqual(anonymousRecovery.cmds); expect(adopted.cloud?.dirty).toBe(true);
  await vi.waitFor(() => expect(mounted.props!.store.state.projectSync.projects[adoptedId]?.phase).toBe('error'));
  expect(await anonymousStorage.read(failedArchive.id)).toEqual(anonymousRecovery);
  await window.fem.dispatch({ cmd: 'example.filter', ...galleryFilter });
  await window.fem.dispatch({ cmd: 'project.new', name: 'private A å' });
  expect(mounted.props!.store.state.exampleFilter).toEqual(galleryFilter);
  for (const command of [
    { cmd: 'geometry.addLine', name: 'shaft', points: [['0 m', '0 m', '0 m'], ['1 m', '0 m', '0 m']], divisions: 1, kind: 'beam' },
    { cmd: 'material.add', name: 'steel', E: '200 GPa', nu: 0.3 },
    { cmd: 'material.assign', material: 'steel', bodies: ['shaft'] },
    { cmd: 'section.add', name: 'round', shape: { kind: 'circle', radius: '50 mm' } },
    { cmd: 'section.assign', section: 'round', bodies: ['shaft'] },
    { cmd: 'mesh.set', mesher: { kind: 'lattice', size: '1 m' } },
    { cmd: 'constraint.fix', name: 'root', on: 'shaft.p0' },
    { cmd: 'load.force', name: 'tip', on: 'shaft.p1', total: ['1000 N', '0 N', '0 N'] },
    { cmd: 'step.add', name: 'axial', procedure: 'static', constraints: ['root'], loads: ['tip'] },
    { cmd: 'solve.run', step: 'axial', solver: 'cpu-direct' },
  ]) await window.fem.dispatch(command);
  const checked = await window.fem.registry.query({ query: 'query.document' });
  expect(typeof checked === 'object' && checked !== null && 'file' in checked).toBe(true);
  const originalInput = JSON.stringify((checked as { file: unknown }).file) + '\r\n';
  const folderFiles = { 'original-A.femlab.json': originalInput };
  await window.fem.dispatch({ cmd: 'folder.open', handle: fakeDir(folderFiles, 'A-only folder') });
  await window.fem.dispatch({ cmd: 'file.open', path: 'original-A.femlab.json' });
  await window.fem.dispatch({ cmd: 'solve.run', step: 'axial', solver: 'cpu-direct' });
  const aId = mounted.props!.store.state.project!.id;
  const outputText = 'Exact A output å\r\n';
  const aFile = FileDelivery.parse(await window.fem.dispatch({ cmd: 'file.write', path: 'output-A.txt', text: outputText }));
  await window.fem.dispatch({ cmd: 'project.save' });
  const aUi = mounted.props!; const aConsole = window.fem;
  const aFiles = structuredClone(aUi.store.state.projectFiles);
  expect(aFiles).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'input', name: 'original-A.femlab.json' }), expect.objectContaining({ role: 'output', name: 'output-A.txt' })]));
  expect(aUi.store.state.folder?.name).toBe('A-only folder');
  const aResults = await window.fem.registry.query({ query: 'query.results' });
  expect(aResults).toMatchObject({ records: expect.arrayContaining([expect.objectContaining({ step: 'axial' })]) });
  emitIdentity('B');
  expect(aUi.store.state.exampleFilter).toEqual({ tag: null, difficulty: null });
  expect(aUi.store.state.model).toBeNull(); expect(aUi.store.state.result).toBeNull(); expect(aUi.store.state.project).toBeNull();
  expect(aUi.store.state.projectFiles).toEqual([]); expect(aUi.store.state.folder).toBeNull(); expect(aUi.store.state.projects).toEqual([]);
  await expect(aUi.dispatch({ cmd: 'file.download', id: aFile.id })).rejects.toMatchObject({ code: 'session.expired' });
  await expect(aConsole.query.model()).rejects.toMatchObject({ code: 'session.expired' });
  await vi.waitFor(() => { expect(mounted.props).not.toBe(aUi); expect(mounted.props!.store.state.account.uid).toBe('B'); expect(mounted.props!.store.state.ready).toBe(true); });
  expect(mounted.props!.store.state.exampleFilter).toEqual({ tag: null, difficulty: null });
  expect(location.hash).toBe('#/');
  expect(mounted.props!.store.state.projects).toEqual([]); expect(mounted.props!.store.state.projectFiles).toEqual([]);
  expect((await window.fem.query.model()).bodies).toEqual([]);
  expect(await window.fem.registry.query({ query: 'query.results' })).toMatchObject({ records: [] });
  const bProject = await window.fem.dispatch({ cmd: 'project.new', name: 'private B' }) as { id: string };
  await window.fem.dispatch({ cmd: 'folder.open', handle: fakeDir({}, 'B-only folder') });
  await window.fem.dispatch({ cmd: 'file.write', path: 'B-output.txt', text: 'B-only output' });
  await window.fem.dispatch({ cmd: 'project.save' });
  const bUi = mounted.props!;
  await window.fem.dispatch({ cmd: 'example.filter', query: 'private B', tag: 'thermal', difficulty: 2 });
  emitIdentity('A');
  expect(bUi.store.state.exampleFilter).toEqual({ tag: null, difficulty: null });
  expect(bUi.store.state.projectFiles).toEqual([]);
  await vi.waitFor(() => { expect(mounted.props).not.toBe(bUi); expect(mounted.props!.store.state.account.uid).toBe('A'); expect(mounted.props!.store.state.ready).toBe(true); expect(mounted.props!.store.state.projects.some(row => row.id === aId)).toBe(true); });
  expect(mounted.props!.store.state.projects.some(row => row.id === bProject.id)).toBe(false);
  expect(mounted.props!.store.state.projects.some(row => row.id === anonymous.id)).toBe(false);
  await window.fem.dispatch({ cmd: 'project.open', id: aId });
  expect((await window.fem.query.model()).bodies).toHaveLength(1);
  expect(await window.fem.registry.query({ query: 'query.results' })).toEqual(aResults);
  expect(mounted.props!.store.state.projectFiles).toEqual(aFiles);
  expect(mounted.props!.store.state.projectFiles.some(file => file.name === 'B-output.txt')).toBe(false);
  for (const [name, expectedBytes] of [['original-A.femlab.json', originalInput], ['output-A.txt', outputText]]) {
    const asset = mounted.props!.store.state.projectFiles.find(file => file.name === name)!;
    await window.fem.dispatch({ cmd: 'project.downloadAsset', id: asset.id });
    expect(await payloads.at(-1)!.text()).toBe(expectedBytes);
  }
  const beforeAba = mounted.props!; const oldAbaConsole = window.fem;
  await window.fem.dispatch({ cmd: 'example.filter', ...galleryFilter });
  emitIdentity('B'); emitIdentity('A');
  expect(beforeAba.store.state.exampleFilter).toEqual({ tag: null, difficulty: null });
  expect(beforeAba.store.state.projectFiles).toEqual([]); expect(beforeAba.store.state.model).toBeNull();
  await expect(oldAbaConsole.query.model()).rejects.toMatchObject({ code: 'session.expired' });
  await vi.waitFor(() => { expect(mounted.props).not.toBe(beforeAba); expect(mounted.props!.store.state.account.uid).toBe('A'); expect(mounted.props!.store.state.ready).toBe(true); });
  expect(mounted.props!.store.state.exampleFilter).toEqual({ tag: null, difficulty: null });
  expect(mounted.props!.store.state.projectFiles).toEqual([]); expect((await window.fem.query.model()).bodies).toEqual([]);
  expect(mounted.props!.store.state.projects.some(row => row.id === aId)).toBe(true);
  await window.fem.dispatch({ cmd: 'example.filter', ...galleryFilter });
  const beforeSignOut = mounted.props!; emitIdentity(null);
  expect(beforeSignOut.store.state.exampleFilter).toEqual({ tag: null, difficulty: null });
  expect(beforeSignOut.store.state.projects).toEqual([]);
  await vi.waitFor(() => { expect(mounted.props).not.toBe(beforeSignOut); expect(mounted.props!.store.state.account.uid).toBeNull(); expect(mounted.props!.store.state.ready).toBe(true); expect(mounted.props!.store.state.projects.some(row => row.id === anonymous.id)).toBe(true); });
  expect(mounted.props!.store.state.exampleFilter).toEqual({ tag: null, difficulty: null });
  expect(mounted.props!.store.state.projects.some(row => row.id === aId || row.id === bProject.id)).toBe(false);
  await window.fem.dispatch({ cmd: 'project.open', id: anonymous.id });
  expect((await window.fem.query.model()).bodies).toHaveLength(1);
  // An admitted download may outlive a document, but never an authentication epoch.
  emitIdentity('A');
  await vi.waitFor(() => { expect(mounted.props!.store.state.account.uid).toBe('A'); expect(mounted.props!.store.state.ready).toBe(true); });
  await window.fem.dispatch({ cmd: 'project.new', name: 'private delayed save' });
  const privateFacade = window.fem;
  const originalExport = SessionTransport.prototype.exportFile;
  let releaseExport!: () => void;
  const exportGate = new Promise<void>(resolve => { releaseExport = resolve; });
  let exportHeld = false;
  const exportSpy = vi.spyOn(SessionTransport.prototype, 'exportFile').mockImplementation(async function (this: SessionTransport) {
    const file = await originalExport.call(this);
    if (!exportHeld) { exportHeld = true; await exportGate; }
    return file;
  });
  const deliveredBeforeSwitch = payloads.length;
  const latePrivateSave = privateFacade.dispatch({ cmd: 'file.save', to: 'download' }).then(value => ({ value }), error => ({ error }));
  await vi.waitFor(() => expect(exportHeld).toBe(true));
  const heldUi = mounted.props!;
  emitIdentity('B');
  await vi.waitFor(() => { expect(mounted.props).not.toBe(heldUi); expect(mounted.props!.store.state.account.uid).toBe('B'); expect(mounted.props!.store.state.ready).toBe(true); });
  const bBeforeReturn = mounted.props!;
  emitIdentity('A');
  await vi.waitFor(() => { expect(mounted.props).not.toBe(bBeforeReturn); expect(mounted.props!.store.state.account.uid).toBe('A'); expect(mounted.props!.store.state.ready).toBe(true); });
  releaseExport();
  expect(await latePrivateSave).toMatchObject({ error: { code: 'session.expired' } });
  exportSpy.mockRestore();
  expect(payloads).toHaveLength(deliveredBeforeSwitch);
  expect(mounted.props!.store.state.projectFiles).toEqual([]);
  expect(mounted.props!.store.state.completedFilesVersion).toBe(0);
  expect((await window.fem.query.model()).bodies).toEqual([]);
  await expect(privateFacade.query.model()).rejects.toMatchObject({ code: 'session.expired' });
  emitIdentity(null);
  await vi.waitFor(() => { expect(mounted.props!.store.state.account.uid).toBeNull(); expect(mounted.props!.store.state.ready).toBe(true); });
  // Persisted history must receive checked entries, not already flattened commands. Exercise
  // the real host/storage/replacement path so a malformed autosave cannot hide behind mocks.
  await window.fem.dispatch({ cmd: 'file.autosave', on: true });
  await window.fem.dispatch({ cmd: 'project.new', name: 'typed history boundary' });
  const historySeed = await window.fem.query.journal();
  await window.fem.dispatch({ cmd: 'geometry.addBox', name: 'history_only_body', size: ['1 m', '2 m', '3 m'] });
  const historyLater = await window.fem.query.journal();
  const history = await window.fem.registry.query({ query: 'query.autosaveHistory' }) as { revisions: { id: string; name: string; commands: number }[] };
  const seedRow = history.revisions.find(row => row.name === 'typed history boundary' && row.commands === historySeed.entries.length)!;
  const laterRow = history.revisions.find(row => row.name === 'typed history boundary' && row.commands === historyLater.entries.length)!;
  expect(seedRow).toBeDefined(); expect(laterRow).toBeDefined();
  const persistedHistory = indexedDbStore(localDb);
  await vi.waitFor(async () => {
    const rows = await persistedHistory.read();
    expect(rows.find(row => row.id === seedRow.id)?.cmds).toEqual(historySeed.entries.map(entry => entry.cmd));
    expect(rows.find(row => row.id === laterRow.id)?.cmds).toEqual(historyLater.entries.map(entry => entry.cmd));
  });
  await window.fem.dispatch({ cmd: 'file.autosave', on: false });
  await window.fem.dispatch({ cmd: 'file.restore', id: seedRow.id });
  expect(await window.fem.query.journal()).toEqual(historySeed);
  expect((await window.fem.query.model()).bodies).toEqual([]);
  await window.fem.dispatch({ cmd: 'file.restore', id: laterRow.id });
  expect(await window.fem.query.journal()).toEqual(historyLater);
  expect((await window.fem.query.model()).bodies.map(body => body.name)).toEqual(['history_only_body']);
}, 30000);
