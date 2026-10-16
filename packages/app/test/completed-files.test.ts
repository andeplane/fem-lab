import { describe, expect, it, vi } from 'vitest';
import { MAX_RETAINED_FILE_BYTES, type FileDeliveryInput } from '@femlab/registry';
import { createCompletedFiles, type CompletedFilesPolicy } from '../src/completed-files';

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
