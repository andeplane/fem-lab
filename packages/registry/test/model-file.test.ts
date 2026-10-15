import { describe, expect, it, vi } from 'vitest';
import { MAX_MODEL_FILE_BYTES, Registry, HOST_COMMANDS, HOST_QUERIES, boundedModelFileText, modelFileEncoder, modelFileText, type EngineSchema, type ModelFile } from '../src';
import schema from '../src/generated/runtime-schema';
import { fakeHost } from './fakes';

function file(name: string): ModelFile {
  return {
    format: 'femlab/1', engineVersion: '0', model: { name, idealisation: { kind: 'solid3d' } },
    journal: { entries: [{ seq: 0, hashAfter: 'h', cmd: { cmd: 'model.new', name } }] },
  };
}

describe('the actual ModelFile save encoding', () => {
  it.each([false, true])('measures complete UTF-8 pretty JSON with trailing LF %s at exact boundaries', trailingNewline => {
    const value = file('quote " slash \\ newline\n snow ☃ rocket 🚀');
    const text = modelFileText(value, trailingNewline);
    const actualBytes = new TextEncoder().encode(text).byteLength;
    expect(text).toBe(JSON.stringify(value, null, 2) + (trailingNewline ? '\n' : ''));
    expect(actualBytes).toBeGreaterThan(text.length);
    expect(JSON.parse(text)).toEqual(value);
    expect(boundedModelFileText(value, trailingNewline, actualBytes + 1)).toBe(text);
    expect(boundedModelFileText(value, trailingNewline, actualBytes)).toBe(text);
    expect(() => boundedModelFileText(value, trailingNewline, actualBytes - 1)).toThrow('exceeding');
    expect(modelFileEncoder(trailingNewline)(JSON.stringify(value))).toBe(text);
  });

  it('includes the MCP newline rather than admitting a file one byte over the same limit', () => {
    const value = file('beam');
    const browserBytes = new TextEncoder().encode(modelFileText(value)).byteLength;
    expect(boundedModelFileText(value, false, browserBytes)).toBe(modelFileText(value));
    expect(() => boundedModelFileText(value, true, browserBytes)).toThrow('exceeding');
    expect(modelFileEncoder()(JSON.stringify(value))).toBe(modelFileText(value));
  });

  it('uses actual ECMAScript number text, not serde or compact-size assumptions', () => {
    const value = file('large number');
    value.model.materials = [{ name: 'spring', e: 1e20, nu: 0.3, rho: 1 }];
    const input = JSON.stringify(value).replace('"e":100000000000000000000', '"e":1e20').replace('"rho":1', '"rho":1.0');
    const text = modelFileEncoder()(input);
    expect(text).toContain('"e": 100000000000000000000');
    expect(text).toContain('"rho": 1');
    expect(text).not.toContain('"rho": 1.0');
    expect(text).not.toContain('1e20');
    expect(JSON.parse(text)).toEqual(value);
  });

  it('bounds the Model plus Journal, not a converter response containing just Commands', () => {
    const value = file('Å🚀"\\'.repeat(300));
    const converterBytes = new TextEncoder().encode(JSON.stringify(value.journal.entries.map(entry => entry.cmd))).byteLength;
    expect(() => boundedModelFileText(value, false, converterBytes)).toThrow('exceeding');
    expect(modelFileText(value)).toContain('"model"');
    expect(modelFileText(value)).toContain('"journal"');
  });

  it('refuses oversized real save text before fake file I/O or saved-baseline publication', async () => {
    const host = fakeHost();
    vi.mocked(host.transport.exportFile).mockResolvedValue(file('x'.repeat(MAX_MODEL_FILE_BYTES)));
    const completeSave = host.files.beginSave();
    vi.mocked(host.files.beginSave).mockReturnValue(completeSave);
    const registry = new Registry({ schema: schema as unknown as EngineSchema, host, hostCommands: HOST_COMMANDS, hostQueries: HOST_QUERIES });
    await expect(registry.dispatch({ cmd: 'file.save' })).rejects.toMatchObject({ code: 'schema', where: 'file' });
    expect(host.files.download).not.toHaveBeenCalled();
    expect(host.folder.writeText).not.toHaveBeenCalled();
    expect(completeSave).not.toHaveBeenCalled();
  });
});
