import { describe, expect, it, vi } from 'vitest';
import {
  createProjectFileInventory, decodeProjectArtifact, encodeProjectArtifact,
  MAX_PROJECT_ARTIFACT_BYTES, MAX_PROJECT_ENGINE_BYTES, MAX_PROJECT_ASSETS, MAX_PROJECT_ASSET_BYTES, MAX_PROJECT_MANIFEST_BYTES,
  type ProjectArtifact, type ProjectAsset,
} from '../src/project-artifact';

const utf8 = new TextEncoder();
const magic = utf8.encode('femlab-project-bundle/1\n');
const header = magic.length + 4;
const asset = (id = 'original', role: ProjectAsset['role'] = 'input'): ProjectAsset => ({ id, role, name: `${id}.dat`, mime: 'application/octet-stream', data: new Uint8Array([0, 255, 128, 13, 10, 0]) });
const artifact = (): ProjectArtifact => ({ name: 'Steel å beam 😀', createdAt: 123456789, engine: { format: 'opaque-test', journal: [{ cmd: 'model.new', name: '梁' }], future: { arbitrary: [true, 1, null] } }, files: [asset(), asset('result', 'output')] });
function unpack(bytes: Uint8Array) {
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(magic.length, true);
  return { manifest: JSON.parse(new TextDecoder().decode(bytes.subarray(header, header + length))), payload: bytes.slice(header + length) };
}
/** Independent wire constructor for malformed manifests and payloads. */
function pack(manifest: unknown, payload: Uint8Array): Uint8Array {
  const json = utf8.encode(JSON.stringify(manifest));
  const bytes = new Uint8Array(header + json.length + payload.length);
  bytes.set(magic); new DataView(bytes.buffer).setUint32(magic.length, json.length, true);
  bytes.set(json, header); bytes.set(payload, header + json.length);
  return bytes;
}

