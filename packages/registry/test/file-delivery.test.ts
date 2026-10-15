import { describe, expect, it, vi } from 'vitest';
import schema from '../src/generated/runtime-schema';
import { Registry, type EngineSchema } from '../src/registry';
import { FileDelivery, fileByteLength, unretainedFile, type CompletedFilesHost, type PreparedFileDelivery } from '../src/file-delivery';
import { fakeHost, fakeTransport } from './fakes';

const make = () => {
  const transport = fakeTransport(), host = fakeHost(transport);
  return { transport, host, registry: new Registry({ schema: schema as unknown as EngineSchema, host }) };
};
const metadata = { id: 'original', name: 'a.bin', mime: 'application/octet-stream', bytes: 3 };
const receipt = { ...metadata, to: 'download' as const };
function retained(): CompletedFilesHost {
  return { capture: vi.fn(() => unretainedFile), info: vi.fn(() => metadata), download: vi.fn(() => receipt), clear: vi.fn(), dispose: vi.fn() };
}

describe('exact completed-file metadata', () => {
  it('counts arbitrary UTF-16 strings as the actual UTF-8 encoder does, without retaining a payload', () => {
    let seed = 17;
    for (let sample = 0; sample < 512; sample++) {
      let text = '';
      for (let unit = 0; unit < 64; unit++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; text += String.fromCharCode(seed & 65535); }
      expect(fileByteLength(text)).toBe(new TextEncoder().encode(text).byteLength);
    }
    for (const text of ['', 'μ🙂', '\x7f\u0080\u07ff\u0800', '\ud800', '\ud800x', '\ud800\udc00', '\udfff']) {
      expect(fileByteLength(text)).toBe(new TextEncoder().encode(text).byteLength);
    }
    expect(fileByteLength(new Uint8Array([0, 255]))).toBe(2);
  });
  it('keeps legacy receipts parseable and snapshots eligible unretained binary input', () => {
    expect(FileDelivery.parse({ name: 'old', to: 'folder' })).toEqual({ name: 'old', to: 'folder' });
    const input = { name: 'a', to: 'download' as const, mime: 'a/b', data: new Uint8Array([1, 2]) };
    const prepared = unretainedFile(input); input.data.fill(9); input.name = 'other';
    expect(prepared.data).toEqual(new Uint8Array([1, 2]));
    expect(prepared.complete()).toEqual({ name: 'a', to: 'download', mime: 'a/b', bytes: 2, unavailable: 'unsupported' });
    prepared.discard();
    expect(unretainedFile({ ...input, data: 'æ😀' }).complete().bytes).toBe(6);
    const big = new Uint8Array(16 * 1024 * 1024 + 1);
    expect(unretainedFile({ ...input, data: big }).data).toBe(big);
    input.data.slice = () => { throw new Error('allocation'); };
    expect(unretainedFile(input).complete()).toMatchObject({ unavailable: 'unavailable', bytes: 2 });
  });
  it('downloads only the retained id and queries metadata without engine or folder reads', async () => {
    const h = make(); h.host.files.completed = retained();
    expect(await h.registry.dispatch({ cmd: 'file.download', id: 'original' })).toEqual(receipt);
    expect(h.host.files.completed.download).toHaveBeenCalledWith('original');
    expect(await h.registry.query({ query: 'query.fileDelivery', id: 'original' })).toEqual({ file: metadata });
    expect(h.transport.query).not.toHaveBeenCalled(); expect(h.transport.export).not.toHaveBeenCalled();
    expect(h.host.folder.readBytes).not.toHaveBeenCalled(); expect(h.host.folder.readText).not.toHaveBeenCalled();
    await h.registry.dispatch({ cmd: 'chat.clear' }); expect(h.host.files.completed.clear).toHaveBeenCalledOnce();
    h.host.files.completed = undefined;
    expect(await h.registry.query({ query: 'query.fileDelivery', id: 'original' })).toEqual({ file: null });
    await expect(h.registry.dispatch({ cmd: 'file.download', id: 'original' })).rejects.toMatchObject({ code: 'unsupported' });
  });
  it('captures admission before scientific reads and delivers the prepared owned snapshot', async () => {
    const h = make(); const cache = retained(); h.host.files.completed = cache;
    let release!: () => void;
    vi.mocked(h.transport.export).mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return { filename: 'a.bin', mime: metadata.mime, bytes: new Uint8Array([7, 8, 9]) }; });
    const snapshot = new Uint8Array([1, 2, 3]);
    const prepared: PreparedFileDelivery = { data: snapshot, bytes: 3, complete: vi.fn(() => receipt), discard: vi.fn() };
    const admission = vi.fn(() => prepared); vi.mocked(cache.capture).mockReturnValue(admission);
    const pending = h.registry.dispatch({ cmd: 'file.export', spec: { format: 'vtu' } });
    await vi.waitFor(() => expect(h.transport.export).toHaveBeenCalledOnce());
    expect(cache.capture).toHaveBeenCalledOnce(); expect(admission).not.toHaveBeenCalled();
    release(); expect(await pending).toEqual(receipt);
    expect(h.host.files.download).toHaveBeenCalledWith('a.bin', metadata.mime, snapshot);
    expect(prepared.complete).toHaveBeenCalledOnce(); expect(prepared.discard).not.toHaveBeenCalled();
  });
  it('does not report cancelled or failed delivery and preserves successful I/O if retention fails', async () => {
    const h = make(); const cache = retained(); h.host.files.completed = cache;
    vi.mocked(h.host.view.captureAnimation).mockResolvedValue({ webm: null });
    expect(await h.registry.dispatch({ cmd: 'file.export', spec: { format: 'webm', width: 100, height: 100 } })).toEqual({ cancelled: true });
    const discard = vi.fn(); const complete = vi.fn(() => { throw new Error('retention failed'); });
    vi.mocked(cache.capture).mockReturnValue(input => ({ data: input.data, bytes: fileByteLength(input.data), complete, discard }));
    expect(await h.registry.dispatch({ cmd: 'file.write', path: 'a.txt', text: 'æ' })).toEqual({ name: 'a.txt', to: 'folder', bytes: 2, mime: 'text/plain;charset=utf-8', unavailable: 'unavailable' });
    expect(h.host.folder.writeText).toHaveBeenCalledWith('a.txt', 'æ'); expect(discard).toHaveBeenCalledOnce();
    vi.mocked(h.host.folder.writeText).mockRejectedValue(new Error('write failed'));
    await expect(h.registry.dispatch({ cmd: 'file.write', path: 'a.txt', text: 'bad' })).rejects.toThrow('write failed');
    expect(complete).toHaveBeenCalledOnce(); expect(discard).toHaveBeenCalledTimes(2);
  });
  it('keeps actual output truthful when optional capture or preparation is unavailable', async () => {
    const h = make(); const cache = retained(); h.host.files.completed = cache;
    vi.mocked(cache.capture).mockImplementationOnce(() => { throw new Error('capture unavailable'); });
    expect(await h.registry.dispatch({ cmd: 'file.write', path: 'one', text: '1' })).toMatchObject({ bytes: 1, unavailable: 'unavailable' });
    vi.mocked(cache.capture).mockReturnValue(() => { throw new Error('prepare unavailable'); });
    expect(await h.registry.dispatch({ cmd: 'file.write', path: 'two', text: '22' })).toMatchObject({ bytes: 2, unavailable: 'unavailable' });
    expect(h.host.folder.writeText).toHaveBeenCalledTimes(2);
  });
});
