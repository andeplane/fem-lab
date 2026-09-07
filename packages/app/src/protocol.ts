// The wire between `worker-transport.ts` and `engine.worker.ts`: the registry's `Req`/`Res`
// widened by the three ops only a wasm engine in a Worker has (`create`, `replay` for
// cancel-by-replay, `gpuSelfTest` for the CI smoke).
import type { BufferSpec, EngineError, Op, Progress } from '@femlab/registry';

export type AppOp = Op | 'create' | 'replay' | 'gpuSelfTest';

export interface AppReq {
  id: number;
  op: AppOp;
  payload: unknown;
}

/** A bulk reply carries its buffers in `raw`, transferred; `buffers` is their header. */
export type AppRes =
  | { id: number; ok: true; value: unknown; buffers?: BufferSpec[]; raw?: ArrayBuffer[] }
  | { id: number; ok: false; error: EngineError }
  | { id: number; progress: Progress };

const CODES = new Set([
  'session.expired', 'session.conflict', 'session.transitioning', 'operation.reused', 'operation.unknown',
  'schema', 'unit.dimension', 'unit.unknown', 'name.taken', 'not-found', 'in-use', 'set.empty',
  'unsupported', 'cancelled', 'internal', 'file.scope', 'file.not-found', 'export.unavailable',
  'material.props', 'mesh.inverted', 'mesh.failed', 'model.no-material', 'model.ill-posed',
  'constraint.conflict', 'constraint.rigid-modes', 'solve.not-positive-definite', 'solve.stalled',
  'solve.too-large', 'gpu.shader', 'gpu.too-large', 'explicit.unstable', 'result.stale',
]);

/**
 * wasm-bindgen throws the engine's structured `Error` object; everything else (a DOM exception,
 * a bug in this file) arrives as a JS `Error` and becomes `internal`.
 */
export function toStructured(e: unknown): EngineError {
  const o = e as Partial<EngineError> | null;
  if (o && typeof o === 'object' && typeof o.code === 'string' && CODES.has(o.code) && typeof o.cause === 'string') {
    return { code: o.code, cause: o.cause, where: o.where ?? null, suggestion: o.suggestion ?? null };
  }
  return { code: 'internal', cause: e instanceof Error ? e.message : String(e), where: null, suggestion: null };
}
