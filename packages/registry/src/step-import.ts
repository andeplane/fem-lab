// STEP is a host conversion. The engine receives only the checked portable STL Command.
import { z } from 'zod';
import { FemError } from './error';
import { assertInside } from './project-paths';
import type { Ack, Command } from './generated/engine';
import type { AbaqusIo } from './abaqus-import';

export const STEP_CONVERTER_VERSION = 'occt-import-js-0.0.23+femlab.1';
export const STEP_ACCEPT = '.step,.stp,model/step';
export const MAX_STEP_BYTES = 16 * 1024 * 1024;
export const MAX_STEP_TRIANGLES = 500_000;
export const MAX_STEP_GEOMETRY_BYTES = 32 * 1024 * 1024;
const quantity = z.union([z.string().min(1), z.object({ value: z.number(), unit: z.string().min(1) })]);
export const StepImport = z.strictObject({
  name: z.string().min(1),
  path: z.string().optional().describe('STEP path inside the open project folder; omit to open the file picker.'),
  linearDeflection: quantity.meta({ description: 'Explicit absolute chord deflection, at least 0.0000001 m. STEP declared units are read by the converter; display units do not override them.', 'x-dimension': 'length' }),
  angularDeflection: quantity.describe('Explicit positive angular deflection, at most pi rad; for example 15 deg.'),
});
export type StepImportInput = z.output<typeof StepImport>;
export type StepIo = AbaqusIo;
export interface StepReport {
  name: string; sourceName: string; sourceBytes: number; sourceSha256: string;
  converter: typeof STEP_CONVERTER_VERSION; outputUnit: 'm';
  linearDeflection: { value: number; unit: 'm' }; angularDeflection: { value: number; unit: 'rad' };
  roots: number; transferredRoots: number; sourceRoots: number; faces: number; meshes: number; triangles: number;
  geometryBytes: number; geometrySha256: string;
}
export type StepImportResult = Ack & { report: StepReport };
export interface StepImportHost {
  import(input: StepImportInput): Promise<StepImportResult | { cancelled: true }>;
  /** False after publication has begun: cancellation cannot retract an admitted Command. */
  cancel(name: string): boolean;
}
export interface StepSource { name: string; bytes: Uint8Array }

function invalid(cause: string, where: string): never { throw new FemError('schema', cause, where, 'import a complete supported STEP solid with coarser deflection if necessary'); }
function bound(size: number): void {
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_STEP_BYTES) invalid('STEP input must contain 1 byte to 16 MiB', 'path');
}
/** Metadata is bounded before reading; a second bound checks the actual byte snapshot. */
export async function readStep(input: Pick<StepImportInput, 'path'>, io: StepIo): Promise<StepSource | null> {
  const pending = input.path === undefined ? io.pick() : io.read(assertInside(input.path).join('/'));
  const file = await pending;
  if (file === null) {
    return null;
  }
  if (!/\.(step|stp)$/i.test(file.name)) invalid('select a .step or .stp geometry file', 'path');
  bound(file.size);
  const bytes = (await file.read()).slice();
  bound(bytes.byteLength);
  return { name: file.name, bytes };
}

/** Validate physical parameters after the existing engine quantity parser converts to m/rad. */
export function stepDeflection(linear: number, angular: number): void {
  if (!Number.isFinite(linear) || linear < 1e-7) invalid('absolute linear deflection must be at least 0.0000001 m', 'linearDeflection');
  if (!Number.isFinite(angular) || angular <= 0 || angular > Math.PI) invalid('angular deflection must be positive and at most pi rad', 'angularDeflection');
}

const count = z.number().int().positive();
const converted = z.object({
  success: z.literal(true),
  femlab: z.object({ version: z.literal(STEP_CONVERTER_VERSION), complete: z.literal(true), roots: count, transferredRoots: count, sourceRoots: count, faces: count, meshes: count, triangles: count.max(MAX_STEP_TRIANGLES) }),
  root: z.object({ name: z.string(), meshes: z.array(z.number().int().nonnegative()), children: z.array(z.unknown()) }),
  meshes: z.array(z.object({
    attributes: z.object({ position: z.object({ array: z.array(z.number().finite()) }) }),
    index: z.object({ array: z.array(z.number().int().nonnegative()) }),
    brep_faces: z.array(z.object({ first: z.number().int().nonnegative(), last: z.number().int().nonnegative() })),
  })).min(1),
});
export type StepConversionCounts = Pick<StepReport, 'roots' | 'transferredRoots' | 'sourceRoots' | 'faces' | 'meshes' | 'triangles'>;

