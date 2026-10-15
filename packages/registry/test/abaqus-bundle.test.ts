import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { MAX_ABAQUS_BYTES, readAbaqusBundle, type AbaqusFile, type AbaqusIo, type AbaqusDependencyQuery } from '../src/abaqus-import';

const file = (name: string, text: string): AbaqusFile => ({ name, size: Buffer.byteLength(text), read: vi.fn(async () => new TextEncoder().encode(text)) });
const io = (): AbaqusIo => ({ pick: vi.fn(async () => file('Job.inp', 'root')), read: vi.fn(async () => file('Job.inp', 'root')), sha256: vi.fn(async bytes => createHash('sha256').update(bytes).digest('hex')) });
const complete = vi.fn<AbaqusDependencyQuery>(async () => ({ missingFiles: [] }));

it('loads nested includes against the captured submission directory, preserving case and exact contents', async () => {
  const host = io();
  const files = new Map([['decks/Job.inp', file('Job.inp', 'root')], ['decks/mesh/Nodes.inc', file('Nodes.inc', 'nodes\r\n')], ['decks/Material.INC', file('Material.INC', 'material')], ['decks/Next.inc', file('Next.inc', 'nested')]]);
  host.read = vi.fn(async path => files.get(path)!);
  const dependencies = vi.fn<AbaqusDependencyQuery>(async source => ({ missingFiles: !source.sourceFiles?.['mesh/Nodes.inc'] ? ['mesh/Nodes.inc', 'Material.INC'] : !source.sourceFiles['Next.inc'] ? ['Next.inc'] : [] }));
  const result = await readAbaqusBundle({ path: './decks/Job.inp' }, host, dependencies);
  expect(result).toEqual({ text: 'root', sourceName: 'Job.inp', sha256: createHash('sha256').update('root').digest('hex'), sourceFiles: { 'mesh/Nodes.inc': 'nodes\r\n', 'Material.INC': 'material', 'Next.inc': 'nested' } });
  expect(host.read).toHaveBeenNthCalledWith(2, 'decks/mesh/Nodes.inc');
  expect(host.read).toHaveBeenNthCalledWith(4, 'decks/Next.inc');
  expect(dependencies.mock.calls[0]![0]).toEqual({ text: 'root', sourceName: 'Job.inp' });
  expect(host.pick).not.toHaveBeenCalled();
});

it('uses explicitly supplied include snapshots and names without any picker or file read', async () => {
  const host = io();
  const sourceFiles = { 'Mesh.inc': '\ufeffnodes\r\n' };
  const result = await readAbaqusBundle({ text: 'root', sourceName: 'Job.inp', sourceFiles }, host, complete);
  expect(result).toMatchObject({ sourceName: 'Job.inp', sourceFiles });
  expect(result!.sourceFiles).not.toBe(sourceFiles);
  expect(host.pick).not.toHaveBeenCalled();
  expect(host.read).not.toHaveBeenCalled();
});

it('reads only engine-requested selected files and can resolve a further include from the same selection', async () => {
  const host = io();
  const unused = file('private.env', 'must not read');
  host.pickIncludes = vi.fn(async (paths: readonly string[]) => [...paths.map(name => file(name, name)), unused]);
  const dependencies: AbaqusDependencyQuery = async source => ({ missingFiles: !source.sourceFiles?.['mesh/Nodes.inc'] ? ['mesh/Nodes.inc', 'mesh/Nodes.inc'] : !source.sourceFiles['Material.INC'] ? ['Material.INC'] : [] });
  const result = await readAbaqusBundle({ picker: true }, host, dependencies);
  expect(result!.sourceFiles).toEqual({ 'mesh/Nodes.inc': 'mesh/Nodes.inc', 'Material.INC': 'Material.INC' });
  expect(host.pickIncludes).toHaveBeenCalledTimes(2);
  expect(unused.read).not.toHaveBeenCalled();
});

it('returns cancellation at either picker without pretending the bundle is complete', async () => {
  const host = io(); host.pick = vi.fn(async () => null);
  const dependencies = vi.fn<AbaqusDependencyQuery>(async () => ({ missingFiles: ['Nodes.inc'] }));
  expect(await readAbaqusBundle({ picker: true }, host, dependencies)).toBeNull();
  expect(dependencies).not.toHaveBeenCalled();
  host.pickIncludes = vi.fn(async () => null);
  expect(await readAbaqusBundle({ text: 'root' }, host, dependencies)).toBeNull();
});

it.each(['../outside.inc', '/absolute.inc', 'C:/drive.inc', 'file\u0000.inc'])('rejects an unsafe dependency before file I/O: %s', async path => {
  const host = io();
  await expect(readAbaqusBundle({ path: 'Job.inp' }, host, async () => ({ missingFiles: [path] }))).rejects.toMatchObject({ code: 'file.scope' });
  expect(host.read).toHaveBeenCalledTimes(1);
});

