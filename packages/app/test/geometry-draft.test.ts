import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
import type { Command, EngineSchema, JsonSchema, ShapeSpec, SketchSpec } from '@femlab/registry';
import schema from '../../registry/src/generated/runtime-schema';
import { GeometryDraft, geometryDraftRenderer, type DraftRenderer, type DraftView } from '../src/geometry-draft';
import { Store } from '../src/store';
import { defaultFormValues, fieldsOf } from '../src/ui/schema';
import { SessionRuntime } from '../src/session-runtime';
import type { SessionRequest, SessionResponse } from '../src/session-protocol';
import type { AppSurface } from '../src/surface';
const wasm = createRequire(import.meta.url)('../../../tools/wasm-node/femlab_engine_wasm.js') as typeof import('../src/generated/wasm/femlab_engine_wasm');
class EngineWorker {
  onmessage: ((event: MessageEvent<SessionResponse>) => void) | null = null;
  onerror = null;
  terminated = false;
  runtime = new SessionRuntime(async (options, epoch) => new wasm.SessionEngine(options.threads, epoch), (ticket, options) => wasm.PreparedEngine.create(ticket, options), () => 0);
  postMessage(request: SessionRequest) { void this.runtime.accept(request, response => { if (!this.terminated) this.onmessage?.({ data: response } as MessageEvent<SessionResponse>); }); }
  terminate() { this.terminated = true; }
}
const box: Command = { cmd: 'geometry.addBox', name: 'draft', size: ['1 m', '100 mm', '100 mm'] };
const sketch: SketchSpec = { outer: [{ kind: 'line', to: ['0 m', '0 m'] }, { kind: 'line', to: ['1 m', '0 m'] }, { kind: 'line', to: ['1 m', '1 m'] }, { kind: 'line', to: ['0 m', '1 m'] }], holes: [] };
const shapeBox: ShapeSpec = { kind: 'box', size: ['1 m', '1 m', '1 m'] };
const shapes: ShapeSpec[] = [
  shapeBox, { kind: 'cylinder', radius: '0.5 m', height: '2 m' }, { kind: 'sphere', radius: '0.5 m' },
  { kind: 'extrude', sketch, height: '1 m' },
  { kind: 'revolve', sketch: { outer: [{ kind: 'line', to: ['1 m', '0 m'] }, { kind: 'line', to: ['2 m', '0 m'] }, { kind: 'line', to: ['2 m', '1 m'] }, { kind: 'line', to: ['1 m', '1 m'] }] }, angle: 180, segments: 12 },
  { kind: 'union', shapes: [shapeBox, { ...shapeBox, at: ['0.5 m', '0 m', '0 m'] }] },
  { kind: 'subtract', from: shapeBox, cut: [{ ...shapeBox, at: ['0.5 m', '0.5 m', '0.5 m'] }] },
  { kind: 'intersect', shapes: [shapeBox, { ...shapeBox, at: ['0.5 m', '0.5 m', '0.5 m'] }] },
  { kind: 'transform', shape: shapeBox, at: { translate: ['5 m', '7 m', '2 m'], rotate: [0, 0, 90] } },
];
afterEach(() => vi.useRealTimers());
function renderer() {
  let epoch = 0; const workers: EngineWorker[] = [];
  return { workers, renderer: geometryDraftRenderer(() => { const worker = new EngineWorker(); workers.push(worker); return worker as unknown as Worker; }, () => `draft-${++epoch}`) };
}
it('uses real engine shapes in an isolated CPU session, replacing drafts without accumulating bodies', async () => {
  const { renderer: render, workers } = renderer();
  try {
    const block = await render.render([{ cmd: 'model.new', name: 'preview' }, box]);
    expect(block.bodyNames).toEqual(['draft']);
    expect(Math.max(...block.positions.filter((_, i) => i % 3 === 0))).toBe(1);
    for (const shape of shapes) {
      const result = await render.render([{ cmd: 'model.new', name: 'preview' }, { cmd: 'geometry.add', name: 'other', shape } as Command]);
      expect(result.bodyNames).toEqual(['other']);
      expect(result.positions.length).toBeGreaterThan(0); expect(result.indices.length).toBeGreaterThan(0);
    }
    expect(workers).toHaveLength(1);
    const sheet = await render.render([{ cmd: 'model.new', name: 'sheet' }, { cmd: 'model.setIdealisation', idealisation: { kind: 'planeStrain' } }, { cmd: 'geometry.add', name: 'sheet', shape: { kind: 'sheet', sketch } } as Command]);
    expect(sheet.edges?.length).toBeGreaterThan(0);
    await expect(render.render([{ cmd: 'model.new', name: 'invalid' }, { ...box, size: ['-1 m', '1 m', '1 m'] }])).rejects.toMatchObject({ code: 'schema' });
  } finally { render.clear(); }
  expect(workers.every(worker => worker.terminated)).toBe(true);
});
const empty: AppSurface = { source: 'geometry', positions: new Float32Array(), indices: new Uint32Array(), triBody: new Uint32Array(), triFace: new Uint32Array(), bodyNames: [], faceNames: [] };
function setup(render: DraftRenderer = { render: vi.fn(async () => empty), clear: vi.fn() }) {
  vi.useFakeTimers(); const store = new Store(); const view: DraftView = { setGeometryDraft: vi.fn() };
  const metadata = schema as unknown as EngineSchema;
  const draft = new GeometryDraft(store, render, () => view, { schedule: (fn, ms) => setTimeout(fn, ms), cancel: id => clearTimeout(id as ReturnType<typeof setTimeout>) }, form => {
    const variant = metadata.commands.oneOf.find(variant => variant.properties['cmd']?.const === form.cmd)!;
    return defaultFormValues(form.values, fieldsOf(variant as JsonSchema, metadata.commands.$defs ?? {}));
  });
  return { store, view, draft, render };
}
it('debounces form.open, applies actual form defaults and never changes the active Journal or revision', async () => {
  const { store, draft, render } = setup(); const before = structuredClone({ journal: store.state.journal, revision: store.state.revision, model: store.state.model });
  store.openForm('geometry.addBox', box); store.openForm('geometry.addBox', { ...box, name: 'placed', at: ['5 m', '2 m', '1 m'] }, true);
  await vi.advanceTimersByTimeAsync(179); expect(render.render).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(render.render).toHaveBeenCalledOnce();
  expect(render.render).toHaveBeenCalledWith([{ cmd: 'model.new', name: 'Uncommitted geometry preview' }, { cmd: 'geometry.addBox', name: 'placed', at: ['5 m', '2 m', '1 m'], size: ['1 m', '100 mm', '100 mm'] }]);
  expect(store.state.geometryDraft.status).toBe('ready');
  expect({ journal: store.state.journal, revision: store.state.revision, model: store.state.model }).toEqual(before);
  draft.dispose();
});
it('clears on commit, selection, form/view changes and disposal, and ignores late ready/error replies', async () => {
  let accept!: (surface: AppSurface) => void;
  const { store, draft, render, view } = setup({ render: vi.fn(() => new Promise<AppSurface>(resolve => { accept = resolve; })), clear: vi.fn() });
  store.openForm('geometry.addBox', box); await vi.advanceTimersByTimeAsync(180);
  store.set({ revision: 1 }); accept(empty); await vi.advanceTimersByTimeAsync(0);
  expect(store.state.geometryDraft.status).toBe('idle'); expect(view.setGeometryDraft).toHaveBeenLastCalledWith(null);
  for (const clear of [() => store.set({ selection: { refs: [], bodies: ['chosen'], faces: [], sets: [] } }), () => store.openForm('material.add'), () => store.set({ viewMode: 'mesh' })]) {
    store.set({ viewMode: 'geometry' }); store.openForm('geometry.addBox', box); await vi.advanceTimersByTimeAsync(180); clear();
    expect(store.state.geometryDraft.status).toBe('idle');
  }
  draft.dispose(); expect(render.clear).toHaveBeenCalled();
});
it('rejects invalid drafts without retaining old geometry and bounds a stalled worker', async () => {
  const { store, draft, view } = setup({ render: vi.fn(async () => { throw { code: 'unit.dimension', cause: 'Expected length', where: 'size.0', suggestion: 'Use m' }; }), clear: vi.fn() });
  store.openForm('geometry.addBox', box); await vi.advanceTimersByTimeAsync(180);
  expect(store.state.geometryDraft).toMatchObject({ status: 'error', error: { code: 'unit.dimension', where: 'size.0' } });
  expect(view.setGeometryDraft).toHaveBeenLastCalledWith(null); draft.dispose();
  const stalled = setup({ render: vi.fn(() => new Promise<AppSurface>(() => undefined)), clear: vi.fn() });
  stalled.store.openForm('geometry.addBox', box); await vi.advanceTimersByTimeAsync(5180);
  expect(stalled.store.state.geometryDraft).toMatchObject({ status: 'error', error: { code: 'unsupported', where: 'shape' } });
  expect(stalled.render.clear).toHaveBeenCalled(); stalled.draft.dispose();
});
