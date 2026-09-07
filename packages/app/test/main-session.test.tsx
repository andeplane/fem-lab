import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
import type { ComponentProps, VNode } from 'preact';
import type { App } from '../src/ui/App';
import type { SessionRequest, SessionResponse } from '../src/session-protocol';
import { SessionRuntime } from '../src/session-runtime';

const mounted = vi.hoisted(() => ({ props: null as ComponentProps<typeof App> | null }));
vi.mock('preact', async original => ({ ...await original<typeof import('preact')>(), render: (node: VNode<ComponentProps<typeof App>>) => { mounted.props = node.props; } }));
vi.mock('../src/ui/App', () => ({ App: () => null }));
const wasm = createRequire(import.meta.url)('../../../tools/wasm-node/femlab_engine_wasm.js') as typeof import('../src/generated/wasm/femlab_engine_wasm.js');
const workers: LocalWorker[] = [];
class LocalWorker {
  onmessage: ((event: MessageEvent<SessionResponse>) => void) | null = null;
  onerror = null;
  private owner: InstanceType<typeof wasm.SessionEngine> | undefined;
  private closed = false;
  private runtime = new SessionRuntime(async (_options, epoch) => this.owner = new wasm.SessionEngine(1, epoch), wasm.PreparedEngine.create);
  constructor() { workers.push(this); }
  postMessage(request: SessionRequest) {
    void this.runtime.accept(structuredClone(request), (reply, raw = []) => {
      if (!this.closed) this.onmessage?.({ data: structuredClone(reply, { transfer: raw }) } as MessageEvent<SessionResponse>);
    });
  }
  terminate() { if (!this.closed) { this.closed = true; this.owner?.free(); } }
}
afterEach(() => { for (const worker of workers) worker.terminate(); vi.unstubAllGlobals(); localStorage.clear(); });

it('boots the real session host, saves and reopens projects, and revokes retained console and UI handles', async () => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.setItem('femlab.autosave', 'off');
  vi.stubGlobal('Worker', LocalWorker);
  await import('../src/main');
  await vi.waitFor(() => expect(mounted.props?.store.state.ready).toBe(true));
  const initial = window.fem;
  const originalUi = mounted.props!;
  expect((await initial.query.model()).name).toBeTruthy();
  expect(initial.registry.list().commands.length).toBeGreaterThan(50);
  const first = await initial.dispatch({ cmd: 'project.new', name: 'first' }) as { id: string };
  await initial.dispatch({ cmd: 'geometry.addBox', name: 'body', size: ['1 m', '1 m', '1 m'] });
  const saved = await initial.dispatch({ cmd: 'project.save' }) as { commands: number };
  expect(saved.commands).toBe(2);
  await initial.dispatch({ cmd: 'project.rename', id: first.id, name: 'renamed' });
  expect(mounted.props!.store.state.project?.name).toBe('renamed');
  await expect(originalUi.query({ query: 'query.model' })).rejects.toMatchObject({ code: 'session.expired' });
  const firstUi = mounted.props!;
  await firstUi.dispatch({ cmd: 'view.setMode', mode: 'mesh' });
  expect(firstUi.store.state.viewMode).toBe('mesh');
  await firstUi.dispatch({ cmd: 'model.setName', name: 'first edited' });
  expect(firstUi.store.state.model?.name).toBe('first edited');
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
  await window.fem.dispatch({ cmd: 'project.delete', id: second.id });
  await window.fem.dispatch({ cmd: 'project.delete', id: first.id });
  expect(mounted.props!.store.state.projects).toEqual([]);
  await window.fem.dispatch({ cmd: 'model.setName', name: 'deleted stays deleted' });
  expect(await window.fem.dispatch({ cmd: 'project.save' })).toBeNull();
  expect(mounted.props!.store.state.projects).toEqual([]);
}, 30000);