it.each(['./Nodes.inc', 'folder//Nodes.inc', '../outside.inc'])('refuses noncanonical supplied filenames: %s', async path => {
  await expect(readAbaqusBundle({ text: 'root', sourceFiles: { [path]: 'nodes' } }, io(), complete)).rejects.toMatchObject({ code: 'file.scope' });
});

it('reports missing selection capability, missing files and duplicate selected identities precisely', async () => {
  const dependencies: AbaqusDependencyQuery = async () => ({ missingFiles: ['Nodes.inc'] });
  const host = io();
  await expect(readAbaqusBundle({ text: 'root' }, host, dependencies)).rejects.toMatchObject({ code: 'file.not-found', where: 'sourceFiles' });
  host.pickIncludes = vi.fn(async () => []);
  await expect(readAbaqusBundle({ text: 'root' }, host, dependencies)).rejects.toMatchObject({ code: 'file.not-found', where: 'Nodes.inc' });
  host.pickIncludes = vi.fn(async () => [file('Nodes.inc', 'a'), file('Nodes.inc', 'b')]);
  await expect(readAbaqusBundle({ text: 'root' }, host, dependencies)).rejects.toMatchObject({ code: 'schema', where: 'Nodes.inc' });
});

it('bounds total declared size before reading any new body, then checks actual snapshots too', async () => {
  const host = io(); const first = file('A.inc', 'a'); const second = { ...file('B.inc', 'b'), size: MAX_ABAQUS_BYTES };
  host.pickIncludes = vi.fn(async () => [first, second]);
  await expect(readAbaqusBundle({ text: 'root' }, host, async () => ({ missingFiles: ['A.inc', 'B.inc'] }))).rejects.toMatchObject({ code: 'schema' });
  expect(first.read).not.toHaveBeenCalled(); expect(second.read).not.toHaveBeenCalled();
  const lying = { ...file('A.inc', 'x'.repeat(MAX_ABAQUS_BYTES + 1)), size: 1 };
  host.pickIncludes = vi.fn(async () => [lying]);
  await expect(readAbaqusBundle({ text: 'root' }, host, async () => ({ missingFiles: ['A.inc'] }))).rejects.toMatchObject({ code: 'schema' });
});

it('checks aggregate bytes for supplied and actually-read includes, and validates UTF-8', async () => {
  await expect(readAbaqusBundle({ text: 'root', sourceFiles: { 'Nodes.inc': 'x'.repeat(MAX_ABAQUS_BYTES) } }, io(), complete)).rejects.toMatchObject({ code: 'schema' });
  await expect(readAbaqusBundle({ text: 'root', sourceFiles: { 'Nodes.inc': '\ud800' } }, io(), complete)).rejects.toMatchObject({ code: 'schema', where: 'Nodes.inc' });
  const host = io(); host.pickIncludes = vi.fn(async () => [{ name: 'Nodes.inc', size: 1, read: async () => new Uint8Array([0xc3, 0x28]) }]);
  await expect(readAbaqusBundle({ text: 'root' }, host, async () => ({ missingFiles: ['Nodes.inc'] }))).rejects.toMatchObject({ code: 'schema', where: 'Nodes.inc' });
  host.pickIncludes = vi.fn(async () => [{ ...file('Nodes.inc', 'x'.repeat(MAX_ABAQUS_BYTES)), size: 1 }]);
  await expect(readAbaqusBundle({ text: 'root' }, host, async () => ({ missingFiles: ['Nodes.inc'] }))).rejects.toMatchObject({ code: 'schema' });
});

it('bounds file counts and catches inconsistent dependency replies instead of looping forever', async () => {
  const files = Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`${i}.inc`, '']));
  await expect(readAbaqusBundle({ text: 'root', sourceFiles: files }, io(), complete)).rejects.toMatchObject({ code: 'schema', where: 'sourceFiles' });
  const present = { 'Nodes.inc': 'nodes' };
  await expect(readAbaqusBundle({ text: 'root', sourceFiles: present }, io(), async () => ({ missingFiles: ['Nodes.inc'] }))).rejects.toMatchObject({ code: 'internal' });
  await expect(readAbaqusBundle({ text: 'root' }, io(), async () => ({ missingFiles: Object.keys(files) }))).rejects.toMatchObject({ code: 'schema', where: 'sourceFiles' });
});

it('propagates dependency and include read errors without substituting another project or source', async () => {
  await expect(readAbaqusBundle({ text: 'root' }, io(), async () => { throw new Error('cycle in provided files'); })).rejects.toThrow('cycle in provided files');
  const host = io(); host.read = vi.fn(async path => { if (path === 'Job.inp') return file('Job.inp', 'root'); throw new Error('include unavailable'); });
  await expect(readAbaqusBundle({ path: 'Job.inp' }, host, async () => ({ missingFiles: ['Nodes.inc'] }))).rejects.toThrow('include unavailable');
});
