import { describe, expect, it, vi } from 'vitest';
import { MAX_STEP_BYTES, MAX_STEP_TRIANGLES, StepImport, readStep, stepCommand, stepDeflection, stepGeometry, type StepIo } from '../src/step-import';
import { triangle } from './step-fixture';
const bytes = new TextEncoder().encode('ISO-10303-21;');
const io = (): StepIo => ({ pick: vi.fn(async () => ({ name: 'shape.STEP', size: bytes.length, read: async () => bytes })), read: vi.fn(async () => ({ name: 'shape.stp', size: bytes.length, read: async () => bytes })), sha256: vi.fn() });
const input = { name: 'body', linearDeflection: '0.1 mm', angularDeflection: '15 deg' };
describe('portable STEP source boundary', () => {
  it('requires explicit physical tolerances and only the scoped source options', () => {
    expect(StepImport.parse(input)).toEqual(input);
    expect(StepImport.parse({ ...input, path: 'part.step', linearDeflection: { value: 1, unit: 'mm' } })).toMatchObject({ path: 'part.step' });
    for (const invalid of [{ ...input, linearDeflection: undefined }, { ...input, angularDeflection: undefined }, { ...input, unitLength: '1 mm' }, { ...input, featureAngle: 181 }]) expect(StepImport.safeParse(invalid).success).toBe(false);
    stepDeflection(1e-7, Math.PI); stepDeflection(1, 0.1);
    for (const linear of [0, -1, 1e-8, Infinity, NaN]) expect(() => stepDeflection(linear, 1)).toThrow(/linear deflection/);
    for (const angular of [0, -1, Math.PI + 1e-9, Infinity, NaN]) expect(() => stepDeflection(1, angular)).toThrow(/angular deflection/);
  });
  it('bounds metadata before allocation and actual snapshots afterward, preserving scoped paths', async () => {
    const host = io();
    const read = await readStep({}, host);
    expect(read).toEqual({ name: 'shape.STEP', bytes });
    expect(read!.bytes).not.toBe(bytes);
    expect(await readStep({ path: './parts\\shape.stp' }, host)).toEqual({ name: 'shape.stp', bytes });
    expect(host.read).toHaveBeenCalledWith('parts/shape.stp');
    await expect(readStep({ path: '../escape.step' }, host)).rejects.toMatchObject({ code: 'file.scope' });
    host.pick = vi.fn(async () => null);
    expect(await readStep({}, host)).toBeNull();
    const readBytes = vi.fn(async () => bytes);
    host.pick = async () => ({ name: 'other.stl', size: 10, read: readBytes });
    await expect(readStep({}, host)).rejects.toMatchObject({ code: 'schema' });
    for (const size of [0, -1, 0.5, NaN, MAX_STEP_BYTES + 1]) {
      host.pick = async () => ({ name: 'x.step', size, read: readBytes });
      await expect(readStep({}, host)).rejects.toMatchObject({ code: 'schema' });
    }
    expect(readBytes).not.toHaveBeenCalled();
    host.pick = async () => ({ name: 'x.step', size: 1, read: async () => new Uint8Array(MAX_STEP_BYTES + 1) });
    await expect(readStep({}, host)).rejects.toMatchObject({ code: 'schema' });
    host.pick = async () => ({ name: 'x.step', size: MAX_STEP_BYTES, read: async () => new Uint8Array(MAX_STEP_BYTES) });
    expect((await readStep({}, host))!.bytes.byteLength).toBe(MAX_STEP_BYTES);
  });
  it('keeps doubles, winding and semantic zero in deterministic portable ASCII', () => {
    const value = triangle();
    const converted = stepGeometry(value);
    expect(converted.counts).toEqual({ roots: 1, transferredRoots: 1, sourceRoots: 1, faces: 1, meshes: 1, triangles: 1 });
    expect(converted.data).toBe('solid STEP\nfacet normal 0 0 0\nouter loop\nvertex 0 0 0\nvertex 1.0000000000000002 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid STEP\n');
    const command = stepCommand(input, converted.data, 'abc');
    expect(command).toMatchObject({ cmd: 'geometry.import', name: 'body', unitLength: '1 m', format: 'stl', encoding: 'utf8', sha256: 'abc' });
    expect(command).not.toHaveProperty('featureAngle');
    value.root.meshes = []; value.root.children = [{ meshes: [0], children: [] }];
    expect(stepGeometry(value)).toEqual(converted);
    const second = structuredClone(value.meshes[0]!);
    for (let i = 0; i < second.attributes.position.array.length; i += 3) second.attributes.position.array[i]! += 2;
    value.meshes.push(second); value.root.children.push({ meshes: [1], children: [] });
    value.femlab = { ...value.femlab, roots: 2, transferredRoots: 2, sourceRoots: 2, faces: 2, meshes: 2, triangles: 2 };
    const combined = stepGeometry(value);
    expect(combined.counts).toMatchObject({ roots: 2, sourceRoots: 2, meshes: 2, faces: 2, triangles: 2 });
    expect(combined.data.split('facet normal')).toHaveLength(3);
    expect(combined.data).toContain('vertex 2 0 0');
  });
  it('refuses incompatible/unpatched, failed, empty and malformed converter responses', () => {
    expect(() => stepGeometry({ success: false, error: { code: 'FACE_MISSING', cause: 'missing\n face', where: 'root 2' } })).toThrow(/FACE_MISSING: missing face/);
    for (const value of [null, false, {}, { success: false }, { ...triangle(), femlab: undefined }, { ...triangle(), success: false }, { ...triangle(), meshes: [] }]) expect(() => stepGeometry(value)).toThrow(/incomplete/);
    const invalid = (edit: (v: ReturnType<typeof triangle>) => void, pattern: RegExp) => { const value = triangle(); edit(value); expect(() => stepGeometry(value)).toThrow(pattern); };
    invalid(v => { v.femlab.transferredRoots = 2; }, /counts disagree/);
    invalid(v => { v.femlab.meshes = 2; }, /counts disagree/);
    invalid(v => { v.root.children = [{}]; }, /invalid source hierarchy/);
    invalid(v => { const cycle = { meshes: [], children: [] as unknown[] }; cycle.children = [cycle]; v.root.children = [cycle]; }, /repeats a node/);
    invalid(v => { v.root.children = Array.from({ length: 10000 }, () => ({ meshes: [], children: [] })); }, /10000 nodes/);
    invalid(v => { v.root.meshes = [1]; }, /missing mesh/);
    invalid(v => { v.root.meshes = [0, 0]; }, /repeats/);
    invalid(v => { v.root.meshes = []; }, /omits/);
    invalid(v => { v.meshes[0]!.attributes.position.array = []; }, /incomplete coordinates/);
    invalid(v => { v.meshes[0]!.attributes.position.array.pop(); }, /incomplete coordinates/);
    invalid(v => { v.meshes[0]!.index.array = []; }, /incomplete coordinates/);
    invalid(v => { v.meshes[0]!.index.array.pop(); }, /incomplete coordinates/);
    invalid(v => { v.meshes[0]!.index.array[2] = 3; }, /missing vertex/);
    invalid(v => { v.meshes[0]!.attributes.position.array[0] = Infinity; }, /incomplete/);
    invalid(v => { v.meshes[0]!.brep_faces[0]!.first = 1; }, /face ranges/);
    invalid(v => { v.meshes[0]!.brep_faces[0]!.last = 1; }, /face ranges/);
    invalid(v => { v.meshes[0]!.brep_faces = []; }, /without a source face/);
    invalid(v => { v.meshes[0]!.index.array.push(0, 2, 1); v.meshes[0]!.brep_faces = [{ first: 0, last: 1 }, { first: 2, last: 1 }]; }, /face ranges/);
    invalid(v => { v.femlab.triangles = 2; }, /counts disagree/);
    invalid(v => { v.femlab.faces = 2; }, /counts disagree/);
  });
  it('bounds the actual triangle sum and ASCII payload, beyond claimed converter counts', () => {
    const value = triangle(); const n = Math.floor(MAX_STEP_TRIANGLES / 2) + 1;
    value.meshes[0]!.index.array = Array.from({ length: n * 3 }, (_, i) => i % 3);
    value.meshes[0]!.brep_faces[0]!.last = n - 1;
    value.meshes.push(structuredClone(value.meshes[0]!)); value.root.meshes = [0, 1]; value.femlab.meshes = 2;
    // No large string is emitted: the first mesh crosses the payload bound first for long
    // coordinates; short zeros keep it below that bound and expose the aggregate count guard.
    value.meshes[0]!.attributes.position.array.fill(0);
    value.meshes[1]!.attributes.position.array.fill(0);
    expect(() => stepGeometry(value)).toThrow(/500000 triangles/);
    const big = triangle(); const count = 200000;
    big.meshes[0]!.attributes.position.array.fill(1.2345678901234567e-200);
    big.meshes[0]!.index.array = Array.from({ length: count * 3 }, (_, i) => i % 3);
    big.meshes[0]!.brep_faces[0]!.last = count - 1; big.femlab.triangles = count;
    expect(() => stepGeometry(big)).toThrow(/32 MiB/);
  });
});
