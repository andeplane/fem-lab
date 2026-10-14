import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AbaqusImport, MAX_ABAQUS_BYTES, readAbaqus, type AbaqusFile, type AbaqusIo } from '../src/abaqus-import';

const encode = (text: string) => new TextEncoder().encode(text);
const file = (name = 'beam.inp', bytes = encode('*NODE\r\n1,0,0,0\r\n')): AbaqusFile => ({ name, size: bytes.byteLength, read: vi.fn(async () => bytes) });
const io = (picked: AbaqusFile | null = file()): AbaqusIo => ({
  pick: vi.fn(async () => picked),
  read: vi.fn(async () => picked!),
  sha256: vi.fn(async bytes => createHash('sha256').update(bytes).digest('hex')),
});

describe('Abaqus host byte admission', () => {
  it('requires explicit mode/source/length and static force without guessing units or discarding ambiguous input', () => {
    const base = { name: 'bar', body: 'bar', mode: 'mesh', unitLength: '1 mm' };
    for (const source of [{ text: '*NODE' }, { picker: true }, { path: 'bar.inp' }]) {
      expect(AbaqusImport.parse({ ...base, ...source })).toEqual({ ...base, ...source });
      expect(AbaqusImport.parse({ ...base, ...source, mode: 'static', unitForce: { value: 1, unit: 'N' } })).toEqual({ ...base, ...source, mode: 'static', unitForce: { value: 1, unit: 'N' } });
      const missingForce = AbaqusImport.safeParse({ ...base, ...source, mode: 'static' });
      expect(missingForce.success).toBe(false);
      expect(missingForce.error!.issues[0]!.path).toEqual(['unitForce']);
    }
    expect(AbaqusImport.safeParse({ ...base, text: '*NODE', picker: true }).success).toBe(false);
    expect(AbaqusImport.safeParse({ ...base, text: '*NODE', path: 'bar.inp' }).success).toBe(false);
    expect(AbaqusImport.safeParse({ ...base, text: '*NODE', unitLength: undefined }).success).toBe(false);
    expect(AbaqusImport.safeParse({ ...base, text: '*NODE', mode: undefined }).success).toBe(false);
    expect(AbaqusImport.safeParse(base).success).toBe(false);
    // Mesh force rejection and quantity dimension/positivity belong to the authoritative
    // converter. The host preserves supplied Quantities so those errors are never hidden.
    expect(AbaqusImport.parse({ ...base, text: '*NODE', unitForce: '1 N', unitLength: '-1 m' })).toMatchObject({ unitForce: '1 N', unitLength: '-1 m' });
  });
  it('hashes exact inline UTF-8 and preserves CRLF and a BOM for the converter to validate', async () => {
    const text = '\ufeff*HEADING\r\nÅngström\r\n';
    const host = io();
    expect(await readAbaqus({ text }, host)).toEqual({ text, sha256: createHash('sha256').update(text).digest('hex') });
    expect(host.pick).not.toHaveBeenCalled();
    expect(host.read).not.toHaveBeenCalled();
  });

  it('reads a selected file once, preserves source bytes, and takes a private snapshot before digest awaits', async () => {
    const bytes = encode('*NODE\r\n1,0,0,0\r\n');
    const picked = file('beam.inp', bytes);
    const host = io(picked);
    host.sha256 = vi.fn(async snapshot => {
      bytes.fill(0);
      return createHash('sha256').update(snapshot).digest('hex');
    });
    expect(await readAbaqus({ picker: true }, host)).toEqual({ text: '*NODE\r\n1,0,0,0\r\n', sha256: createHash('sha256').update('*NODE\r\n1,0,0,0\r\n').digest('hex') });
    expect(picked.read).toHaveBeenCalledTimes(1);
  });

  it('normalizes only the scoped path and rejects escape before I/O', async () => {
    const host = io();
    expect(await readAbaqus({ path: './decks\\beam.inp' }, host)).toMatchObject({ text: '*NODE\r\n1,0,0,0\r\n' });
    expect(host.read).toHaveBeenCalledWith('decks/beam.inp');
    await expect(readAbaqus({ path: '../beam.inp' }, host)).rejects.toMatchObject({ code: 'file.scope' });
    expect(host.read).toHaveBeenCalledTimes(1);
  });

  it('treats picker cancellation as no input and performs no read or digest', async () => {
    const host = io(null);
    expect(await readAbaqus({ picker: true }, host)).toBeNull();
    expect(host.sha256).not.toHaveBeenCalled();
  });

  it.each(['BEAM.ODB', 'model.cae'])('rejects unsupported %s before reading bytes', async name => {
    const picked = file(name);
    const host = io(picked);
    await expect(readAbaqus({ picker: true }, host)).rejects.toMatchObject({ code: 'unsupported', where: 'path' });
    expect(picked.read).not.toHaveBeenCalled();
    expect(host.sha256).not.toHaveBeenCalled();
  });

  it.each([MAX_ABAQUS_BYTES + 1, -1, 0.5, Number.NaN])('rejects invalid or oversized metadata %s before reading', async size => {
    const picked = { ...file(), size };
    await expect(readAbaqus({ picker: true }, io(picked))).rejects.toMatchObject({ code: 'schema', where: 'text' });
    expect(picked.read).not.toHaveBeenCalled();
  });

  it('checks actual byte length even when metadata lies, and admits the exact byte ceiling', async () => {
    const host = io({ ...file('x.inp', new Uint8Array(MAX_ABAQUS_BYTES + 1)), size: 0 });
    await expect(readAbaqus({ picker: true }, host)).rejects.toMatchObject({ code: 'schema' });
    expect(host.sha256).not.toHaveBeenCalled();
    const exact = 'x'.repeat(MAX_ABAQUS_BYTES);
    expect(await readAbaqus({ text: exact }, io())).toMatchObject({ text: exact });
  });

  it('bounds inline text before allocation and after multi-byte encoding', async () => {
    await expect(readAbaqus({ text: 'x'.repeat(MAX_ABAQUS_BYTES + 1) }, io())).rejects.toMatchObject({ code: 'schema' });
    await expect(readAbaqus({ text: 'é'.repeat(MAX_ABAQUS_BYTES / 2 + 1) }, io())).rejects.toMatchObject({ code: 'schema' });
  });

  it('rejects invalid UTF-8 and inline Unicode rather than hashing a repaired deck', async () => {
    const host = io(file('x.inp', new Uint8Array([0xc3, 0x28])));
    await expect(readAbaqus({ picker: true }, host)).rejects.toMatchObject({ code: 'schema', cause: 'Abaqus input is not valid UTF-8 text' });
    expect(host.sha256).not.toHaveBeenCalled();
    await expect(readAbaqus({ text: '\ud800' }, io())).rejects.toMatchObject({ code: 'schema', cause: 'Abaqus inline text contains an invalid Unicode surrogate' });
  });

  it('propagates read and digest failures without substituting another source', async () => {
    const picked = file();
    picked.read = vi.fn(async () => { throw new Error('read failed'); });
    const host = io(picked);
    await expect(readAbaqus({ picker: true }, host)).rejects.toThrow('read failed');
    expect(host.sha256).not.toHaveBeenCalled();
    host.sha256 = vi.fn(async () => { throw new Error('digest failed'); });
    await expect(readAbaqus({ text: '*NODE' }, host)).rejects.toThrow('digest failed');
  });
});
