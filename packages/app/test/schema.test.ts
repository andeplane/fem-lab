// The Properties form is generated from the engine's schema, so the test walks the whole schema:
// if a Command grows a shape the form cannot read, this fails before a person meets it.
import type { EngineSchema, JsonSchema } from '@femlab/registry';
import { describe, expect, it } from 'vitest';
import schema from '../../registry/src/generated/engine.schema.json';
import { applyLabel, blockers, commandLine, defaultFormValues, type Defs, type Field, dimensionTag, fieldsOf, getAt, humanise, parseQuantity, resolve, setAt, siUnit, step, tsValue } from '../src/ui/schema';

const doc = schema as unknown as EngineSchema;
const DEFS: Defs = { ...doc.commands.$defs, ...doc.queries.$defs };
const variants = doc.commands.oneOf as unknown as JsonSchema[];
const byName = (name: string): JsonSchema => variants.find((v) => (v['properties'] as Record<string, { const?: string }>)['cmd']?.const === name)!;

const flat = (fields: Field[]): Field[] => fields.flatMap((f) => (f.kind === 'object' ? [f, ...flat(f.fields)] : f.kind === 'union' ? [f, ...flat(f.variants.flatMap((v) => v.fields))] : [f]));

describe('fieldsOf', () => {
  it('renders a field list for every Command in the schema, with no `json` fallback at the top level', () => {
    for (const v of variants) {
      const name = (v['properties'] as Record<string, { const?: string }>)['cmd']!.const!;
      const fields = fieldsOf(v, DEFS);
      expect(fields.every((f) => f.path.length === 1), name).toBe(true);
      // `plugin.load`'s `manifest` is deliberately free-form JSON; nothing else may be.
      expect(fields.filter((f) => f.kind === 'json').map((f) => `${name}.${f.path.join('.')}`)).toEqual(name === 'plugin.load' ? ['plugin.load.manifest'] : []);
    }
  });

  it('reads a quantity through its $ref chain, with the dimension and the SI unit', () => {
    const [name, on, value] = fieldsOf(byName('load.pressure'), DEFS);
    expect(name).toMatchObject({ kind: 'text', label: 'Name', required: true });
    expect(on).toMatchObject({ kind: 'ref', refKind: 'set', multi: false });
    expect(value).toMatchObject({ kind: 'quantity', dimension: 'stress', parts: 1, tag: 'stress · M L⁻¹ T⁻²' });
  });

  it('reads a fixed-length array of quantities as one field with its part count', () => {
    const size = fieldsOf(byName('geometry.addBox'), DEFS).find((f) => f.path[0] === 'size')!;
    expect(size).toMatchObject({ kind: 'quantity', dimension: 'length', parts: 3 });
  });

  it('reads a tagged union as a kind selector with one sub-form per kind', () => {
    const mesher = fieldsOf(byName('mesh.set'), DEFS).find((f) => f.path[0] === 'mesher')!;
    expect(mesher.kind).toBe('union');
    if (mesher.kind !== 'union') throw new Error('unreachable');
    expect(mesher.variants.map((v) => v.kind)).toEqual(['lattice', 'mapped', 'free', 'sweep']);
    // `LatticeSize` is a length or three counts; the form offers the length.
    expect(mesher.variants[0]!.fields[0]).toMatchObject({ kind: 'quantity', dimension: 'length', path: ['mesher', 'size'] });
  });

  it('reads an enum as options and a list of names as a multi picker', () => {
    const fields = fieldsOf(byName('step.add'), DEFS);
    expect(fields.find((f) => f.path[0] === 'procedure')).toMatchObject({ kind: 'enum', options: ['static', 'modal', 'heat-steady', 'heat-transient', 'explicit'], multi: false });
    expect(fields.find((f) => f.path[0] === 'constraints')).toMatchObject({ kind: 'ref', refKind: 'constraint', multi: true });
    expect(fields.find((f) => f.path[0] === 'output')).toMatchObject({ kind: 'enum', multi: true });
  });

  it('unwraps an optional and keeps its dimension', () => {
    const rho = fieldsOf(byName('material.add'), DEFS).find((f) => f.path[0] === 'rho')!;
    expect(rho).toMatchObject({ kind: 'quantity', dimension: 'density', required: false });
  });

  it('renders a nested object as a group of its own fields', () => {
    const units = fieldsOf(byName('model.setUnits'), DEFS).find((f) => f.path[0] === 'units')!;
    expect(units.kind).toBe('object');
    expect(flat([units]).map((f) => f.path.join('.'))).toContain('units.stress');
  });

  it('stops recursing where the schema is recursive, rather than looping forever', () => {
    const shape = fieldsOf(byName('geometry.add'), DEFS).find((f) => f.path[0] === 'shape')!;
    expect(shape.kind).toBe('union');
    expect(flat([shape]).length).toBeGreaterThan(5);
  });

  it('follows a $ref chain and keeps the referring node\'s own keywords', () => {
    expect(resolve({ $ref: '#/$defs/Q_force', title: 'mine' }, DEFS)).toMatchObject({ title: 'mine', 'x-dimension': 'force' });
    // A self-referential $ref returns rather than hanging.
    expect(resolve({ $ref: '#/$defs/Loop' }, { Loop: { $ref: '#/$defs/Loop' } })).toEqual({ $ref: '#/$defs/Loop' });
  });
});

