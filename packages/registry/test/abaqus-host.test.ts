import { expect, it, vi } from 'vitest';
import schema from '../src/generated/runtime-schema';
import { Registry, type EngineSchema } from '../src/registry';
import { fakeHost, ABAQUS_CONVERSION } from './fakes';

const mesh = { cmd: 'file.importAbaqus', name: 'imported', body: 'bar', mode: 'mesh', unitLength: '1 mm' };
function fixture() {
  const host = fakeHost();
  const captured = host.abaqus.capture();
  vi.mocked(host.abaqus.capture).mockReturnValue(captured);
  return { host, captured, registry: new Registry({ schema: schema as unknown as EngineSchema, host }) };
}

it('passes exact inline bytes, digest and explicit units to the read-only converter, then publishes its exact Commands and report', async () => {
  const { registry, captured, host } = fixture();
  const text = '\ufeff*NODE\r\n';
  expect(await registry.dispatch({ ...mesh, text })).toEqual({ report: ABAQUS_CONVERSION.report });
  expect(captured.io.sha256).toHaveBeenCalledWith(new TextEncoder().encode(text));
  expect(captured.convert).toHaveBeenCalledWith({ query: 'query.convertAbaqus', name: 'imported', body: 'bar', mode: 'mesh', unitLength: '1 mm', text, sha256: 'a'.repeat(64) });
  expect(captured.replace).toHaveBeenCalledWith(ABAQUS_CONVERSION.commands, ABAQUS_CONVERSION.report);
  expect(host.transport.dispatch).not.toHaveBeenCalled();
  expect(host.transport.importFile).not.toHaveBeenCalled();
});

it('requires Force in static mode and preserves an explicitly supplied Force for the authoritative mesh-mode rejection', async () => {
  const { registry, captured } = fixture();
  await expect(registry.dispatch({ ...mesh, mode: 'static', text: '*NODE' })).rejects.toMatchObject({ code: 'schema', where: 'unitForce' });
  expect(captured.convert).not.toHaveBeenCalled();
  await registry.dispatch({ ...mesh, mode: 'static', unitForce: { value: 1, unit: 'N' }, unitTime: { value: 1, unit: 'ms' }, text: '*NODE' });
  expect(captured.convert).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'static', unitForce: { value: 1, unit: 'N' }, unitTime: { value: 1, unit: 'ms' } }));
  vi.mocked(captured.convert).mockRejectedValueOnce({ code: 'schema', where: 'unitForce', cause: 'mesh mode does not use force units' });
  await expect(registry.dispatch({ ...mesh, unitForce: '1 N', text: '*NODE' })).rejects.toMatchObject({ where: 'unitForce' });
  expect(captured.convert).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'mesh', unitForce: '1 N' }));
  expect(captured.replace).toHaveBeenCalledTimes(1);
});

it('keeps the admitted source owner through a deferred included-file read and cancels without publication', async () => {
  const { registry, captured, host } = fixture();
  vi.mocked(captured.dependencies).mockResolvedValueOnce({ missingFiles: ['Mesh.inc'] }).mockResolvedValue({ missingFiles: [] });
  let finish!: (bytes: Uint8Array) => void;
  const pending = new Promise<Uint8Array>(resolve => { finish = resolve; });
  vi.mocked(captured.io.read).mockImplementation(async path => path === 'decks/Job.inp'
    ? { name: 'Job.inp', size: 4, read: async () => new TextEncoder().encode('root') }
    : { name: 'Mesh.inc', size: 5, read: () => pending });
  const importing = registry.dispatch({ ...mesh, path: 'decks/Job.inp' });
  await vi.waitFor(() => expect(captured.io.read).toHaveBeenCalledWith('decks/Mesh.inc'));
  const newer = fakeHost().abaqus.capture();
  vi.mocked(host.abaqus.capture).mockReturnValue(newer);
  finish(new TextEncoder().encode('nodes'));
  await importing;
  expect(captured.convert).toHaveBeenCalledWith(expect.objectContaining({ sourceName: 'Job.inp', sourceFiles: { 'Mesh.inc': 'nodes' } }));
  expect(captured.replace).toHaveBeenCalledOnce();
  expect(newer.dependencies).not.toHaveBeenCalled();
  expect(newer.convert).not.toHaveBeenCalled();
  const cancelled = fixture();
  vi.mocked(cancelled.captured.dependencies).mockResolvedValue({ missingFiles: ['Mesh.inc'] });
  cancelled.captured.io.pickIncludes = vi.fn(async () => null);
  expect(await cancelled.registry.dispatch({ ...mesh, picker: true })).toEqual({ cancelled: true });
  expect(cancelled.captured.replace).not.toHaveBeenCalled();
});

it('returns picker cancellation without conversion or publication', async () => {
  const { registry, captured } = fixture();
  vi.mocked(captured.io.pick).mockResolvedValue(null);
  expect(await registry.dispatch({ ...mesh, picker: true })).toEqual({ cancelled: true });
  expect(captured.convert).not.toHaveBeenCalled();
  expect(captured.replace).not.toHaveBeenCalled();
});

it('captures input and publication authority once before a deferred scoped file read', async () => {
  const { registry, captured, host } = fixture();
  let finish!: (bytes: Uint8Array) => void;
  const pending = new Promise<Uint8Array>(resolve => { finish = resolve; });
  vi.mocked(captured.io.read).mockResolvedValue({ name: 'old.inp', size: 5, read: () => pending });
  const importing = registry.dispatch({ ...mesh, path: './decks/old.inp' });
  const newer = fakeHost().abaqus.capture();
  vi.mocked(host.abaqus.capture).mockReturnValue(newer);
  finish(new TextEncoder().encode('*NODE'));
  await importing;
  expect(host.abaqus.capture).toHaveBeenCalledTimes(2); // one fixture acquisition, one actual admission
  expect(captured.io.read).toHaveBeenCalledWith('decks/old.inp');
  expect(captured.convert).toHaveBeenCalledOnce();
  expect(captured.replace).toHaveBeenCalledOnce();
  expect(newer.convert).not.toHaveBeenCalled();
  expect(newer.replace).not.toHaveBeenCalled();
});

it('propagates conversion and prepared-publication failures without a successful receipt', async () => {
  const { registry, captured } = fixture();
  vi.mocked(captured.convert).mockRejectedValueOnce({ code: 'unsupported', cause: 'DYNAMIC is unsupported' });
  await expect(registry.dispatch({ ...mesh, text: '*DYNAMIC' })).rejects.toMatchObject({ code: 'unsupported' });
  expect(captured.replace).not.toHaveBeenCalled();
  vi.mocked(captured.replace).mockRejectedValueOnce({ code: 'schema', where: 'file', cause: 'encoded file exceeds the limit' });
  await expect(registry.dispatch({ ...mesh, picker: true })).rejects.toMatchObject({ where: 'file' });
  expect(captured.replace).toHaveBeenCalledOnce();
});
