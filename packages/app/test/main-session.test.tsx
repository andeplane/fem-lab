import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
import type { ComponentProps, VNode } from 'preact';
import type { App } from '../src/ui/App';
import type { Progress } from '@femlab/registry';
import type { Viewer, CameraState } from '../src/viewer/viewer';
import type { SessionRequest, SessionResponse } from '../src/session-protocol';
import { SessionRuntime } from '../src/session-runtime';

const mounted = vi.hoisted(() => ({ props: null as ComponentProps<typeof App> | null, makeViewer: null as ((props: ComponentProps<typeof App>) => Viewer) | null, afterReady: null as ((viewer: Viewer) => void) | null }));
vi.mock('preact', async original => ({ ...await original<typeof import('preact')>(), render: (node: VNode<ComponentProps<typeof App>>) => {
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
    setSurface: surface, setField: vi.fn(), setDeformed: vi.fn(), setDim: vi.fn(), setMode: vi.fn(), animate: vi.fn(),
    getCamera: () => structuredClone(camera), setCamera: (next: CameraState) => { camera = structuredClone(next); },
    fit: vi.fn(() => {
      expect(surface.mock.lastCall?.[0].positions.length).toBeGreaterThan(0);
      camera = { position: [1.5,1.5,1.5], target: [0.5,0.5,0.5], up: [0,0,1] };
    }),
  } satisfies Pick<Viewer, 'hasSurface' | 'setSurface' | 'setField' | 'setDeformed' | 'setDim' | 'setMode' | 'animate' | 'getCamera' | 'setCamera' | 'fit'>;
  return viewer;
}

it('boots the real session host, saves and reopens projects, and revokes retained console and UI handles', async () => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.setItem('femlab.autosave', 'off');
  const drawings: ReturnType<typeof drawing>[] = [];
  mounted.makeViewer = props => { const next = drawing(() => props.viewer.onBounds?.()); drawings.push(next); return next as unknown as Viewer; };
  vi.stubGlobal('Worker', LocalWorker);
  const appHost = await import('../src/main');
  await vi.waitFor(() => expect(mounted.props?.store.state.ready).toBe(true));
  const initial = window.fem;
  const originalUi = mounted.props!;
  expect((await initial.query.model()).name).toBeTruthy();
  expect(initial.registry.list().commands.length).toBeGreaterThan(50);
  const first = await initial.dispatch({ cmd: 'project.new', name: 'first' }) as { id: string };
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
  const beforeLogin = await window.fem.query.journal();
  await appHost.prepareAccountNavigation();
  expect(sessionStorage.getItem('femlab.accountReturnProject')).toBe(first.id);
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
  await expect(initial.query.model()).rejects.toMatchObject({ code: 'session.expired' });
  await expect(initial.dispatch({ cmd: 'geometry.remove', name: 'body' })).rejects.toMatchObject({ code: 'session.expired' });
  expect((await window.fem.query.model()).bodies).toHaveLength(0);
  await window.fem.dispatch({ cmd: 'project.open', id: first.id });
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
}, 30000);