describe('portable project binary artifact', () => {
  it('round-trips opaque engine JSON, file metadata and every binary byte exactly', () => {
    const original = artifact();
    original.files.push({ ...asset('all-bytes'), data: Uint8Array.from({ length: 256 }, (_, index) => index) });
    const encoded = encodeProjectArtifact(original);
    const decoded = decodeProjectArtifact(encoded);
    expect(decoded).toEqual(original);
    expect(encodeProjectArtifact(decoded)).toEqual(encoded);
    // Accept a buffer view with an unrelated prefix/suffix, using its own length/offset.
    const container = new Uint8Array(encoded.length + 10);
    container.set(encoded, 5);
    expect(decodeProjectArtifact(container.subarray(5, -5))).toEqual(original);
    decoded.files[0]!.data.fill(77);
    (decoded.engine as { future: unknown }).future = 'changed';
    expect(decodeProjectArtifact(encoded)).toEqual(original);
    original.files[0]!.data.fill(88);
    expect(decodeProjectArtifact(encoded).files[0]!.data[0]).toBe(0);
  });

  it('supports no files and empty original/output bytes', () => {
    const source = artifact(); source.files = [];
    expect(decodeProjectArtifact(encodeProjectArtifact(source))).toEqual(source);
    source.files = [{ ...asset(), mime: '', data: new Uint8Array() }, { ...asset('output', 'output'), data: new Uint8Array() }];
    expect(decodeProjectArtifact(encodeProjectArtifact(source))).toEqual(source);
  });

  it('retains signed-zero and finite f64 bits, escaping and exact files through repeated full bundle encoding',()=>{
    const values=[-0,0,Number.MIN_VALUE,Number.MAX_VALUE,Math.PI,-1.234567890123456e-200];
    const text='literal -0.0 {"rawJSON":"-0.0"} quote " slash \\ newline\n ☃';
    const source={...artifact(),createdAt:-0,engine:{fields:{values},text,nested:{zero:-0}}};
    const bytes=encodeProjectArtifact(source),decoded=decodeProjectArtifact(bytes),engine=decoded.engine as typeof source.engine;
    expect(new Uint8Array(Float64Array.from(engine.fields.values).buffer)).toEqual(new Uint8Array(Float64Array.from(values).buffer));
    expect(Object.is(engine.nested.zero,-0)).toBe(true);expect(Object.is(decoded.createdAt,-0)).toBe(true);expect(engine.text).toBe(text);
    expect(decoded.files).toEqual(source.files);expect(encodeProjectArtifact(decoded)).toEqual(bytes);
    expect(decodeProjectArtifact(encodeProjectArtifact({...artifact(),engine:{a:{value:1},b:{value:1}}})).engine).toEqual({a:{value:1},b:{value:1}});
    const shared={zero:-0};expect((decodeProjectArtifact(encodeProjectArtifact({...artifact(),engine:{a:shared,b:shared}})).engine as {b:typeof shared}).b.zero).toBe(-0);
  });

  it('rejects unknown/truncated formats and bounds the manifest before parsing JSON', () => {
    const encoded = encodeProjectArtifact(artifact());
    for (const bytes of [encoded.slice(0, 2), new Uint8Array(encoded.length)]) expect(() => decodeProjectArtifact(bytes)).toThrow();
    for (const length of [0, MAX_PROJECT_MANIFEST_BYTES + 1, 0xffffffff, encoded.length]) {
      const bytes = encoded.slice(); new DataView(bytes.buffer).setUint32(magic.length, length, true);
      const parse = vi.spyOn(JSON, 'parse');
      try { expect(() => decodeProjectArtifact(bytes)).toThrow(); expect(parse).not.toHaveBeenCalled(); }
      finally { parse.mockRestore(); }
    }
    const { manifest, payload } = unpack(encoded); manifest.format = 'femlab-project-bundle/999';
    expect(() => decodeProjectArtifact(pack(manifest, payload))).toThrow();
    const invalidJson = encoded.slice(); invalidJson[header] = 255;
    expect(() => decodeProjectArtifact(invalidJson)).toThrow();
    expect(() => decodeProjectArtifact(new Uint8Array(MAX_PROJECT_ARTIFACT_BYTES + 1))).toThrow('128 MiB');
  });

  it.each([
    (m: any) => { m.name = ''; },
    (m: any) => { m.createdAt = -1; },
    (m: any) => { m.createdAt = 1.5; },
    (m: any) => { m.extra = true; },
    (m: any) => { m.engineBytes = 0; },
    (m: any) => { m.engineBytes = MAX_PROJECT_ENGINE_BYTES + 1; },
    (m: any) => { m.engineBytes = Number.MAX_SAFE_INTEGER + 1; },
    (m: any) => { m.files = {}; },
    (m: any) => { m.files = Array.from({ length: MAX_PROJECT_ASSETS + 1 }, () => m.files[0]); },
    (m: any) => { m.files[1].id = m.files[0].id; },
    (m: any) => { m.files[0].role = 'executable'; },
    (m: any) => { m.files[0].name = 'bad\u0000name'; },
    (m: any) => { m.files[0].mime = 123; },
    (m: any) => { m.files[0].id = ''; },
    (m: any) => { m.files[0].extra = true; },
    (m: any) => { m.files[0] = null; },
    (m: any) => { m.files[0].offset -= 1; },
    (m: any) => { m.files[0].offset += 1; },
    (m: any) => { m.files[1].offset = m.files[0].offset; },
    (m: any) => { m.files[0].length = -1; },
    (m: any) => { m.files[0].length = 1.5; },
    (m: any) => { m.files[0].length = MAX_PROJECT_ASSET_BYTES + 1; },
    (m: any) => { m.files[0].offset = Number.MAX_SAFE_INTEGER; },
  ])('rejects malformed metadata, overflow and overlapping/noncontiguous byte ranges %#', mutate => {
    const { manifest, payload } = unpack(encodeProjectArtifact(artifact()));
    mutate(manifest);
    expect(() => decodeProjectArtifact(pack(manifest, payload))).toThrow();
  });

  it('rejects truncated and trailing bytes and requires non-null object engine JSON', () => {
    const bytes = encodeProjectArtifact(artifact());
    expect(() => decodeProjectArtifact(bytes.slice(0, -1))).toThrow();
    const trailing = new Uint8Array(bytes.length + 1); trailing.set(bytes);
    expect(() => decodeProjectArtifact(trailing)).toThrow();
    const { manifest } = unpack(bytes); manifest.files = [];
    for (const source of ['null', '[]', '123', '"hello"', '{bad json', '{"overflow":1e999}']) {
      const engine = utf8.encode(source); manifest.engineBytes = engine.length;
      expect(() => decodeProjectArtifact(pack(manifest, engine))).toThrow();
    }
    manifest.engineBytes = 1;
    expect(() => decodeProjectArtifact(pack(manifest, new Uint8Array([255])))).toThrow();
  });

  it('rejects invalid encode inputs and unsupported JSON values', () => {
    const invalid: unknown[] = [null, { ...artifact(), name: '' }, { ...artifact(), createdAt: NaN }, { ...artifact(), files: null },
      ...[null, [], 3, 'engine', { value: undefined }, { value: () => 1 }, { value: Infinity }, {value:-Infinity},{value:NaN},{value:Symbol("not data")},{value:[undefined]},{value:new Array(1)},{value:(JSON as typeof JSON & {rawJSON(text:string):unknown}).rawJSON('1e999')}, { value: 1n }, { toJSON: () => null }].map(engine => ({ ...artifact(), engine })),
      { ...artifact(), files: [null] }, { ...artifact(), files: [{ ...asset(), data: [] }] },
      { ...artifact(), files: [asset(), asset()] }, { ...artifact(), files: [{ ...asset(), role: 'unknown' }] }];
    const circular: Record<string, unknown> = {}; circular.self = circular;
    invalid.push({ ...artifact(), engine: circular });
    for (const source of invalid) expect(() => encodeProjectArtifact(source as ProjectArtifact)).toThrow();
  });

  it('enforces individual engine/asset and aggregate bundle byte limits before output allocation', () => {
    const tooLarge = new Uint8Array(MAX_PROJECT_ASSET_BYTES + 1);
    expect(() => encodeProjectArtifact({ ...artifact(), files: [{ ...asset(), data: tooLarge }] })).toThrow('32 MiB');
    const block = tooLarge.subarray(0, MAX_PROJECT_ASSET_BYTES);
    expect(() => encodeProjectArtifact({ ...artifact(), files: Array.from({ length: 5 }, (_, index) => ({ ...asset(String(index)), data: block })) })).toThrow('128 MiB');
    expect(() => encodeProjectArtifact({ ...artifact(), files: Array.from({ length: MAX_PROJECT_ASSETS + 1 }, (_, index) => asset(String(index))) })).toThrow('256');
    expect(() => encodeProjectArtifact({ ...artifact(), engine: { text: 'x'.repeat(MAX_PROJECT_ENGINE_BYTES) }, files: [] })).toThrow('64 MiB');
  });
});

