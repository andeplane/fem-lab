import { describe, expect, it, vi } from 'vitest';
import { MAX_RETAINED_FILE_BYTES, type FileDeliveryInput } from '@femlab/registry';
import { createCompletedFiles, type CompletedFilesPolicy } from '../src/completed-files';
import { createProjectFileInventory, MAX_PROJECT_ASSET_BYTES } from '../src/project-artifact';

function harness(policy?: CompletedFilesPolicy) {
  let sequence = 0;
  const download = vi.fn((_name: string, _mime: string, _data: string | Uint8Array) => undefined);
  const nextId = vi.fn(() => `file-${++sequence}`);
  const changed = vi.fn(() => undefined);
  const cache = createCompletedFiles({ download, nextId, changed }, policy);
  const input = (data: string | Uint8Array, name = 'reports/original.txt'): FileDeliveryInput => ({ name, data, mime: 'text/plain', to: 'folder' });
  return { cache, download, nextId, changed, input };
}

describe('completed file snapshots', () => {
  it('reports exact UTF-8 bytes and immutable original metadata, including empty text', () => {
    const h = harness();
    const value = h.input('æ😀\ud800');
    const prepared = h.cache.capture()(value);
    value.name = 'changed'; value.mime = 'changed'; value.data = 'changed';
    expect(prepared.bytes).toBe(9);
    const receipt = prepared.complete();
    expect(receipt).toEqual({ name: 'reports/original.txt', mime: 'text/plain', bytes: 9, to: 'folder', id: 'file-1:1' });
    h.cache.download(receipt.id!);
    expect(h.download).toHaveBeenLastCalledWith('original.txt', 'text/plain', 'æ😀\ud800');
    const empty = h.cache.capture()(h.input('')).complete();
    expect(empty.bytes).toBe(0);
    expect(h.cache.info(empty.id!)).toEqual({ id: 'file-2:2', name: 'reports/original.txt', mime: 'text/plain', bytes: 0 });
  });

  it('delivers and retains one owned binary snapshot, and copies repeat downloads', () => {
    const h = harness();
    const backing = new Uint8Array([9, 0, 128, 255, 9]);
    const source = backing.subarray(1, 4);
    const prepared = h.cache.capture()(h.input(source));
    expect(prepared.data).not.toBe(source);
    source.fill(7);
    expect(prepared.data).toEqual(new Uint8Array([0, 128, 255]));
    const original = prepared.complete();
    h.download.mockImplementation((_name, _mime, data) => { if (typeof data !== 'string') data.fill(42); });
    expect(h.cache.download(original.id!)).toEqual({ ...original, name: 'original.txt', to: 'download' });
    expect(prepared.data).toEqual(new Uint8Array([0, 128, 255]));
    h.download.mockImplementation(() => undefined);
    h.cache.download(original.id!);
    expect(h.download.mock.calls.at(-1)![2]).toEqual(new Uint8Array([0, 128, 255]));
    expect(h.nextId).toHaveBeenCalledTimes(1);
    const metadata = h.cache.info(original.id!)!;
    metadata.name = 'mutated';
    expect(h.cache.info(original.id!)!.name).toBe('reports/original.txt');
    expect(h.cache.info(original.id!)).not.toHaveProperty('data');
  });

  it('keeps receipt completion idempotent and repeat-download errors do not erase the file', () => {
    const h = harness();
    const prepared = h.cache.capture()(h.input('saved'));
    const receipt = prepared.complete();
    receipt.name = 'caller mutation';
    expect(prepared.complete().name).toBe('reports/original.txt');
    prepared.discard();
    expect(h.cache.info(receipt.id!)).not.toBeNull();
    h.download.mockImplementation(() => { throw new Error('download refused'); });
    expect(() => h.cache.download(receipt.id!)).toThrow('download refused');
    expect(h.cache.info(receipt.id!)).not.toBeNull();
    expect(() => h.cache.download('missing')).toThrow(expect.objectContaining({ code: 'file.not-found' }));
  });
});

