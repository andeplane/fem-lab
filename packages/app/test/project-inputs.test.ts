import { describe, expect, it, vi } from 'vitest';
import type { AbaqusFile, AbaqusIo } from '@femlab/registry';
import { captureProjectInputs } from '../src/project-inputs';
import { MAX_PROJECT_ASSET_BYTES, MAX_PROJECT_ASSETS } from '../src/project-artifact';

function setup() {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('*NODE\r\nå\r\n')]);
  const root: AbaqusFile = { name: 'root.inp', size: bytes.length, read: vi.fn(async () => bytes) };
  const used: AbaqusFile = { name: 'parts/used.inp', size: 3, read: vi.fn(async () => new Uint8Array([1, 2, 3])) };
  const unrelated: AbaqusFile = { name: 'private/unrelated.inp', size: 3, read: vi.fn(async () => new Uint8Array([9, 9, 9])) };
  const io: AbaqusIo = { pick: vi.fn(async () => root), read: vi.fn(async () => used), pickIncludes: vi.fn(async () => [used, unrelated]), sha256: vi.fn(async () => 'hash') };
  let serial = 0; const nextId = vi.fn(() => `source-${++serial}`);
  return { bytes, root, used, unrelated, io, nextId, captured: captureProjectInputs(io, nextId) };
}

describe('exact admitted project source inventory', () => {
  it('preserves exact original binary bytes including BOM and line endings without caller aliases', async () => {
    const f = setup(); const original = f.bytes.slice();
    const picked = await f.captured.io.pick(); expect(f.captured.snapshot()).toEqual([]);
    const read = await picked!.read(); read.fill(99);
    const saved = f.captured.snapshot()[0]!;
    expect(saved).toEqual({ id: 'source-1', role: 'input', name: 'root.inp', mime: 'application/octet-stream', data: original });
    saved.data.fill(88); saved.name = 'mutated';
    expect(f.captured.snapshot()[0]!.data).toEqual(original); expect(f.captured.snapshot()[0]!.name).toBe('root.inp');
    expect(f.io.sha256).not.toHaveBeenCalled();
    expect(await f.captured.io.sha256(original)).toBe('hash'); expect(f.io.sha256).toHaveBeenCalledWith(original);
  });

  it('captures only actual reads, excluding unrelated selected include files and unread lookups', async () => {
    const f = setup();
    const includes = await f.captured.io.pickIncludes!(['parts/used.inp']);
    expect(f.io.pickIncludes).toHaveBeenCalledWith(['parts/used.inp']); expect(f.captured.snapshot()).toEqual([]);
    await includes![0]!.read();
    await f.captured.io.read('another/unread.inp');
    expect(f.captured.snapshot().map(file => file.name)).toEqual(['parts/used.inp']);
    expect(f.unrelated.read).not.toHaveBeenCalled(); expect(f.nextId).toHaveBeenCalledOnce();
  });

  it('does not stage picker cancellation, failed lookup or failed byte reads', async () => {
    const f = setup(); vi.mocked(f.io.pick).mockResolvedValueOnce(null);
    expect(await f.captured.io.pick()).toBeNull();
    vi.mocked(f.io.read).mockRejectedValueOnce(new Error('outside folder'));
    await expect(f.captured.io.read('missing')).rejects.toThrow('outside folder');
    vi.mocked(f.root.read).mockRejectedValueOnce(new Error('read refused'));
    const picked = await f.captured.io.pick(); await expect(picked!.read()).rejects.toThrow('read refused');
    vi.mocked(f.io.pickIncludes!).mockResolvedValueOnce(null);
    expect(await f.captured.io.pickIncludes!(['missing'])).toBeNull();
    expect(f.nextId).not.toHaveBeenCalled(); expect(f.captured.snapshot()).toEqual([]);
  });

  it('deduplicates identical rereads while retaining changed bytes and directly provided UTF-8 text', async () => {
    const f = setup(); const file = await f.captured.io.read('parts/used.inp');
    await file.read(); await file.read(); expect(f.captured.snapshot()).toHaveLength(1);
    vi.mocked(f.used.read).mockResolvedValueOnce(new Uint8Array([4, 5, 6])); await file.read();
    f.captured.add('inline.inp', 'text/plain', '\ufeff*NODE\r\nå');
    f.captured.add('inline.inp', 'text/plain', '\ufeff*NODE\r\nå');
    expect(f.captured.snapshot()).toHaveLength(3);
    expect(f.captured.snapshot()[2]!.data).toEqual(new TextEncoder().encode('\ufeff*NODE\r\nå'));
  });

  it('rejects file/count capacity explicitly without removing existing sources', () => {
    const f = setup(); f.captured.add('kept.inp', '', 'kept');
    expect(() => f.captured.add('oversize.inp', '', new Uint8Array(MAX_PROJECT_ASSET_BYTES + 1))).toThrow('32 MiB');
    expect(f.captured.snapshot()).toHaveLength(1);
    for (let index = 1; index < MAX_PROJECT_ASSETS; index++) f.captured.add(`source-${index}.inp`, '', '');
    expect(() => f.captured.add('excess.inp', '', '')).toThrow('256');
    expect(f.captured.snapshot()).toHaveLength(MAX_PROJECT_ASSETS);
    expect(f.captured.snapshot()[0]!.name).toBe('kept.inp');
  });

  it('preserves the optional include-picker surface when the underlying host lacks it', () => {
    const f = setup(); delete f.io.pickIncludes;
    expect(captureProjectInputs(f.io, f.nextId).io.pickIncludes).toBeUndefined();
  });
});