/** Require our completeness-checking build, account for every emitted face/triangle, and retain
 * f64 coordinates in deterministic ASCII STL. Rust still validates closed geometry atomically.
 * This output is portable source geometry; it is not an editable B-rep or CAD face identity. */
export function stepGeometry(value: unknown): { data: string; counts: StepConversionCounts } {
  if (value && typeof value === 'object' && 'success' in value && value.success === false) {
    const error = z.object({ error: z.object({ code: z.string(), cause: z.string(), where: z.string() }) }).safeParse(value);
    if (error.success) throw new FemError('unsupported', `${error.data.error.code}: ${error.data.error.cause}`.replace(/\s+/g, ' ').trim(), error.data.error.where, 'export supported complete solid geometry or repair the source STEP file');
  }
  const parsed = converted.safeParse(value);
  if (!parsed.success) invalid('STEP converter returned incomplete, incompatible or malformed geometry', 'step.converter');
  const { meshes, femlab, root } = parsed.data;
  if (femlab.roots !== femlab.transferredRoots || femlab.meshes !== meshes.length) invalid('STEP converter source/output counts disagree', 'step.converter');
  const seen = new Set<number>();
  const node = z.object({ meshes: z.array(z.number().int().nonnegative()), children: z.array(z.unknown()) });
  const pending: unknown[] = [root]; const hierarchy = new Set<unknown>();
  // The hierarchy is metadata, but account for every mesh occurrence instead of dropping it.
  while (pending.length) {
    const current = pending.pop();
    if (hierarchy.has(current)) invalid('STEP source hierarchy repeats a node', 'step.converter.root');
    hierarchy.add(current);
    const branch = node.safeParse(current);
    if (!branch.success) invalid('STEP converter returned an invalid source hierarchy', 'step.converter.root');
    for (const index of branch.data.meshes) {
      if (index >= meshes.length || seen.has(index)) invalid('STEP source hierarchy repeats or references a missing mesh', 'step.converter.root');
      seen.add(index);
    }
    if (hierarchy.size + pending.length + branch.data.children.length > 10_000) invalid('STEP source hierarchy exceeds 10000 nodes', 'step.converter.root');
    pending.push(...branch.data.children);
  }
  if (seen.size !== meshes.length) invalid('STEP source hierarchy omits an output mesh', 'step.converter.root');
  let triangles = 0; let faces = 0; let bytes = 0;
  const pieces: string[] = [];
  const append = (text: string): void => {
    bytes += text.length; // ASCII only: the UTF-8 byte count is exact.
    if (bytes > MAX_STEP_GEOMETRY_BYTES) invalid('converted geometry exceeds the 32 MiB payload limit', 'step.converter');
    pieces.push(text);
  };
  append('solid STEP\n');
  for (const mesh of meshes) {
    const coordinates = mesh.attributes.position.array; const indices = mesh.index.array;
    if (coordinates.length === 0 || coordinates.length % 3 || indices.length === 0 || indices.length % 3) invalid('STEP mesh has incomplete coordinates or triangles', 'step.converter.mesh');
    const n = indices.length / 3;
    triangles += n;
    if (triangles > MAX_STEP_TRIANGLES) invalid('converted geometry exceeds 500000 triangles', 'step.converter');
    let next = 0;
    for (const face of mesh.brep_faces) {
      if (face.first !== next || face.last < face.first || face.last >= n) invalid('STEP face ranges omit or repeat triangles', 'step.converter.mesh');
      next = face.last + 1; faces++;
    }
    if (next !== n) invalid('STEP mesh contains triangles without a source face', 'step.converter.mesh');
    for (let i = 0; i < indices.length; i += 3) {
      append('facet normal 0 0 0\nouter loop\n');
      for (let j = 0; j < 3; j++) {
        const at = indices[i + j]! * 3;
        if (at >= coordinates.length) invalid('STEP triangle references a missing vertex', 'step.converter.mesh');
        append(`vertex ${coordinates[at]} ${coordinates[at + 1]} ${coordinates[at + 2]}\n`);
      }
      append('endloop\nendfacet\n');
    }
  }
  if (triangles !== femlab.triangles || faces !== femlab.faces) invalid('STEP converter face/triangle counts disagree', 'step.converter');
  append('endsolid STEP\n');
  const { roots, transferredRoots, sourceRoots } = femlab;
  return { data: pieces.join(''), counts: { roots, transferredRoots, sourceRoots, faces, meshes: meshes.length, triangles } };
}

export function stepCommand(input: StepImportInput, data: string, sha256: string): Extract<Command, { cmd: 'geometry.import' }> {
  return { cmd: 'geometry.import', name: input.name, format: 'stl', encoding: 'utf8', data, sha256, unitLength: '1 m' };
}