describe('completed file admission budgets and authority', () => {
  it('evicts completed entries FIFO under both entry and byte limits; reading does not reorder', () => {
    const h = harness({ maxEntries: 2, maxBytes: 5 });
    const a = h.cache.capture()(h.input('aa')).complete();
    const b = h.cache.capture()(h.input('bb')).complete();
    h.cache.info(a.id!); h.cache.download(a.id!);
    const c = h.cache.capture()(h.input('ccc')).complete();
    expect(h.cache.info(a.id!)).toBeNull();
    expect(h.cache.info(b.id!)).not.toBeNull();
    expect(h.cache.info(c.id!)).not.toBeNull();
    const d = h.cache.capture()(h.input('dddd')).complete();
    expect(h.cache.info(b.id!)).toBeNull();
    expect(h.cache.info(c.id!)).toBeNull();
    expect(h.cache.info(d.id!)).not.toBeNull();
  });

  it('counts pending binary snapshots against capacity until discarded, including across clear', () => {
    const h = harness({ maxEntries: 2, maxBytes: 4 });
    const pending = h.cache.capture()(h.input(new Uint8Array([1, 2, 3])));
    h.cache.clear();
    const blocked = h.cache.capture()(h.input(new Uint8Array([4, 5])));
    expect(blocked.complete()).toMatchObject({ bytes: 2, unavailable: 'capacity' });
    expect(blocked.complete()).not.toHaveProperty('id');
    pending.discard(); pending.discard();
    expect(h.cache.capture()(h.input('1234')).complete()).toHaveProperty('id');
    expect(pending.complete()).toMatchObject({ unavailable: 'expired' });
  });

  it('reserves entry count for empty pending files and releases expired completion', () => {
    const h = harness({ maxEntries: 1, maxBytes: 10 });
    const pending = h.cache.capture()(h.input(''));
    h.cache.clear();
    expect(h.cache.capture()(h.input('')).complete()).toMatchObject({ unavailable: 'capacity' });
    expect(pending.complete()).toMatchObject({ unavailable: 'expired' });
    expect(h.cache.capture()(h.input('')).complete()).toHaveProperty('id');
  });

  it('captures generation before awaits and expires completed ids and pending work on clear/dispose', () => {
    const h = harness();
    const admission = h.cache.capture();
    const done = admission(h.input('done')).complete();
    const pending = admission(h.input('pending'));
    h.cache.clear();
    expect(h.cache.info(done.id!)).toBeNull();
    expect(() => h.cache.download(done.id!)).toThrow(expect.objectContaining({ code: 'file.not-found' }));
    expect(admission(h.input('late prepare')).complete()).toMatchObject({ unavailable: 'expired' });
    expect(pending.complete()).toMatchObject({ unavailable: 'expired' });
    const next = h.cache.capture()(h.input('next'));
    h.cache.dispose(); h.cache.dispose();
    expect(next.complete()).toMatchObject({ unavailable: 'expired' });
    expect(h.cache.capture()(h.input('dead')).complete()).toMatchObject({ unavailable: 'expired' });
    expect(h.nextId).toHaveBeenCalledTimes(1);
  });

  it('reports truthful oversize/capacity metadata without allocating an eligible snapshot or id', () => {
    const h = harness({ maxFileBytes: 2, maxBytes: 1 });
    const source = new Uint8Array([1, 2, 3]);
    const oversized = h.cache.capture()(h.input(source));
    expect(oversized.data).toBe(source);
    expect(oversized.complete()).toMatchObject({ bytes: 3, unavailable: 'oversize' });
    expect(h.cache.capture()(h.input('æ')).complete()).toMatchObject({ bytes: 2, unavailable: 'capacity' });
    expect(h.nextId).not.toHaveBeenCalled();
    const defaultLimit = harness();
    expect(defaultLimit.cache.capture()(defaultLimit.input(new Uint8Array(MAX_RETAINED_FILE_BYTES + 1))).complete()).toMatchObject({ bytes: MAX_RETAINED_FILE_BYTES + 1, unavailable: 'oversize' });
  });

  it('does not turn eligible allocation or id failures into a false I/O failure and releases reservations', () => {
    const h = harness({ maxEntries: 1, maxBytes: 3 });
    const source = new Uint8Array([1]);
    source.slice = () => { throw new Error('allocation failed'); };
    const prepared = h.cache.capture()(h.input(source));
    expect(prepared.data).toBe(source);
    expect(prepared.complete()).toMatchObject({ bytes: 1, unavailable: 'unavailable' });
    h.nextId.mockImplementationOnce(() => { throw new Error('no id'); });
    expect(h.cache.capture()(h.input('abc')).complete()).toMatchObject({ unavailable: 'unavailable' });
    expect(h.cache.capture()(h.input('abc')).complete()).toHaveProperty('id');
  });

  it('rejects invalid policies and empty ids without publishing a false retained file', () => {
    expect(() => harness({ maxEntries: -1 })).toThrow('Invalid completed-file cache limits');
    const h = harness();
    const first = h.cache.capture()(h.input('first')).complete();
    h.nextId.mockReturnValue('');
    expect(h.cache.capture()(h.input('second')).complete()).toMatchObject({ unavailable: 'unavailable' });
    h.cache.download(first.id!);
    expect(h.download).toHaveBeenLastCalledWith('original.txt', 'text/plain', 'first');
  });

  it('never rebinds an old id after eviction or clear when the id factory repeats', () => {
    const h = harness({ maxEntries: 1 });
    h.nextId.mockReturnValue('repeated');
    const a = h.cache.capture()(h.input('first')).complete();
    const b = h.cache.capture()(h.input('second')).complete();
    expect(b.id).not.toBe(a.id);
    expect(h.cache.info(a.id!)).toBeNull();
    expect(() => h.cache.download(a.id!)).toThrow(expect.objectContaining({ code: 'file.not-found' }));
    h.cache.clear();
    const c = h.cache.capture()(h.input('third')).complete();
    expect(c.id).not.toBe(b.id);
    expect(h.cache.info(b.id!)).toBeNull();
    h.cache.download(c.id!);
    expect(h.download).toHaveBeenLastCalledWith('original.txt', 'text/plain', 'third');
  });

  it('notifies on insert, eviction and clear, never on repeat, and isolates observer failure', () => {
    const h = harness({ maxEntries: 1 });
    const first = h.cache.capture()(h.input('first')).complete();
    expect(h.changed).toHaveBeenCalledTimes(1);
    h.cache.download(first.id!);
    expect(h.changed).toHaveBeenCalledTimes(1);
    h.changed.mockImplementation(() => { throw new Error('observer failed'); });
    const second = h.cache.capture()(h.input('second')).complete();
    expect(second).toHaveProperty('id');
    expect(h.changed).toHaveBeenCalledTimes(3);
    expect(() => h.cache.clear()).not.toThrow();
    expect(h.cache.info(second.id!)).toBeNull();
    expect(h.changed.mock.calls.length).toBeGreaterThan(3);
  });
});

