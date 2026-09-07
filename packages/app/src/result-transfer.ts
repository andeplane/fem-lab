// One transfer contract for schema-owned scientific Queries, including transient frames.
import type { BufferSpec, DifferenceField, FrameResult, Query, QueryResult, ResultField, ResultSurface, ResultSelector, Surface } from '@femlab/registry';
import { FemError } from '@femlab/registry';

export type BulkQuery = Extract<Query, { query: 'query.frame' | 'query.field' | 'query.difference' | 'query.surface' }>;
const TOPOLOGY = ['indices', 'triBody', 'triFace', 'triSetOffsets', 'triSets', 'edges', 'edgeFace', 'edgeBody'] as const;
type Topology = typeof TOPOLOGY[number];
export type SurfaceTransfer = Omit<ResultSurface, Topology | 'positions'> & Record<Topology, Uint32Array> & { positions: Float64Array };
export type FieldTransfer = Omit<ResultField, 'values'> & { values: Float64Array };
type DifferenceTransfer = Omit<DifferenceField, 'values'> & { values: Float64Array; valid: Uint8Array };
type FrameTransfer = Omit<FrameResult, 'values'> & { values: Float64Array };
type Transfer = SurfaceTransfer | FieldTransfer | DifferenceTransfer | FrameTransfer;
export interface QueryTransferEngine { query_transfer(json: string): unknown }
export interface Bulk { value: unknown; buffers: BufferSpec[]; raw: ArrayBuffer[] }

export function isBulkQuery(q: Query): q is BulkQuery {
  return q.query === 'query.frame' || q.query === 'query.field' || q.query === 'query.difference' || q.query === 'query.surface';
}

/** Rust allocates fresh JS arrays; the Worker transfers those staging buffers once. */
export function queryBulk(engine: QueryTransferEngine, q: BulkQuery): Bulk {
  const value = engine.query_transfer(JSON.stringify(q)) as Transfer;
  const names = q.query === 'query.surface' ? ['positions', ...TOPOLOGY]
    : q.query === 'query.difference' ? ['values', 'valid'] : ['values'];
  return bulkArrays(value, names);
}

function bulkArrays(value: object, names: readonly string[]): Bulk {
  const metadata = { ...value } as Record<string, unknown>;
  const arrays = names.map(name => {
    const view = metadata[name] as Float64Array | Float32Array | Uint32Array | Uint8Array;
    delete metadata[name];
    const dtype = view instanceof Float64Array ? 'f64' : view instanceof Float32Array ? 'f32' : view instanceof Uint32Array ? 'u32' : 'u8';
    return { name, dtype, view } as const;
  });
  return {
    value: metadata,
    buffers: arrays.map(({ name, dtype, view }) => ({ name, dtype, length: view.length })),
    raw: arrays.map(({ view }) => view.buffer as ArrayBuffer),
  };
}

/** The public Query API stays JSON-shaped and f64, with nulls restored from the wire mask. */
export function scientificQuery(q: BulkQuery, value: unknown): QueryResult {
  checkResultIdentity(q, value);
  if (q.query === 'query.difference') {
    const { values, valid, ...metadata } = value as DifferenceTransfer;
    if (valid.length !== values.length) throw new FemError('internal', 'difference validity mask has the wrong length', 'values');
    return { ...metadata, values: Array.from(values, (v, i) => valid[i] ? v : null) };
  }
  if (q.query === 'query.surface') {
    const surface = value as SurfaceTransfer;
    const topology = Object.fromEntries(TOPOLOGY.map(name => [name, Array.from(surface[name])])) as Record<Topology, number[]>;
    return { ...surface, ...topology, positions: Array.from(surface.positions) };
  }
  const field = value as FieldTransfer | FrameTransfer;
  return { ...field, values: Array.from(field.values) };
}

/** A reply for a different solve must never enter a cache under the requested identity. */
export function checkResultIdentity(q: BulkQuery, value: unknown): void {
  const check = (actual: unknown, requested: string | null | undefined) => {
    if (requested != null && actual !== requested) {
      throw new FemError('result.stale', `reply belongs to '${String(actual)}', expected '${requested}'`, 'resultId', 'retry the selected Result from query.results');
    }
  };
  if (q.query === 'query.difference') {
    const result = value as DifferenceField;
    check(result.left.resultId, q.left.resultId);
    check(result.right.resultId, q.right.resultId);
    check(result.comparisonResultId, q.onto === 'right' ? q.right.resultId : q.left.resultId);
  } else {
    const result = q.query === 'query.frame' ? (value as FrameResult).sample : value as ResultSurface | ResultField;
    check(result.resultId, q.resultId);
    check(result.step, q.step);
  }
}

/** Only renderer staging casts positions to f32; all scientific Queries remain f64. */
export function rendererSurface(data: SurfaceTransfer): Surface & { resultId: string; step: string; source: 'mesh' } {
  return { ...data, positions: Float32Array.from(data.positions), source: 'mesh' };
}

/** Component selection is layout staging, never a host-side physics reconstruction. */
export function rendererField(data: FieldTransfer, component?: number) {
  if (component !== undefined && (!Number.isInteger(component) || component < 0 || component >= data.components)) {
    throw new FemError('schema', `component must be between 0 and ${data.components - 1}`, 'component');
  }
  const source = component === undefined ? data.values : data.values.filter((_, i) => i % data.components === component);
  const values = Float32Array.from(source);
  let min = 0;
  let max = 0;
  values.forEach((v, i) => { if (i === 0 || v < min) min = v; if (i === 0 || v > max) max = v; });
  return { ...data, values, min, max, components: component === undefined ? data.components : 1 };
}

export function retainedSurfaceBulk(engine: QueryTransferEngine, selector: ResultSelector): Bulk {
  const data = engine.query_transfer(JSON.stringify({ query: 'query.surface', ...selector })) as SurfaceTransfer;
  return bulkArrays(rendererSurface(data), ['positions', ...TOPOLOGY]);
}

export type FieldRequest = Omit<Extract<Query, { query: 'query.field' }>, 'query'> & { component?: number };
export function retainedFieldBulk(engine: QueryTransferEngine, { component, ...selector }: FieldRequest): Bulk {
  const data = engine.query_transfer(JSON.stringify({ query: 'query.field', ...selector })) as FieldTransfer;
  return bulkArrays(rendererField(data, component), ['values']);
}
