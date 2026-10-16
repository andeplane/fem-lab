import { FemError, scientificJson } from '@femlab/registry';

export interface ProjectAsset {
  id: string;
  role: 'input' | 'output';
  name: string;
  mime: string;
  data: Uint8Array;
}
export interface ProjectArtifact {
  name: string;
  createdAt: number;
  engine: unknown;
  files: ProjectAsset[];
}
export const PROJECT_BUNDLE_FORMAT = 'femlab-project-bundle/1';
export const MAX_PROJECT_ARTIFACT_BYTES = 128 * 1024 * 1024;
export const MAX_PROJECT_ENGINE_BYTES = 64 * 1024 * 1024;
export const MAX_PROJECT_ASSET_BYTES = 32 * 1024 * 1024;
export const MAX_PROJECT_ASSETS = 256;
export const MAX_PROJECT_MANIFEST_BYTES = 1024 * 1024;
const utf8 = new TextEncoder();
// Count before allocating encoded content; lone UTF-16 surrogates become U+FFFD like TextEncoder.
function utf8Length(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++; }
    else bytes += 3;
  }
  return bytes;
}
const magic = utf8.encode(PROJECT_BUNDLE_FORMAT + '\n');
const headerBytes = magic.byteLength + 4;
const bad = (cause: string): FemError => new FemError('schema', cause, 'project bundle', 'open a valid FEM Lab project bundle');
const limit = (cause: string): FemError => new FemError('unsupported', cause, 'project bundle', 'use fewer or smaller project files');
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, names: string[]): boolean => Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const text = (value: unknown, max: number, empty = false): value is string => typeof value === 'string' && (empty || value.length > 0) && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) && utf8.encode(value).byteLength <= max;
const size = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const cloneAsset = (asset: ProjectAsset): ProjectAsset => ({ ...asset, data: asset.data.slice() });

interface AssetRange { id: string; role: 'input' | 'output'; name: string; mime: string; offset: number; length: number }
interface Manifest { format: string; name: string; createdAt: number; engineBytes: number; files: AssetRange[] }

function metadata(id: unknown, role: unknown, name: unknown, mime: unknown): Pick<ProjectAsset, 'id' | 'role' | 'name' | 'mime'> {
  if (!text(id, 256) || role !== 'input' && role !== 'output' || !text(name, 4096) || !text(mime, 256, true)) throw bad('invalid project file metadata');
  return { id, role, name, mime };
}
function artifactMetadata(name: unknown, createdAt: unknown): void {
  if (!text(name, 4096) || !size(createdAt)) throw bad('invalid project name or creation time');
}
function layout(name: string, createdAt: number, engineBytes: number, assets: readonly ProjectAsset[]): { manifest: Uint8Array; total: number } {
  artifactMetadata(name, createdAt);
  if (!Array.isArray(assets)) throw bad('project files must be a list');
  if (assets.length > MAX_PROJECT_ASSETS) throw limit('a project bundle supports at most 256 files');
  const ids = new Set<string>();
  let offset = engineBytes;
  const files = assets.map(asset => {
    if (!object(asset)) throw bad('invalid project file');
    const fields = metadata(asset.id, asset.role, asset.name, asset.mime);
    if (!(asset.data instanceof Uint8Array)) throw bad('project file bytes must be a Uint8Array');
    if (ids.has(fields.id)) throw bad('duplicate project file identifier');
    ids.add(fields.id);
    if (asset.data.byteLength > MAX_PROJECT_ASSET_BYTES) throw limit('each project input or output file must be at most 32 MiB');
    const entry: AssetRange = { ...fields, offset, length: asset.data.byteLength };
    offset += entry.length;
    if (offset > MAX_PROJECT_ARTIFACT_BYTES) throw limit('the project bundle exceeds 128 MiB');
    return entry;
  });
  const manifest = utf8.encode(scientificJson({ format: PROJECT_BUNDLE_FORMAT, name, createdAt, engineBytes, files } satisfies Manifest));
  if (manifest.byteLength > MAX_PROJECT_MANIFEST_BYTES) throw limit('the project manifest exceeds 1 MiB');
  const total = headerBytes + manifest.byteLength + offset;
  if (total > MAX_PROJECT_ARTIFACT_BYTES) throw limit('the project bundle exceeds 128 MiB');
  return { manifest, total };
}

