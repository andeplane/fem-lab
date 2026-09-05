import { vi } from 'vitest';
import type { Ack, ModelFile } from '../src/generated/engine';
import type { HostContext, ProjectInfo } from '../src/host-commands';
import type { EngineTransport } from '../src/transport';

export const ACK: Ack = { seq: 1, revision: 1, hash: 'h', warnings: [], output: { type: 'none' } };
export const MODEL_FILE = { format: 'femlab/1', engineVersion: '0', model: { name: 'beam' }, journal: { entries: [] } } as unknown as ModelFile;
export const PROJECT: ProjectInfo = { name: 'proj', files: [], agentsMd: 'AGENTS.md', skills: [] };

export function fakeTransport(): EngineTransport {
  return {
    dispatch: vi.fn(async () => ACK),
    query: vi.fn(async (q) => (q.query === 'query.script' ? { text: 'fem.model.new({ name: "beam" })' } : { gpu: false, threads: 1, engineVersion: '0', schemaVersion: '1' })),
    surface: vi.fn(),
    field: vi.fn(),
    export: vi.fn(async () => ({ filename: 'beam.vtu', mime: 'application/xml', bytes: new Uint8Array([1, 2]) })),
    exportFile: vi.fn(async () => MODEL_FILE),
    importFile: vi.fn(async () => ACK),
    cancel: vi.fn(async () => undefined),
  };
}

/** Every method records its call; `project.info()` is switched by `projectOpen`. */
export function fakeHost(transport = fakeTransport(), projectOpen = false): HostContext {
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
      screenshot: vi.fn(async () => ({ png: 'iVBOR' })),
    },
    selection: { set: vi.fn(), clear: vi.fn(), setPickTarget: vi.fn(), get: vi.fn(() => ({ bodies: ['beam'], faces: ['beam.top'], sets: [], refs: ['body:beam', 'face:beam.top'] })) },
    panels: { toggle: vi.fn() },
    script: { run: vi.fn(async () => ({ result: 1, console: [] })), stop: vi.fn(), setSource: vi.fn() },
    chat: { send: vi.fn(), insertMention: vi.fn(), clear: vi.fn() },
    skills: vi.fn(() => [{ name: 'beam-theory-check', description: 'Compare a cantilever with Euler–Bernoulli beam theory.', when: 'a beam', body: '# Steps', source: 'builtin' as const }]),
    clipboard: { writeText: vi.fn(async () => undefined) },
    files: { pick: vi.fn(async () => JSON.stringify(MODEL_FILE)), download: vi.fn(), shareLink: vi.fn(async () => ({ url: 'https://x/#j' })) },
    project: {
      open: vi.fn(async () => undefined),
      close: vi.fn(),
      refresh: vi.fn(async () => undefined),
      info: vi.fn(() => (projectOpen ? PROJECT : null)),
      readText: vi.fn(async (path: string) => (path === 'big.txt' ? 'x'.repeat(2 * 1024 * 1024 + 1) : path.endsWith('.json') ? JSON.stringify(MODEL_FILE) : `content of ${path}`)),
      writeText: vi.fn(async () => undefined),
      writeBytes: vi.fn(async () => undefined),
    },
    examples: { fetch: vi.fn(async () => JSON.stringify(MODEL_FILE)) },
    ai: { setKey: vi.fn(), setModel: vi.fn() },
    env: { webgpu: true, crossOriginIsolated: true, threads: 4, userAgent: 'test', engine: 'local' },
  };
}
