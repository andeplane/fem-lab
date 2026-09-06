import { vi } from 'vitest';
import type { Ack, ModelFile, PathResult, ResultSummary } from '../src/generated/engine';
import type { FolderInfo, HostContext, OpenProject, ProjectMeta } from '../src/host-commands';
import type { EngineTransport } from '../src/transport';

export const ACK: Ack = { seq: 1, revision: 1, hash: 'h', warnings: [], output: { type: 'none' } };
export const MODEL_FILE = { format: 'femlab/1', engineVersion: '0', model: { name: 'beam' }, journal: { entries: [] } } as unknown as ModelFile;
export const FOLDER: FolderInfo = { name: 'proj', files: [], agentsMd: 'AGENTS.md', skills: [] };
export const PROJECT: ProjectMeta = { id: 'p1', name: 'beam', at: 1_700_000_000_000, createdAt: 1_700_000_000_000, commands: 9, hash: 'h', thumbnail: null };

export const SAVED = { name: 'beam', at: 1_700_000_000_000, commands: 9 };
export const AUTOSAVES = [
  { id: 'newest', name: 'beam', at: 1_700_000_000_000, commands: 9 },
  { id: 'older', name: 'beam', at: 1_699_999_000_000, commands: 7 },
];

const kN = (value: number) => ({ value, unit: 'kN' });
const mm = (value: number) => ({ value, unit: 'mm' });

export const RESULT: ResultSummary = {
  reactionQuantity: 'force',
  step: 'static',
  revision: 10,
  stale: false,
  solver: 'cpu-direct',
  iterations: 1,
  residual: 0,
  timeMs: 12,
  extremes: [{ field: 'displacement', component: 2, min: mm(-0.19), minAt: [mm(1000), mm(50), mm(50)], max: mm(0), maxAt: [mm(0), mm(0), mm(0)] }],
  reactions: [{ constraint: 'root', total: [kN(0), kN(0), kN(1)] }],
  appliedTotal: [kN(0), kN(0), kN(-1)],
  balance: 0,
};
export const PATH: PathResult = { s: [0, 0.5, 1], values: [0, null, 2], unit: 'MPa' };

/** One reply per Query the host Commands read; everything else is the capabilities blob. */
const REPLIES: Record<string, unknown> = {
  'query.script': { text: 'fem.model.new({ name: "beam" })' },
  'query.model': { name: 'beam', revision: 10, meshSettings: {}, warnings: [] },
  'query.result': RESULT,
  'query.path': PATH,
};

export function fakeTransport(): EngineTransport {
  return {
    dispatch: vi.fn(async () => ACK),
    query: vi.fn(async (q) => (REPLIES[q.query] ?? { gpu: false, threads: 1, engineVersion: '0', schemaVersion: '1' }) as never),
    surface: vi.fn(),
    field: vi.fn(),
    export: vi.fn(async () => ({ filename: 'beam.vtu', mime: 'application/xml', bytes: new Uint8Array([1, 2]) })),
    exportFile: vi.fn(async () => MODEL_FILE),
    importFile: vi.fn(async () => ({ ...ACK, journal: MODEL_FILE.journal })),
    cancel: vi.fn(async () => undefined),
  };
}

/** Every method records its call; `folder.info()` is switched by `folderOpen`. */
export function fakeHost(transport = fakeTransport(), folderOpen = false): HostContext {
  // The background save is on by default, as in the app; turning it off keeps what is saved.
  let autosaveOn = true;
  // One project, opened or not, so `query.project` has both answers and rename/delete are seen.
  let open: ProjectMeta | null = PROJECT;
  const current = (): OpenProject | null => (open === null ? null : { ...open, saving: false, autosave: autosaveOn });
  return {
    transport,
    view: {
      fit: vi.fn(),
      setCamera: vi.fn(),
      preset: vi.fn(),
      setProjection: vi.fn(),
      showField: vi.fn(),
      setLegend: vi.fn(),
      setDeformScale: vi.fn(),
      setClip: vi.fn(),
      toggle: vi.fn(),
      setVisible: vi.fn(),
      setTheme: vi.fn(),
      animate: vi.fn(),
      camera: vi.fn(() => ({ position: [1, 2, 3] as [number, number, number], target: [0, 0, 0] as [number, number, number] })),
      screenshot: vi.fn(async () => ({ png: 'data:image/png;base64,QUJD' })),
    },
    selection: { set: vi.fn(), clear: vi.fn(), setPickTarget: vi.fn(), get: vi.fn(() => ({ bodies: ['beam'], faces: ['beam.top'], sets: [], refs: ['body:beam', 'face:beam.top'] })) },
    panels: { toggle: vi.fn(), resize: vi.fn() },
    script: { validate: vi.fn(async () => ({ ok: true, diagnostics: [] })), run: vi.fn(async () => ({ result: 1, console: [] })), stop: vi.fn(), setSource: vi.fn() },
    chat: { send: vi.fn(), insertMention: vi.fn(), setDraft: vi.fn(), clear: vi.fn() },
    skills: vi.fn(() => [{ name: 'beam-theory-check', description: 'Compare a cantilever with Euler–Bernoulli beam theory.', when: 'a beam', body: '# Steps', source: 'builtin' as const }]),
    clipboard: { writeText: vi.fn(async () => undefined) },
    files: {
      pick: vi.fn(async () => JSON.stringify(MODEL_FILE)),
      download: vi.fn(),
      markSaved: vi.fn(),
      shareLink: vi.fn(async () => ({ url: 'https://x/#j' })),
      restore: vi.fn(async (id?: string) => id === undefined ? SAVED : AUTOSAVES.find(x => x.id === id) ?? null),
      autosave: vi.fn(() => ({ enabled: autosaveOn, saved: SAVED })),
      autosaves: vi.fn(() => AUTOSAVES),
      setAutosave: vi.fn((on: boolean) => {
        autosaveOn = on;
      }),
    },
    projects: {
      new: vi.fn(async (name?: string) => {
        open = { ...PROJECT, id: 'p2', name: name ?? 'model', commands: 0 };
        return open;
      }),
      open: vi.fn(async (id: string) => {
        open = { ...PROJECT, id };
        return open;
      }),
      rename: vi.fn(async (id: string | undefined, name: string) => {
        open = { ...PROJECT, id: id ?? PROJECT.id, name };
        return open;
      }),
      delete: vi.fn(async (id: string) => {
        if (open?.id === id) open = null;
      }),
      save: vi.fn(async () => {
        const project = current();
        return project === null ? null : { ...project, journal: MODEL_FILE.journal };
      }),
      list: vi.fn(() => (open === null ? [] : [open])),
      current: vi.fn(current),
    },
    folder: {
      open: vi.fn(async () => undefined),
      close: vi.fn(),
      refresh: vi.fn(async () => undefined),
      info: vi.fn(() => (folderOpen ? FOLDER : null)),
      readText: vi.fn(async (path: string) => (path === 'big.txt' ? 'x'.repeat(2 * 1024 * 1024 + 1) : path.endsWith('.json') ? JSON.stringify(MODEL_FILE) : `content of ${path}`)),
      writeText: vi.fn(async () => undefined),
      writeBytes: vi.fn(async () => undefined),
    },
    examples: { fetch: vi.fn(async () => JSON.stringify(MODEL_FILE)) },
    ai: { setKey: vi.fn(), setModel: vi.fn() },
    env: { webgpu: true, crossOriginIsolated: true, threads: 4, userAgent: 'test', engine: 'local' },
  };
}
