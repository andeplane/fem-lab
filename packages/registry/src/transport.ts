import type { Ack, Command, EngineError, Field, ModelFile, Query, QueryResult } from './generated/engine';
import { FemError } from './error';

export interface Progress {
  phase: string;
  fraction?: number;
  message?: string;
}
export interface Surface {
  positions: Float32Array;
  indices: Uint32Array;
  triBody: Uint32Array;
  triFace: Uint32Array;
  /** Optional tagged Sheet boundary edges. Mesh edges index original nodes in `positions`. */
  edges?: Uint32Array;
  edgeFace?: Uint32Array;
  edgeBody?: Uint32Array;
  faceNames: string[];
  /** All face-Set memberships, CSR by original surface triangle; includes named predicate Sets. */
  setNames?: string[];
  triSetOffsets?: Uint32Array;
  triSets?: Uint32Array;
  bodyNames: string[];
}
export interface FieldData {
  values: Float32Array;
  min: number;
  max: number;
  unit: string;
}
/** What `file.export` sends the engine; the engine's `export` schema owns the formats. */
export interface ExportSpec {
  format: string;
  [k: string]: unknown;
}
export interface ExportedFile {
  filename: string;
  mime: string;
  bytes: Uint8Array;
}

/**
 * The only way anything above it reaches the engine. A Worker implements it in the browser, a
 * WebSocket client for `femlab serve`; the app never learns which.
 */
export interface EngineTransport {
  /** Rejects with a structured `EngineError`, never a bare string. */
  dispatch(cmd: Command, onProgress?: (p: Progress) => void): Promise<Ack>;
  query(q: Query): Promise<QueryResult>;
  surface(): Promise<Surface>;
  field(step: string, field: Field, component?: number): Promise<FieldData>;
  export(spec: ExportSpec): Promise<ExportedFile>;
  exportFile(): Promise<ModelFile>;
  importFile(file: ModelFile): Promise<Ack>;
  cancel(): Promise<void>;
}

/** Wire protocol shared by the Worker transport now and the WebSocket transport later. */
export type Op = 'dispatch' | 'query' | 'surface' | 'field' | 'export' | 'exportFile' | 'importFile' | 'cancel';
export interface Req {
  id: number;
  op: Op;
  payload: unknown;
}
export type Dtype = 'f32' | 'u32' | 'u8';
export interface BufferSpec {
  name: string;
  dtype: Dtype;
  length: number;
}
export type Res =
  | { id: number; ok: true; value: unknown; buffers?: BufferSpec[] }
  | { id: number; ok: false; error: EngineError }
  | { id: number; progress: Progress };

const VIEW = { f32: Float32Array, u32: Uint32Array, u8: Uint8Array } as const;

/**
 * A bulk reply is a JSON header whose `buffers` list names, dtypes and lengths, followed by the
 * raw buffers in that order (Worker transferables or WebSocket binary frames). Returns the
 * header's `value` with each buffer attached under its name as a typed array.
 */
export function decodeBulk(header: { value: unknown; buffers?: BufferSpec[] }, buffers: ArrayBuffer[]): Record<string, unknown> {
  const specs = header.buffers ?? [];
  if (specs.length !== buffers.length) {
    throw new FemError('internal', `bulk reply lists ${specs.length} buffers but ${buffers.length} arrived`, 'buffers');
  }
  const out: Record<string, unknown> = { ...(header.value as Record<string, unknown>) };
  specs.forEach((spec, i) => {
    const View = VIEW[spec.dtype];
    const buf = buffers[i]!;
    if (buf.byteLength !== spec.length * View.BYTES_PER_ELEMENT) {
      throw new FemError('internal', `buffer '${spec.name}' has ${buf.byteLength} bytes, expected ${spec.length} × ${spec.dtype}`, spec.name);
    }
    out[spec.name] = new View(buf);
  });
  return out;
}
