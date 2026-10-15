import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { stepGeometry, type StepIo } from '@femlab/registry';
import { ACK } from '../../registry/test/fakes';
import { triangle } from '../../registry/test/step-fixture';
import { StepImporter, type StepAdmission, type StepWorker, type StepWorkerRequest } from '../src/step-import';

const input = { name: 'part', linearDeflection: '0.1 mm', angularDeflection: '15 deg' };
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
class FakeWorker implements StepWorker {
  onmessage: StepWorker['onmessage'] = null;
  onerror: StepWorker['onerror'] = null;
  postMessage = vi.fn((_request: StepWorkerRequest, _transfer: Transferable[]) => undefined);
  terminate = vi.fn();
  result(value: unknown = triangle()) { this.onmessage?.({ data: value } as MessageEvent<unknown>); }
}
function setup() {
  const worker = new FakeWorker(); const factory = vi.fn(() => worker);
  const status = vi.fn(); const report = vi.fn(); const controller = new AbortController();
  const importer = new StepImporter(factory, 'https://local/converter/', status, report);
  const io: StepIo = { pick: vi.fn(async () => ({ name: 'part.step', size: 3, read: vi.fn(async () => new Uint8Array([1, 2, 3])) })), read: vi.fn(), sha256: vi.fn(async bytes => createHash('sha256').update(bytes).digest('hex')) };
  const admission: StepAdmission = { signal: controller.signal, convert: vi.fn(async (_, to) => to === 'm' ? 0.0001 : Math.PI / 12), commit: vi.fn(async () => ACK) };
  const started = async () => { await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce()); };
  return { importer, worker, factory, io, admission, controller, status, report, started };
}
describe('dedicated cancellable STEP host conversion', () => {
  it('converts units, hashes exact original and portable bytes, publishes one captured Command, then terminates', async () => {
    const s = setup();
    expect(s.factory).not.toHaveBeenCalled();
    const run = s.importer.run(input, s.io, s.admission); await s.started();
    expect(s.admission.convert).toHaveBeenNthCalledWith(1, '0.1 mm', 'm');
    expect(s.admission.convert).toHaveBeenNthCalledWith(2, '15 deg', 'rad');
    expect(s.worker.postMessage).toHaveBeenCalledWith({ bytes: new Uint8Array([1, 2, 3]), linearDeflection: 0.0001, angularDeflection: Math.PI / 12, assets: 'https://local/converter/' }, expect.any(Array));
    s.worker.result();
    const result = await run;
    expect(result).toMatchObject({ ...ACK, report: { sourceName: 'part.step', outputUnit: 'm', meshes: 1, triangles: 1, linearDeflection: { value: 0.0001, unit: 'm' }, angularDeflection: { value: Math.PI / 12, unit: 'rad' } } });
    const data = stepGeometry(triangle()).data;
    expect(s.admission.commit).toHaveBeenCalledExactlyOnceWith({ cmd: 'geometry.import', name: 'part', data, encoding: 'utf8', sha256: createHash('sha256').update(data).digest('hex'), format: 'stl', unitLength: '1 m' });
    expect(s.report).toHaveBeenCalledOnce(); expect(s.status).toHaveBeenLastCalledWith(null);
    expect(s.worker.terminate).toHaveBeenCalledOnce(); expect(s.worker.onmessage).toBeNull(); expect(s.worker.onerror).toBeNull();
    expect(s.importer.cancel('part')).toBe(false);
  });
  it('handles picker cancellation and bad units before loading the converter', async () => {
    const s = setup(); s.io.pick = async () => null;
    expect(await s.importer.run(input, s.io, s.admission)).toEqual({ cancelled: true });
    expect(s.factory).not.toHaveBeenCalled(); expect(s.admission.commit).not.toHaveBeenCalled();
    s.io.pick = async () => ({ name: 'part.step', size: 3, read: async () => new Uint8Array([1, 2, 3]) });
    s.admission.convert = async () => 0;
    await expect(s.importer.run(input, s.io, s.admission)).rejects.toMatchObject({ code: 'schema' });
    expect(s.factory).not.toHaveBeenCalled();
    s.admission.convert = async () => { throw new Error('wrong dimension'); };
    await expect(s.importer.run(input, s.io, s.admission)).rejects.toThrow('wrong dimension');
    expect(s.status).toHaveBeenLastCalledWith(null);
  });
  it('rejects a second conversion, mismatched cancel targets, late messages and restarts only after cleanup', async () => {
    const s = setup(); const run = s.importer.run(input, s.io, s.admission); const rejected = expect(run).rejects.toMatchObject({ code: 'cancelled' });
    await s.started(); const late = s.worker.onmessage!;
    await expect(s.importer.run({ ...input, name: 'second' }, s.io, s.admission)).rejects.toMatchObject({ code: 'session.conflict' });
    expect(s.importer.cancel('other')).toBe(false); expect(s.importer.cancel('part')).toBe(true);
    await rejected; late({ data: triangle() } as MessageEvent<unknown>);
    expect(s.admission.commit).not.toHaveBeenCalled(); expect(s.report).not.toHaveBeenCalled();
    s.io.pick = async () => null;
    expect(await s.importer.run(input, s.io, s.admission)).toEqual({ cancelled: true });
  });
  it.each(['convert', 'pick', 'read', 'hash', 'worker'] as const)('cancels a pending %s and never publishes', async phase => {
    const s = setup(); const paused = deferred<never>(); const entered = vi.fn(() => paused.promise);
    if (phase === 'convert') s.admission.convert = entered;
    if (phase === 'pick') s.io.pick = entered;
    if (phase === 'read') s.io.pick = async () => ({ name: 'part.step', size: 3, read: entered });
    if (phase === 'hash') s.io.sha256 = entered;
    const run = s.importer.run(input, s.io, s.admission); const rejected = expect(run).rejects.toMatchObject({ code: 'cancelled' });
    if (phase === 'worker') await s.started(); else await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    s.importer.dispose(); await rejected;
    expect(s.admission.commit).not.toHaveBeenCalled(); expect(s.report).not.toHaveBeenCalled();
    if (phase === 'worker') expect(s.worker.terminate).toHaveBeenCalledOnce();
  });
  it('honors producer expiry before starting and during conversion', async () => {
    const s = setup(); s.controller.abort();
    await expect(s.importer.run(input, s.io, s.admission)).rejects.toMatchObject({ code: 'cancelled' });
    expect(s.io.pick).not.toHaveBeenCalled(); expect(s.factory).not.toHaveBeenCalled();
    const t = setup(); const run = t.importer.run(input, t.io, t.admission); const rejected = expect(run).rejects.toMatchObject({ code: 'cancelled' });
    await t.started(); t.controller.abort(); await rejected;
    expect(t.worker.terminate).toHaveBeenCalledOnce(); expect(t.admission.commit).not.toHaveBeenCalled();
  });
  it('propagates Worker load/runtime, malformed output, source read/hash and checked publication errors', async () => {
    const s = setup(); s.factory.mockImplementationOnce(() => { throw new Error('load failed'); });
    await expect(s.importer.run(input, s.io, s.admission)).rejects.toThrow('load failed');
    s.factory.mockImplementationOnce(() => { s.worker.postMessage.mockImplementationOnce(() => { throw new Error('post failed'); }); return s.worker; });
    await expect(s.importer.run(input, s.io, s.admission)).rejects.toThrow('post failed');
    const t = setup(); const failure = t.importer.run(input, t.io, t.admission); const rejected = expect(failure).rejects.toThrow('Worker crashed');
    await t.started(); t.worker.onerror!({ message: 'Worker crashed' } as ErrorEvent); await rejected;
    const u = setup(); const malformed = u.importer.run(input, u.io, u.admission); const invalid = expect(malformed).rejects.toMatchObject({ code: 'schema' });
    await u.started(); u.worker.result({}); await invalid;
    const v = setup(); v.io.pick = async () => { throw new Error('file read failed'); };
    await expect(v.importer.run(input, v.io, v.admission)).rejects.toThrow('file read failed');
    v.io.pick = async () => ({ name: 'part.step', size: 3, read: async () => new Uint8Array([1, 2, 3]) });
    v.io.sha256 = async () => { throw new Error('hash failed'); };
    await expect(v.importer.run(input, v.io, v.admission)).rejects.toThrow('hash failed');
    const w = setup(); w.admission.commit = async () => { throw new Error('stale admission'); };
    const stale = w.importer.run(input, w.io, w.admission); const denied = expect(stale).rejects.toThrow('stale admission');
    await w.started(); w.worker.result(); await denied;
    expect(w.report).not.toHaveBeenCalled(); expect(w.worker.terminate).toHaveBeenCalledOnce();
  });
  it('cannot retract a Command after publication starts, and still releases all resources', async () => {
    const s = setup(); const publishing = deferred<typeof ACK>(); s.admission.commit = vi.fn(() => publishing.promise);
    const run = s.importer.run(input, s.io, s.admission); await s.started(); s.worker.result();
    await vi.waitFor(() => expect(s.admission.commit).toHaveBeenCalledOnce());
    expect(s.status).toHaveBeenLastCalledWith({ name: 'part', phase: 'publishing', cancellable: false });
    expect(s.importer.cancel('part')).toBe(false); publishing.resolve(ACK); await run;
    expect(s.worker.terminate).toHaveBeenCalledOnce();
  });
});
