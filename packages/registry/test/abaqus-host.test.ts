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
  await registry.dispatch({ ...mesh, mode: 'static', unitForce: { value: 1, unit: 'N' }, text: '*NODE' });
  expect(captured.convert).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'static', unitForce: { value: 1, unit: 'N' } }));
  vi.mocked(captured.convert).mockRejectedValueOnce({ code: 'schema', where: 'unitForce', cause: 'mesh mode does not use force units' });
  await expect(registry.dispatch({ ...mesh, unitForce: '1 N', text: '*NODE' })).rejects.toMatchObject({ where: 'unitForce' });
  expect(captured.convert).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'mesh', unitForce: '1 N' }));
  expect(captured.replace).toHaveBeenCalledTimes(1);
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
  vi.mocked(captured.convert).mockRejectedValueOnce({ code: 'unsupported', cause: 'PART is unsupported' });
  await expect(registry.dispatch({ ...mesh, text: '*PART' })).rejects.toMatchObject({ code: 'unsupported' });
  expect(captured.replace).not.toHaveBeenCalled();
  vi.mocked(captured.replace).mockRejectedValueOnce({ code: 'schema', where: 'file', cause: 'encoded file exceeds the limit' });
  await expect(registry.dispatch({ ...mesh, picker: true })).rejects.toMatchObject({ where: 'file' });
  expect(captured.replace).toHaveBeenCalledOnce();
});