describe('quantities', () => {
  it('names the SI unit and the dimension the design puts opposite the label', () => {
    expect(siUnit('stress')).toBe('Pa');
    expect(siUnit('nonsense')).toBe('');
    expect(dimensionTag('length')).toBe('length · L');
    expect(dimensionTag('force')).toBe('force · M L T⁻²');
    expect(dimensionTag('dimensionless')).toBe('dimensionless · 1');
    expect(dimensionTag('nonsense')).toBe('nonsense');
  });

  it('parses text and parts alike, and refuses what is neither', () => {
    expect(parseQuantity('2.4 MPa')).toEqual({ value: 2.4, unit: 'MPa' });
    expect(parseQuantity('-1e3 N')).toEqual({ value: -1000, unit: 'N' });
    expect(parseQuantity({ value: 3, unit: 'm' })).toEqual({ value: 3, unit: 'm' });
    expect(parseQuantity({ value: 'x' })).toBeNull();
    expect(parseQuantity('banana')).toBeNull();
  });

  it('steps by ten per cent and keeps the unit', () => {
    expect(step('100 mm', 1)).toBe('110 mm');
    expect(step('100 mm', -1)).toBe('90 mm');
    expect(step('0', 1)).toBe('0.1');
    expect(step('banana', 1)).toBe('banana');
  });
});

describe('the recorded-as line', () => {
  it('is the engine\'s own script line, keys unquoted where they can be', () => {
    expect(commandLine({ cmd: 'geometry.addBox', name: 'beam', size: ['1 m', '100 mm', '100 mm'] })).toBe('await fem.geometry.addBox({ name: "beam", size: ["1 m", "100 mm", "100 mm"] });');
    expect(commandLine({ cmd: 'journal.undo' })).toBe('await fem.journal.undo();');
    // A nameless object degrades exactly as the Rust `splitn(2, '.')` does, rather than throwing.
    expect(commandLine({})).toBe('await fem.?.();');
    expect(tsValue({ 'not-an-id': 1, ok: null })).toBe('{ "not-an-id": 1, ok: null }');
    expect(tsValue(undefined)).toBe('');
  });
});

describe('paths and labels', () => {
  it('keeps an untouched optional tagged union absent, but defaults it once present', () => {
    const optional: Field = {
      kind: 'union',
      path: ['choice'],
      label: 'Choice',
      hint: '',
      required: false,
      tag: 'kind',
      variants: [{ kind: 'first', fields: [] }],
    };
    expect(defaultFormValues({}, [optional])).toEqual({});
    expect(defaultFormValues({ choice: {} }, [optional])).toEqual({ choice: { kind: 'first' } });
  });

  it('sets and reads nested values, and removes a key when the value goes away', () => {
    expect(setAt({}, ['mesher', 'size'], '25 mm')).toEqual({ mesher: { size: '25 mm' } });
    expect(getAt({ mesher: { size: '25 mm' } }, ['mesher', 'size'])).toBe('25 mm');
    expect(getAt({}, ['a', 'b'])).toBeUndefined();
    expect(setAt({ a: 1, b: 2 }, ['a'], '')).toEqual({ b: 2 });
    expect(setAt({ a: [1] }, ['a'], [])).toEqual({ a: [] });
    expect(setAt({ a: 1 }, [], 2)).toEqual({ a: 1 });
  });

  it('humanises a property name without mangling the physicist\'s', () => {
    expect(humanise('maxIterations')).toBe('Max iterations');
    expect(humanise('thermal_expansion')).toBe('Thermal expansion');
    expect(humanise('nu')).toBe('nu');
  });

  it('says what the primary button will do', () => {
    expect(applyLabel('geometry.addBox')).toBe('Add body');
    expect(applyLabel('load.traction')).toBe('Add load');
    expect(applyLabel('load.remove')).toBe('Remove');
    expect(applyLabel('study.converge')).toBe('Converge');
  });
});

describe('blockers', () => {
  it('maps the engine\'s warning names onto the design\'s W-codes, in order', () => {
    const list = blockers(
      [
        { code: 'model.no-step', text: 'no analysis step' },
        { code: 'model.no-material', text: "Body 'beam' has no material", where: "body 'beam'" },
      ],
      true,
      true,
    );
    expect(list.map((b) => b.code)).toEqual(['W-1101', 'W-1500']);
    expect(list[0]).toMatchObject({ fixCmd: 'material.assign', where: "body 'beam'" });
  });

  it('adds W-1200 when there are bodies but no mesh settings, and nothing when there are no bodies', () => {
    expect(blockers([], false, true).map((b) => b.code)).toEqual(['W-1200']);
    expect(blockers([], false, false)).toEqual([]);
    expect(blockers([], true, true)).toEqual([]);
  });

  it('keeps an unmapped engine warning rather than dropping it', () => {
    expect(blockers([{ code: 'mesh.inverted', text: '3 inverted elements' }], true, true)[0]).toMatchObject({ code: 'mesh.inverted', text: '3 inverted elements', fixCmd: '' });
  });
});