/** The bundle accepts JSON data only, before the scientific encoder creates raw -0 literals.
 * Do not let unsupported values disappear through native JSON omission/toJSON behavior. */
function checkJson(value: unknown, active = new WeakSet<object>()): void {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint' || typeof value === 'number' && !Number.isFinite(value)) throw bad('the engine payload contains a non-JSON value');
  if (value === null || typeof value !== 'object') return;
  if (active.has(value) || typeof (value as { toJSON?: unknown }).toJSON === 'function' || (JSON as typeof JSON & { isRawJSON?(value: unknown): boolean }).isRawJSON?.(value)) throw bad('the engine payload contains a non-JSON object');
  active.add(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) checkJson(child, active);
  active.delete(value);
}

/** Opaque engine JSON plus exact original/generated file bytes; no paths are opened or written. */
export function encodeProjectArtifact(artifact: ProjectArtifact): Uint8Array {
  if (!object(artifact) || !object(artifact.engine)) throw bad('the engine payload must be a non-null JSON object');
  let json: string;
  try {
    checkJson(artifact.engine);
    json = scientificJson(artifact.engine);
  } catch { throw bad('the engine payload cannot be encoded as JSON'); }
  if (!json.startsWith('{')) throw bad('the engine payload must encode a JSON object');
  if (json.length > MAX_PROJECT_ENGINE_BYTES || utf8Length(json) > MAX_PROJECT_ENGINE_BYTES) throw limit('the engine payload exceeds 64 MiB');
  const engine = utf8.encode(json);
  const { manifest, total } = layout(artifact.name, artifact.createdAt, engine.byteLength, artifact.files);
  const result = new Uint8Array(total);
  result.set(magic);
  new DataView(result.buffer).setUint32(magic.byteLength, manifest.byteLength, true);
  result.set(manifest, headerBytes);
  let offset = headerBytes + manifest.byteLength;
  result.set(engine, offset); offset += engine.byteLength;
  for (const asset of artifact.files) { result.set(asset.data, offset); offset += asset.data.byteLength; }
  return result;
}

/** Lengths and contiguous ranges are checked before JSON payload parsing or file allocations. */
export function decodeProjectArtifact(bytes: Uint8Array): ProjectArtifact {
  if (!(bytes instanceof Uint8Array)) throw bad('project bundle bytes must be a Uint8Array');
  if (bytes.byteLength > MAX_PROJECT_ARTIFACT_BYTES) throw limit('the project bundle exceeds 128 MiB');
  if (bytes.byteLength < headerBytes || !magic.every((byte, index) => bytes[index] === byte)) throw bad('unknown or truncated project bundle format');
  const manifestBytes = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(magic.byteLength, true);
  if (manifestBytes === 0 || manifestBytes > MAX_PROJECT_MANIFEST_BYTES || headerBytes + manifestBytes > bytes.byteLength) throw bad('invalid or truncated project manifest length');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let parsed: unknown;
  try { parsed = JSON.parse(decoder.decode(bytes.subarray(headerBytes, headerBytes + manifestBytes))); }
  catch { throw bad('the project manifest is not valid UTF-8 JSON'); }
  if (!object(parsed) || !keys(parsed, ['format', 'name', 'createdAt', 'engineBytes', 'files']) || parsed.format !== PROJECT_BUNDLE_FORMAT) throw bad('unknown project manifest format');
  artifactMetadata(parsed.name, parsed.createdAt);
  if (!size(parsed.engineBytes) || parsed.engineBytes === 0 || parsed.engineBytes > MAX_PROJECT_ENGINE_BYTES) throw bad('invalid engine payload length');
  if (!Array.isArray(parsed.files) || parsed.files.length > MAX_PROJECT_ASSETS) throw bad('invalid project file count');
  const ids = new Set<string>();
  let offset = parsed.engineBytes;
  for (const entry of parsed.files) {
    if (!object(entry) || !keys(entry, ['id', 'role', 'name', 'mime', 'offset', 'length'])) throw bad('invalid project file range');
    metadata(entry.id, entry.role, entry.name, entry.mime);
    if (ids.has(entry.id as string)) throw bad('duplicate project file identifier');
    ids.add(entry.id as string);
    if (!size(entry.offset) || !size(entry.length) || entry.offset !== offset || entry.length > MAX_PROJECT_ASSET_BYTES) throw bad('invalid, overlapping or noncontiguous project file range');
    offset += entry.length;
    if (offset > MAX_PROJECT_ARTIFACT_BYTES) throw bad('project file ranges exceed the bundle limit');
  }
  const payloadAt = headerBytes + manifestBytes;
  if (payloadAt + offset !== bytes.byteLength) throw bad('project bundle contains truncated or leftover bytes');
  let engine: unknown;
  try { engine = JSON.parse(decoder.decode(bytes.subarray(payloadAt, payloadAt + parsed.engineBytes)), (_key, child: unknown) => {
    if (typeof child === 'number' && !Number.isFinite(child)) throw bad('the engine payload contains a non-JSON value');
    return child;
  }); }
  catch { throw bad('the engine payload is not valid UTF-8 JSON'); }
  if (!object(engine)) throw bad('the engine payload must be a non-null JSON object');
  return {
    name: parsed.name as string, createdAt: parsed.createdAt as number, engine,
    files: (parsed.files as AssetRange[]).map(entry => ({ id: entry.id, role: entry.role, name: entry.name, mime: entry.mime, data: bytes.slice(payloadAt + entry.offset, payloadAt + entry.offset + entry.length) })),
  };
}

