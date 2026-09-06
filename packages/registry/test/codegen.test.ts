import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { femDts, mergeSchema } from '../../../tools/codegen.mjs';
import schema from '../src/generated/engine.schema.json';

const root = path.resolve(import.meta.dirname, '../../..');

describe('codegen', () => {
  it('--check passes on the committed output', () => {
    expect(() => execFileSync(process.execPath, [path.join(root, 'tools/codegen.mjs'), '--check'], { stdio: 'pipe' })).not.toThrow();
  });

  it('--check fails on a schema that differs from the committed one', () => {
    const doc = structuredClone(schema) as { commands: { oneOf: unknown[] } };
    doc.commands.oneOf.pop();
    const tmp = path.join(tmpdir(), `femlab-codegen-check-${process.pid}.json`);
    let out = 0;
    // written directly: the schema is far past Linux's 128 KB per-argument limit
    writeFileSync(tmp, JSON.stringify(doc));
    try {
      execFileSync(process.execPath, [path.join(root, 'tools/codegen.mjs'), '--check', '--from', tmp], { stdio: 'pipe' });
    } catch (e) {
      out = (e as { status: number }).status;
    } finally {
      rmSync(tmp, { force: true });
    }
    expect(out).toBe(1);
  });

  it('merges the six schemas into one $defs table, renaming only the conflicting defs', () => {
    const merged = mergeSchema(schema) as { $defs: Record<string, unknown>; required: string[] };
    expect(merged.required).toEqual(['commands', 'queries', 'queryResult', 'ack', 'error', 'modelFile']);
    for (const t of ['Command', 'Query', 'QueryResult', 'Ack', 'EngineError', 'ModelFile', 'Quantity', 'ModelSummary']) expect(merged.$defs).toHaveProperty(t);
    expect(Object.keys(merged.$defs).filter((k) => /^[A-Z]\w+_[A-Z]/.test(k)).sort()).toEqual([
      'ModelFile_Command', 'ModelFile_FacePredicate', 'ModelFile_JournalEntry', 'ModelFile_RegionPredicate',
      'QueryResult_JournalEntry', 'Query_Command',
    ]);
    for (const [entry, command] of [['JournalEntry', 'Query_Command'], ['ModelFile_JournalEntry', 'ModelFile_Command'], ['QueryResult_JournalEntry', 'Command']]) {
      expect(merged.$defs[entry!]).toMatchObject({ properties: { cmd: { $ref: `#/$defs/${command}` } } });
    }
    expect(Object.keys(merged.$defs).filter((k) => k === 'Error')).toEqual([]);
    // a table's own $defs entry named like the table's type is a real collision
    expect(() => mergeSchema({ ...schema, commands: { ...schema.commands, $defs: { ...schema.commands.$defs, Command: { type: 'null' } } } })).toThrow(/collides/);
    // same-named but different defs in a later table are prefixed, not fatal
    const renamed = mergeSchema({ ...schema, error: { ...schema.error, $defs: { Ack: { type: 'null' } } } }) as { $defs: Record<string, unknown> };
    expect(renamed.$defs).toHaveProperty('EngineError_Ack');
  });

  it('fem.d.ts has one method per Command and Query with the right arity', () => {
    const dts = femDts(schema) as string;
    expect(dts).toBe(readFileSync(path.join(root, 'packages/registry/src/generated/fem.d.ts'), 'utf8'));
    for (const v of schema.commands.oneOf) expect(dts).toContain(`{ cmd: '${v.properties.cmd.const}' }>, 'cmd'>): Promise<Ack>;`);
    for (const v of schema.queries.oneOf) expect(dts).toContain(`Promise<${v['x-returns']}>;`);
    expect(dts).toContain('model(): Promise<ModelSummary>;');
    expect(dts).toContain("undo(args?: Omit<Extract<Command, { cmd: 'journal.undo' }>, 'cmd'>): Promise<Ack>;");
    expect(dts).toContain("addBox(args: Omit<Extract<Command, { cmd: 'geometry.addBox' }>, 'cmd'>): Promise<Ack>;");
    // `new(args)` alone would be a construct signature, so the member is quoted.
    expect(dts).toContain('"new"(args: Omit<Extract<Command, { cmd: \'model.new\' }>, \'cmd\'>): Promise<Ack>;');
    expect(dts).not.toMatch(/^ {4}new\(/m);
  });
});