describe('durable project output archive hooks', () => {
  function archived(policy?: CompletedFilesPolicy) {
    let serial = 0;
    const inventory = createProjectFileInventory(() => `asset-${++serial}`);
    const archive = vi.fn((input: FileDeliveryInput) => {
      const pending = inventory.prepare('output', input.name, input.mime, input.data);
      return { complete: vi.fn(() => { pending.complete(); }), discard: vi.fn(() => { pending.discard(); }) };
    });
    const cache = createCompletedFiles({ archive, nextId: () => `file-${++serial}`, download: () => undefined }, policy);
    const input = (data: string | Uint8Array, name = 'result.bin'): FileDeliveryInput => ({ name, mime: 'application/octet-stream', to: 'download', data });
    return { inventory, archive, cache, input };
  }

  it('stages exact output before awaits, archives only successful delivery and completes exactly once', () => {
    const h = archived(); const bytes = new Uint8Array([0, 128, 255]); const input = h.input(bytes);
    const pending = h.cache.capture()(input);
    expect(h.archive).toHaveBeenCalledOnce(); expect(h.inventory.snapshot()).toEqual([]);
    bytes.fill(99); input.name = 'changed'; input.data = 'changed';
    const receipt = pending.complete(); pending.complete(); pending.discard();
    const hook = h.archive.mock.results[0]!.value;
    expect(hook.complete).toHaveBeenCalledOnce(); expect(hook.discard).not.toHaveBeenCalled();
    expect(h.inventory.snapshot()).toEqual([{ id: 'asset-1', role: 'output', name: 'result.bin', mime: 'application/octet-stream', data: new Uint8Array([0, 128, 255]) }]);
    expect(receipt).toHaveProperty('id');
    const failed = h.cache.capture()(h.input('failed write')); const failedHook = h.archive.mock.results[1]!.value;
    failed.discard(); failed.discard(); failed.complete();
    expect(failedHook.discard).toHaveBeenCalledOnce(); expect(failedHook.complete).not.toHaveBeenCalled(); expect(h.inventory.snapshot()).toHaveLength(1);
  });

  it('archives every completed export beyond the sixteen-entry UI cache', () => {
    const h = archived();
    const receipts = Array.from({ length: 20 }, (_, index) => h.cache.capture()(h.input(`exact output ${index}`, `result-${index}.txt`)).complete());
    expect(h.cache.snapshot()).toHaveLength(16); expect(h.cache.info(receipts[0]!.id!)).toBeNull();
    expect(h.inventory.snapshot()).toHaveLength(20);
    expect(new TextDecoder().decode(h.inventory.snapshot()[0]!.data)).toBe('exact output 0');
    expect(h.inventory.snapshot().map(asset => asset.name)).toEqual(Array.from({ length: 20 }, (_, index) => `result-${index}.txt`));
  });

  it('archives complete bytes even when UI retention is oversize, disabled or at pending capacity', () => {
    const h = archived({ maxFileBytes: 2, maxEntries: 1, maxBytes: 2 });
    const pending = h.cache.capture()(h.input('aa'));
    const capacity = h.cache.capture()(h.input('b')).complete();
    const oversize = h.cache.capture()(h.input(new Uint8Array([0, 128, 255]))).complete();
    expect(capacity.unavailable).toBe('capacity'); expect(oversize.unavailable).toBe('oversize');
    expect(h.inventory.snapshot().map(asset => asset.data)).toEqual([new Uint8Array([98]), new Uint8Array([0, 128, 255])]);
    pending.discard();
    const disabled = archived({ maxEntries: 0 });
    expect(disabled.cache.capture()(disabled.input('full original')).complete().unavailable).toBe('capacity');
    expect(new TextDecoder().decode(disabled.inventory.snapshot()[0]!.data)).toBe('full original');
  });

  it('archives the full 32 MiB supported output even though the UI cache retains at most 16 MiB', () => {
    const h = archived(); const source = new Uint8Array(MAX_PROJECT_ASSET_BYTES); source.fill(7); source[source.length - 1] = 255;
    const pending = h.cache.capture()(h.input(source, 'large-result.bin'));
    source.fill(99);
    expect(pending.complete()).toMatchObject({ bytes: MAX_PROJECT_ASSET_BYTES, unavailable: 'oversize' });
    expect(h.cache.snapshot()).toEqual([]);
    const saved = h.inventory.snapshot()[0]!;
    expect(saved.data.length).toBe(MAX_PROJECT_ASSET_BYTES); expect(saved.data[0]).toBe(7); expect(saved.data.at(-1)).toBe(255);
    expect(saved.name).toBe('large-result.bin'); expect(saved.role).toBe('output');
  });

  it('discards pending archives on clear, restore and dispose and never admits retired deliveries', () => {
    const h = archived(); const admission = h.cache.capture(); const first = admission(h.input('pending clear'));
    h.cache.clear(); expect(h.archive.mock.results[0]!.value.discard).toHaveBeenCalledOnce();
    first.complete(); first.discard();
    expect(admission(h.input('stale admission')).complete().unavailable).toBe('expired'); expect(h.archive).toHaveBeenCalledOnce();
    const restored = h.cache.capture()(h.input('pending restore')); h.cache.restore([]); restored.complete();
    expect(h.archive.mock.results[1]!.value.discard).toHaveBeenCalledOnce();
    const disposed = h.cache.capture()(h.input('pending disposal')); h.cache.dispose(); h.cache.dispose(); disposed.complete();
    expect(h.archive.mock.results[2]!.value.discard).toHaveBeenCalledOnce();
    expect(h.inventory.snapshot()).toEqual([]);
    expect(h.cache.capture()(h.input('dead')).complete().unavailable).toBe('expired'); expect(h.archive).toHaveBeenCalledTimes(3);
  });

  it('keeps physical I/O receipts successful when archive admission or completion throws', () => {
    const complete = vi.fn(() => { throw new Error('archive commit failed'); }); const discard = vi.fn(() => { throw new Error('archive discard failed'); });
    const archive = vi.fn().mockImplementationOnce(() => { throw new Error('archive full'); }).mockImplementation(() => ({ complete, discard }));
    const cache = createCompletedFiles({ archive, nextId: () => 'file', download: () => undefined });
    const input: FileDeliveryInput = { name: 'output', mime: 'text/plain', to: 'download', data: 'done' };
    expect(cache.capture()(input).complete()).toHaveProperty('id');
    const second = cache.capture()(input); expect(second.complete()).toHaveProperty('id'); expect(second.complete()).toHaveProperty('id');
    expect(complete).toHaveBeenCalledOnce(); expect(discard).toHaveBeenCalledOnce();
    const third = cache.capture()(input); expect(() => third.discard()).not.toThrow();
  });
});

