/// <reference lib="webworker" />
// The only place the wasm Engine exists (plan B §5.3). One call in flight at a time; control
// travels as JSON strings, bulk data as transferred typed arrays. Views over wasm memory are
// `slice()`d the instant they are made and never escape unsliced (plan B risk R1).
import init, { Engine, version } from './generated/wasm/femlab_engine_wasm.js';
import wasmUrl from './generated/wasm/femlab_engine_wasm_bg.wasm?url';
import { siUnitOf } from './fields';
import type { AppReq, AppRes } from './protocol';
import { toStructured } from './protocol';

let engine: Engine | undefined;
/** Serialises the whole message loop: the engine is `&mut self` on every interesting call. */
let tail: Promise<unknown> = Promise.resolve();

interface Bulk {
  value: unknown;
  buffers: { name: string; dtype: 'f32' | 'u32' | 'u8'; length: number }[];
  raw: ArrayBuffer[];
}

function need(): Engine {
  if (!engine) throw { code: 'internal', cause: 'the engine Worker was used before create', where: 'create' };
  return engine;
}

async function create(payload: unknown): Promise<unknown> {
  await init({ module_or_path: wasmUrl });
  const { gpu, threads } = payload as { gpu: boolean; threads: number };
  engine = await Engine.create({ gpu, threads });
  return { engineVersion: version() };
}

/** `surface()` hands back views over wasm memory; copy each one and transfer the copies. */
function surface(): Bulk {
  const s = need().surface() as {
    positions: Float32Array;
    indices: Uint32Array;
    triSet: Uint32Array;
    triBody: Uint32Array;
    setNames: string[];
    membershipNames: string[];
    triSetOffsets: Uint32Array;
    triSets: Uint32Array;
    bodyNames: string[];
    source: string;
  };
  const arrays = [
    { name: 'positions', dtype: 'f32' as const, view: s.positions.slice() },
    { name: 'indices', dtype: 'u32' as const, view: s.indices.slice() },
    { name: 'triFace', dtype: 'u32' as const, view: s.triSet.slice() },
    { name: 'triBody', dtype: 'u32' as const, view: s.triBody.slice() },
    { name: 'triSetOffsets', dtype: 'u32' as const, view: s.triSetOffsets.slice() },
    { name: 'triSets', dtype: 'u32' as const, view: s.triSets.slice() },
  ];
  return {
    value: { faceNames: s.setNames, setNames: s.membershipNames, bodyNames: s.bodyNames, source: s.source },
    buffers: arrays.map((a) => ({ name: a.name, dtype: a.dtype, length: a.view.length })),
    raw: arrays.map((a) => a.view.buffer as ArrayBuffer),
  };
}

async function handle(req: AppReq, onProgress: (p: { phase: string; fraction: number; message: string }) => void): Promise<unknown | Bulk> {
  switch (req.op) {
    case 'create':
      return create(req.payload);
    case 'dispatch': {
      const json = await need().dispatch(JSON.stringify(req.payload), (phase: string, fraction: number, message: string) => {
        onProgress({ phase, fraction, message });
        return true;
      });
      return JSON.parse(json);
    }
    case 'query':
      return JSON.parse(need().query(JSON.stringify(req.payload)));
    case 'surface':
      return surface();
    case 'field': {
      const { step, field, component } = req.payload as { step?: string; field: string; component?: number };
      // `field()` already returns a fresh Float32Array (Rust built the f32 staging vector), so
      // there is no view over wasm memory to outlive here.
      const values = need().field(step, field, component);
      let min = 0;
      let max = 0;
      for (let i = 0; i < values.length; i++) {
        const v = values[i]!;
        if (i === 0 || v < min) min = v;
        if (i === 0 || v > max) max = v;
      }
      return {
        value: { min, max, unit: siUnitOf(field as never) },
        buffers: [{ name: 'values', dtype: 'f32' as const, length: values.length }],
        raw: [values.buffer as ArrayBuffer],
      };
    }
    case 'export': {
      // `mesh.export` is an engine Command, so an export is journaled like everything else;
      // the host re-reads the Journal afterwards (main.tsx).
      const { format, step } = req.payload as { format: string; step?: string };
      const json = await need().dispatch(JSON.stringify({ cmd: 'mesh.export', format, ...(step === undefined ? {} : { step }) }), undefined);
      const { output } = JSON.parse(json) as { output: { filename: string; mime: string; text: string } };
      return { filename: output.filename, mime: output.mime, bytes: new TextEncoder().encode(output.text) };
    }
    case 'exportFile':
      return JSON.parse(need().export_file());
    case 'importFile':
      need().import_file(JSON.stringify(req.payload));
      return { seq: -1, revision: need().revision(), hash: need().model_hash(), warnings: [], output: { kind: 'none' } };
    case 'replay': {
      // Cancel-by-replay: a fresh Engine, then the Journal up to the last acknowledged revision.
      const { entries, gpu, threads } = req.payload as { entries: unknown[]; gpu: boolean; threads: number };
      engine = await Engine.create({ gpu, threads });
      await engine.replay_hashes(JSON.stringify(entries), true, false);
      return { revision: engine.revision(), hash: engine.model_hash() };
    }
    case 'gpuSelfTest':
      return need().gpu_self_test((req.payload as { n: number }).n);
    default:
      throw { code: 'unsupported', cause: `the engine Worker has no '${req.op}' op`, where: req.op, suggestion: `known ops: create, dispatch, query, surface, field, export, exportFile, importFile, replay` };
  }
}

self.onmessage = (e: MessageEvent<AppReq>) => {
  const req = e.data;
  const post = (res: AppRes, transfer: Transferable[] = []) => self.postMessage(res, transfer);
  tail = tail.then(
    () =>
      handle(req, (progress) => post({ id: req.id, progress })).then(
        (value) => {
          const bulk = value as Bulk | null;
          if (bulk && typeof bulk === 'object' && Array.isArray((bulk as Bulk).raw)) {
            post({ id: req.id, ok: true, value: bulk.value, buffers: bulk.buffers, raw: bulk.raw }, bulk.raw);
          } else {
            post({ id: req.id, ok: true, value });
          }
        },
        (err) => post({ id: req.id, ok: false, error: toStructured(err) }),
      ),
    () => undefined,
  );
};