export interface ProjectFileInventory {
  /** Snapshots the exact UTF-8 or binary bytes; throws on capacity instead of evicting history. */
  capture(role: ProjectAsset['role'], name: string, mime: string, data: string | Uint8Array): ProjectAsset;
  /** Reserves immutable bytes before I/O; only a successful completion enters snapshots. */
  prepare(role: ProjectAsset['role'], name: string, mime: string, data: string | Uint8Array): PreparedProjectAsset;
  snapshot(): ProjectAsset[];
  /** Replaces restored files atomically after validating every entry and capacity. */
  replace(files: readonly ProjectAsset[]): void;
  clear(): void;
}
export interface PreparedProjectAsset {
  complete(): ProjectAsset | null;
  discard(): void;
}
export function createProjectFileInventory(nextId: () => string): ProjectFileInventory {
  let files: ProjectAsset[] = [];
  let generation = 0;
  const staged = new Map<object, ProjectAsset>();
  const invalidate = (): void => { generation++; staged.clear(); };
  const inventory: ProjectFileInventory = {
    capture: (role, name, mime, data) => inventory.prepare(role, name, mime, data).complete()!,
    prepare(role, name, mime, data) {
      const id = nextId();
      metadata(id, role, name, mime);
      if (typeof data !== 'string' && !(data instanceof Uint8Array)) throw bad('project file content must be text or bytes');
      if (data.length > MAX_PROJECT_ASSET_BYTES || typeof data === 'string' && utf8Length(data) > MAX_PROJECT_ASSET_BYTES) throw limit('each project input or output file must be at most 32 MiB');
      const bytes = typeof data === 'string' ? utf8.encode(data) : data;
      const asset = { id, role, name, mime, data: bytes };
      // The final encoder also includes the actual engine bytes/name. Reserve only the local
      // inventory's manifest overhead here; never discard earlier completed exports to fit.
      layout('project', 0, 0, [...files, ...staged.values(), asset]);
      const token = {}; const captured = generation;
      staged.set(token, cloneAsset(asset));
      let completed: ProjectAsset | undefined;
      return {
        complete: () => {
          if (completed) return cloneAsset(completed);
          const saved = staged.get(token);
          if (captured !== generation || !saved) return null;
          staged.delete(token); files.push(saved); completed = saved;
          return cloneAsset(saved);
        },
        discard: () => { staged.delete(token); },
      };
    },
    snapshot: () => files.map(cloneAsset),
    replace(restored) { layout('project', 0, 0, restored); const copied = restored.map(cloneAsset); invalidate(); files = copied; },
    clear: () => { invalidate(); files = []; },
  };
  return inventory;
}
