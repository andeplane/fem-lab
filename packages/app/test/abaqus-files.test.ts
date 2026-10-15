import { webcrypto } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { readAbaqus } from '@femlab/registry';
import { browserAbaqusIo } from '../src/abaqus-files';
import { ProjectFolder } from '../src/ai/project';
import { fakeDir } from './project-fake';
import { Store } from '../src/store';
import { makeHostContext } from '../src/host';
import { fakeHost, fakeTransport } from '../../registry/test/fakes';
import { readHostCaps } from '../src/capabilities';

const crypto = webcrypto as unknown as Pick<Crypto, 'subtle'>;
const picker = (file: File | null) => {
  const input = document.createElement('input');
  Object.defineProperty(input, 'files', { value: file ? [file] : [] });
  input.click = () => input.dispatchEvent(new Event('change'));
  const doc: Pick<Document, 'createElement'> = { createElement: vi.fn(() => input) as Document['createElement'] };
  return { input, io: browserAbaqusIo(doc, crypto, null) };
};

it('returns metadata before byte reading, preserves UTF-8 bytes, and uses the .inp picker filter', async () => {
  const file = new File(['\ufeff*NODE\r\n1,0,0,0\r\n'], 'bar.inp');
  const read = vi.spyOn(file, 'arrayBuffer');
  const { input, io } = picker(file);
  const picked = await io.pick();
  expect(input.accept).toBe('.inp,text/plain');
  expect(picked).toMatchObject({ name: 'bar.inp', size: file.size });
  expect(read).not.toHaveBeenCalled();
  expect(await picked!.read()).toEqual(new Uint8Array(await file.arrayBuffer()));
  expect(await io.sha256(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

it('resolves picker cancellation and an empty choice without reading another source', async () => {
  const { io } = picker(null);
  expect(await io.pick()).toBeNull();
  const input = document.createElement('input');
  input.click = () => input.dispatchEvent(new Event('cancel'));
  const doc: Pick<Document, 'createElement'> = { createElement: () => input } as Pick<Document, 'createElement'>;
  expect(await browserAbaqusIo(doc, crypto, null).pick()).toBeNull();
});

it('retains submission-relative include identities and reads only requested files from one folder selection', async () => {
  const nodes = new File(['nodes'], 'Nodes.INC');
  Object.defineProperty(nodes, 'webkitRelativePath', { value: 'submission/mesh/Nodes.INC' });
  const material = new File(['material'], 'Steel.inc');
  Object.defineProperty(material, 'webkitRelativePath', { value: 'submission/Steel.inc' });
  const unrelated = new File(['private'], 'private.env');
  Object.defineProperty(unrelated, 'webkitRelativePath', { value: 'submission/private.env' });
  const unusedRead = vi.spyOn(unrelated, 'arrayBuffer');
  const input = document.createElement('input');
  Object.defineProperty(input, 'files', { value: [nodes, material, unrelated] });
  input.click = vi.fn(() => input.dispatchEvent(new Event('change')));
  const doc: Pick<Document, 'createElement'> = { createElement: vi.fn(() => input) as Document['createElement'] };
  const io = browserAbaqusIo(doc, crypto, null);
  const first = await io.pickIncludes!(['mesh/Nodes.INC']);
  expect(input.webkitdirectory).toBe(true);
  expect(first!.map(file => file.name)).toEqual(['mesh/Nodes.INC']);
  expect(new TextDecoder().decode(await first![0]!.read())).toBe('nodes');
  const next = await io.pickIncludes!(['Steel.inc', 'missing.inc']);
  expect(next!.map(file => file.name)).toEqual(['Steel.inc']);
  expect(input.click).toHaveBeenCalledTimes(1);
  expect(unusedRead).not.toHaveBeenCalled();
});

it('returns include folder cancellation and empty selection without reading or publishing', async () => {
  const empty = picker(null);
  expect(await empty.io.pickIncludes!(['Nodes.inc'])).toBeNull();
  const input = document.createElement('input');
  input.click = () => input.dispatchEvent(new Event('cancel'));
  const doc: Pick<Document, 'createElement'> = { createElement: () => input } as Pick<Document, 'createElement'>;
  expect(await browserAbaqusIo(doc, crypto, null).pickIncludes!(['Nodes.inc'])).toBeNull();
});

it('captures the folder and a File snapshot, with scoped traversal and a clear missing-folder error', async () => {
  const files = { 'decks/bar.inp': '*NODE\r\n1,0,0,0\r\n' };
  const folder = await ProjectFolder.fromHandle(fakeDir(files));
  const io = browserAbaqusIo(document, crypto, folder);
  const source = await io.read('decks/bar.inp');
  files['decks/bar.inp'] = 'changed after admission';
  expect(source.name).toBe('bar.inp');
  expect(new TextDecoder().decode(await source.read())).toBe('*NODE\r\n1,0,0,0\r\n');
  await expect(io.read('../bar.inp')).rejects.toMatchObject({ code: 'file.scope' });
  await expect(browserAbaqusIo(document, crypto, null).read('bar.inp')).rejects.toMatchObject({ code: 'file.scope' });
});

it('admits the currently opened folder before a read and keeps that authority if the folder changes', async () => {
  const store = new Store();
  const host = makeHostContext(store, fakeTransport(), { current: null }, readHostCaps({}), undefined, undefined, undefined,
    undefined, undefined, undefined, { projects: {} as never, active: async () => undefined, replay: async () => undefined, captureImport: () => fakeHost().abaqus.capture() });
  const folder = await ProjectFolder.fromHandle(fakeDir({ 'bar.inp': 'admitted folder' }));
  store.set({ folder });
  const captured = host.abaqus.capture();
  store.set({ folder: await ProjectFolder.fromHandle(fakeDir({ 'bar.inp': 'different folder' })) });
  expect(new TextDecoder().decode(await (await captured.io.read('bar.inp')).read())).toBe('admitted folder');
  expect(new TextDecoder().decode(await (await host.abaqus.capture().io.read('bar.inp')).read())).toBe('different folder');
});

it('rejects .odb and oversized Files before arrayBuffer allocates their contents', async () => {
  const odb = new File(['binary'], 'results.ODB');
  const read = vi.spyOn(odb, 'arrayBuffer');
  await expect(readAbaqus({ picker: true }, picker(odb).io)).rejects.toMatchObject({ code: 'unsupported' });
  expect(read).not.toHaveBeenCalled();
  Object.defineProperty(odb, 'name', { value: 'huge.inp' });
  Object.defineProperty(odb, 'size', { value: 16 * 1024 * 1024 + 1 });
  await expect(readAbaqus({ picker: true }, picker(odb).io)).rejects.toMatchObject({ code: 'schema' });
  expect(read).not.toHaveBeenCalled();
});