it('round-trips completed exact text and binary files without sharing mutable archives',()=>{
  const h=harness(),source=new Uint8Array([0,128,255]);
  const first=h.cache.capture()(h.input('æ😀\ud800')).complete(),second=h.cache.capture()(h.input(source,'mesh.bin')).complete();
  const archive=h.cache.snapshot();source.fill(9);expect(archive).toHaveLength(2);
  const restored=harness();restored.cache.restore(archive);(archive[1]!.data as Uint8Array).fill(4);archive[0]!.metadata.name='mutated';
  restored.cache.download(first.id!);expect(restored.download).toHaveBeenLastCalledWith('original.txt','text/plain','æ😀\ud800');
  restored.cache.download(second.id!);expect(restored.download).toHaveBeenLastCalledWith('mesh.bin','text/plain',new Uint8Array([0,128,255]));
  const other=restored.cache.snapshot();(other[1]!.data as Uint8Array).fill(7);expect(restored.cache.snapshot()[1]!.data).toEqual(new Uint8Array([0,128,255]));
});
it('validates a whole restore before mutation, with exact size, uniqueness and policy checks',()=>{
  const h=harness({maxEntries:2,maxBytes:4,maxFileBytes:3});h.cache.capture()(h.input('old')).complete();const before=h.cache.snapshot();
  const good={metadata:{id:'new',name:'new.bin',mime:'application/octet-stream',bytes:2},data:new Uint8Array([1,2])};
  for(const archive of [[good,{...good,metadata:{...good.metadata,bytes:1}}],[good,good],[{...good,metadata:{...good.metadata,id:''}}],[{...good,metadata:{...good.metadata,bytes:4},data:'four'}],[good,{...good,metadata:{...good.metadata,id:'newer',bytes:3},data:'abc'}]]){
    expect(()=>h.cache.restore(archive)).toThrow();expect(h.cache.snapshot()).toEqual(before);
  }
  h.cache.restore([good]);expect(h.cache.snapshot()).toEqual([good]);
});
it('excludes pending files and fences their completions when an archive is restored',()=>{
  const h=harness({maxEntries:2,maxBytes:5}),admission=h.cache.capture(),pending=admission(h.input('xx'));
  expect(h.cache.snapshot()).toEqual([]);const file={metadata:{id:'restored',name:'a.txt',mime:'text/plain',bytes:3},data:'abc'};
  h.cache.restore([file]);expect(pending.complete()).toMatchObject({unavailable:'expired'});
  expect(admission(h.input('late')).complete()).toMatchObject({unavailable:'expired'});expect(h.cache.snapshot()).toEqual([file]);
  expect(h.cache.capture()(h.input('x')).complete()).toHaveProperty('id');
});
it('counts pending reservations during restore and cannot resurrect disposed caches',()=>{
  const h=harness({maxEntries:1,maxBytes:1});const pending=h.cache.capture()(h.input('a'));
  const file={metadata:{id:'restored',name:'a.txt',mime:'text/plain',bytes:1},data:'a'};
  expect(()=>h.cache.restore([file])).toThrow();pending.discard();h.cache.restore([file]);h.cache.dispose();expect(h.cache.snapshot()).toEqual([]);expect(()=>h.cache.restore([file])).toThrow(expect.objectContaining({code:'session.expired'}));
  const disabled=harness({maxEntries:0});expect(()=>disabled.cache.restore([file])).toThrow();disabled.cache.restore([]);
});
it('does not mint a restored completed-file identifier again',()=>{
  const h=harness();h.nextId.mockReturnValue('same');h.cache.restore([{metadata:{id:'same:1',name:'old',mime:'text/plain',bytes:1},data:'a'}]);
  expect(h.cache.capture()(h.input('b')).complete().id).toBe('same:2');h.cache.download('same:1');expect(h.download).toHaveBeenLastCalledWith('old','text/plain','a');
});