describe('immutable complete project file inventory', () => {
  it('stages immutable bytes before I/O and publishes only first successful completion', () => {
    let serial = 0;
    const inventory = createProjectFileInventory(() => String(++serial));
    const original = new Uint8Array([1, 2, 255]);
    const pending = inventory.prepare('output', 'report.bin', 'application/octet-stream', original);
    original.fill(99);
    expect(inventory.snapshot()).toEqual([]);
    const first = pending.complete()!; first.name = 'caller mutation'; first.data.fill(88);
    expect(pending.complete()).toEqual({ id: '1', role: 'output', name: 'report.bin', mime: 'application/octet-stream', data: new Uint8Array([1, 2, 255]) });
    pending.discard(); pending.discard();
    expect(inventory.snapshot()).toEqual([pending.complete()]);
    const failed = inventory.prepare('output', 'failed', '', 'failed delivery');
    failed.discard(); failed.discard(); expect(failed.complete()).toBeNull();
    expect(inventory.snapshot()).toHaveLength(1);
  });

  it('reserves staged entries without eviction and releases them on discard or generation changes', () => {
    let serial = 0;
    const inventory = createProjectFileInventory(() => String(++serial));
    const pending = Array.from({ length: MAX_PROJECT_ASSETS }, () => inventory.prepare('output', 'pending', '', ''));
    expect(inventory.snapshot()).toEqual([]);
    expect(() => inventory.prepare('input', 'excess', '', '')).toThrow('256');
    pending[0]!.discard();
    const admitted = inventory.prepare('output', 'admitted', '', '');
    inventory.clear();
    expect(admitted.complete()).toBeNull(); expect(pending[1]!.complete()).toBeNull();
    const fresh = inventory.prepare('output', 'new generation', '', 'new');
    inventory.replace([asset()]);
    expect(fresh.complete()).toBeNull(); expect(inventory.snapshot()).toEqual([asset()]);
    expect(inventory.prepare('output', 'after restore', '', '').complete()).not.toBeNull();
  });

  it('counts staged bytes against aggregate capacity without hiding the original completed files', () => {
    let serial = 0;
    const inventory = createProjectFileInventory(() => String(++serial));
    inventory.capture('input', 'original', '', 'original bytes');
    const block = new Uint8Array(MAX_PROJECT_ASSET_BYTES);
    const pending = Array.from({ length: 3 }, () => inventory.prepare('output', 'large report', '', block));
    expect(() => inventory.prepare('output', 'over budget', '', block)).toThrow('128 MiB');
    expect(inventory.snapshot()).toHaveLength(1);
    pending[0]!.discard();
    const replacement = inventory.prepare('output', 'replacement', '', block);
    inventory.clear();
    expect(replacement.complete()).toBeNull();
    expect(inventory.capture('input', 'small', '', 'small').name).toBe('small');
  });

  it('captures exact UTF-8/binary bytes with injected IDs and detached return values', () => {
    let serial = 0;
    const inventory = createProjectFileInventory(() => String(++serial));
    const original = new Uint8Array([0, 255, 128]);
    const captured = inventory.capture('input', 'original.bin', 'application/octet-stream', original);
    original.fill(77); captured.data.fill(88);
    const text = inventory.capture('output', 'résultat.txt', 'text/plain', 'å😀\r\n\u0000');
    expect(text.id).toBe('2');
    expect(inventory.snapshot()[0]!.data).toEqual(new Uint8Array([0, 255, 128]));
    expect(inventory.snapshot()[1]!.data).toEqual(utf8.encode('å😀\r\n\u0000'));
    const exposed = inventory.snapshot(); exposed[0]!.name = 'changed'; exposed[0]!.data.fill(99); exposed.pop();
    expect(inventory.snapshot()).toHaveLength(2);
    expect(inventory.snapshot()[0]!.name).toBe('original.bin');
    inventory.clear(); expect(inventory.snapshot()).toEqual([]);
  });

  it('retains every completed export beyond the UI cache size and fails at the file limit', () => {
    let serial = 0;
    const inventory = createProjectFileInventory(() => String(++serial));
    for (let index = 0; index < MAX_PROJECT_ASSETS; index++) inventory.capture('output', `export-${index}.txt`, 'text/plain', String(index));
    expect(inventory.snapshot()).toHaveLength(MAX_PROJECT_ASSETS);
    expect(inventory.snapshot()[0]!.name).toBe('export-0.txt');
    expect(() => inventory.capture('output', 'excess.txt', 'text/plain', 'excess')).toThrow('256');
    expect(inventory.snapshot()).toHaveLength(MAX_PROJECT_ASSETS);
  });

  it('rejects duplicate IDs, invalid metadata and oversized bytes without changing saved files', () => {
    const inventory = createProjectFileInventory(() => 'stable');
    inventory.capture('input', 'original', '', 'original');
    expect(() => inventory.capture('output', 'duplicate', '', 'duplicate')).toThrow('duplicate');
    expect(inventory.snapshot()).toHaveLength(1);
    const empty = createProjectFileInventory(() => 'id');
    expect(() => empty.capture('output', 'large', '', new Uint8Array(MAX_PROJECT_ASSET_BYTES + 1))).toThrow('32 MiB');
    expect(() => empty.capture('output', '', '', 'data')).toThrow();
    expect(empty.snapshot()).toEqual([]);
  });

  it('bounds UTF-8 and aggregate restored bytes before cloning or encoding oversized content', () => {
    const inventory = createProjectFileInventory(() => 'id');
    const unicode = 'é'.repeat(MAX_PROJECT_ASSET_BYTES / 2 + 1);
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    try {
      expect(() => inventory.capture('output', 'large-unicode', '', unicode)).toThrow('32 MiB');
      expect(encode.mock.calls.every(([value]) => (value?.length ?? 0) < 4096)).toBe(true);
    } finally { encode.mockRestore(); }
    const block = new Uint8Array(MAX_PROJECT_ASSET_BYTES);
    expect(() => inventory.replace(Array.from({ length: 4 }, (_, index) => ({ ...asset(String(index)), data: block })))).toThrow('128 MiB');
    expect(inventory.snapshot()).toEqual([]);
    expect(() => inventory.replace(Array.from({ length: MAX_PROJECT_ASSETS }, (_, index) => ({ ...asset(String(index)), name: 'x'.repeat(4096), data: new Uint8Array() })))).toThrow('manifest');
  });

  it('restores cloned files atomically, retaining the previous inventory if validation fails', () => {
    const inventory = createProjectFileInventory(() => 'next');
    inventory.capture('output', 'previous', '', 'data');
    const original = [asset(), asset('output', 'output')];
    inventory.replace(original);
    original[0]!.data.fill(99); original[0]!.name = 'changed';
    expect(inventory.snapshot()).toEqual([asset(), asset('output', 'output')]);
    expect(() => inventory.replace([asset('duplicate'), asset('duplicate')])).toThrow('duplicate');
    expect(inventory.snapshot()).toEqual([asset(), asset('output', 'output')]);
    inventory.replace([]); expect(inventory.snapshot()).toEqual([]);
  });
});
