import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { MAX_ABAQUS_BYTES, readAbaqus } from '@femlab/registry';
import { nodeAbaqusIo } from '../src/abaqus-files';

const owned: string[] = [];
const scratch = async () => { const dir = await mkdtemp(path.join(tmpdir(), 'femlab-504-read-')); owned.push(dir); return dir; };
afterEach(async () => { for (const dir of owned.splice(0)) await rm(dir, { recursive: true, force: true }); });

it('reads an exact scoped UTF-8 deck without source paths or line-ending normalization', async () => {
  const root = await scratch();
  await mkdir(path.join(root, 'decks'));
  await writeFile(path.join(root, 'decks/bar.inp'), '\ufeff*NODE\r\n1,0,0,0\r\n');
  const io = nodeAbaqusIo(root);
  const source = await readAbaqus({ path: './decks/bar.inp' }, io);
  expect(source).toMatchObject({ text: '\ufeff*NODE\r\n1,0,0,0\r\n' });
  expect(Object.keys(source!)).toEqual(['text', 'sha256']);
  expect(await io.sha256(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

it('refuses a missing authority, picker, escape, directory and linked input', async () => {
  await expect(nodeAbaqusIo(undefined).read('bar.inp')).rejects.toMatchObject({ code: 'file.scope' });
  await expect(nodeAbaqusIo(undefined).pick()).rejects.toMatchObject({ code: 'unsupported' });
  const root = await scratch();
  const outside = await scratch();
  await writeFile(path.join(outside, 'bar.inp'), '*NODE');
  await symlink(outside, path.join(root, 'linked'));
  await symlink(path.join(outside, 'bar.inp'), path.join(root, 'bar.inp'));
  await mkdir(path.join(root, 'directory.inp'));
  const io = nodeAbaqusIo(root);
  await expect(io.read('../bar.inp')).rejects.toMatchObject({ code: 'file.scope' });
  await expect(io.read('linked/bar.inp')).rejects.toMatchObject({ code: 'file.scope' });
  await expect(io.read('bar.inp')).rejects.toMatchObject({ code: 'file.scope' });
  await expect(io.read('directory.inp')).rejects.toMatchObject({ code: 'file.scope' });
});

it('bounds a file that grows after metadata admission and rechecks path authority before reading', async () => {
  const root = await scratch();
  const full = path.join(root, 'bar.inp');
  await writeFile(full, '*NODE');
  const io = nodeAbaqusIo(root);
  const source = await io.read('bar.inp');
  await writeFile(full, new Uint8Array(MAX_ABAQUS_BYTES + 2));
  expect((await source.read()).byteLength).toBe(MAX_ABAQUS_BYTES + 1);
  await expect(readAbaqus({ path: 'bar.inp' }, { ...io, read: async () => source })).rejects.toMatchObject({ code: 'schema' });
  await rm(full);
  await symlink(path.join(root, 'missing.inp'), full);
  await expect(source.read()).rejects.toMatchObject({ code: 'file.scope' });
});
