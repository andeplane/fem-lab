import type { EngineSchema, JsonSchema, ModelSummary } from '@femlab/registry';
import { describe, expect, it } from 'vitest';
import schema from '../../registry/src/generated/engine.schema.json';
import { materialFieldsFor, materialPhysicsFor } from '../src/ui/materialPhysics';
import { type Defs, type Field, fieldsOf } from '../src/ui/schema';

const doc = schema as unknown as EngineSchema;
const defs: Defs = doc.commands.$defs ?? {};
const material = doc.commands.oneOf.find(v => v.properties['cmd']!.const === 'material.add')! as unknown as JsonSchema;
const fields = fieldsOf(material, defs);
const model = (procedures: string[], loads: ModelSummary['loads'] = [], active: string[] = []) => ({
  steps: procedures.map(procedure => ({ name: procedure, procedure, constraints: [], loads: active, solved: false })), loads,
}) as unknown as ModelSummary;

describe('Material physics presentation', () => {
  it('reads every procedure default from its schema metadata and prioritizes Step physics', () => {
    const expected = {
      static: ['stiffness'], 'static-nonlinear': ['stiffness', 'plasticity'], buckling: ['stiffness'],
      modal: ['stiffness', 'mass'], explicit: ['stiffness', 'mass'], implicit: ['stiffness', 'mass'],
      harmonic: ['stiffness', 'mass'], randomVibration: ['stiffness', 'mass'],
      'heat-steady': ['thermal', 'mass'], 'heat-transient': ['thermal', 'mass'],
    };
    for (const [procedure, selected] of Object.entries(expected)) expect(materialPhysicsFor(model([procedure]), {}, fields, defs)).toEqual(selected);
    expect(materialPhysicsFor(model(['heat-steady']), { E: '1 Pa', nu: 0 }, fields, defs)).toEqual(['thermal', 'mass', 'stiffness']);
    expect(materialPhysicsFor(model(['heat-steady', 'modal']), {}, fields, defs)).toEqual(['thermal', 'mass', 'stiffness']);
  });

  it('adds load physics only for active Loads and derives existing groups without dropping zero values', () => {
    const loads = [{ name: 'weight', kind: 'gravity', summary: '' }, { name: 'warm', kind: 'temperature', summary: '' }, { name: 'force', kind: 'force', summary: '' }];
    expect(materialPhysicsFor(model(['static'], loads), {}, fields, defs)).toEqual(['stiffness']);
    expect(materialPhysicsFor(model(['static'], loads, ['weight', 'warm', 'force']), {}, fields, defs)).toEqual(['stiffness', 'mass', 'expansion']);
    expect(materialPhysicsFor(null, { name: 'steel', nu: 0, rho: null, k: '', cp: undefined, orthotropic: { alpha: ['1 /K', '2 /K', '3 /K'] } }, fields, defs)).toEqual(['stiffness', 'anisotropy', 'expansion']);
    const chained = model(['heat-steady', 'static']);
    chained.steps[1] = { ...chained.steps[1]!, after: 'heat-steady' } as ModelSummary['steps'][number];
    expect(materialPhysicsFor(chained, {}, fields, defs)).toEqual(['thermal', 'mass', 'stiffness', 'expansion']);
    expect(materialPhysicsFor(null, {}, fields, defs)).toEqual(['stiffness']);
    expect(materialPhysicsFor(model(['future']), {}, fields, {})).toEqual(['stiffness']);
  });

  it('groups heat fields first while preserving common fields and required Orthotropic children', () => {
    expect(materialFieldsFor(fields, ['thermal', 'mass', 'stiffness']).map(f => f.path[0])).toEqual(['name', 'k', 'cp', 'rho', 'E', 'nu', 'source']);
    const group = materialFieldsFor(fields, ['thermal', 'anisotropy']).find(f => f.path[0] === 'orthotropic')!;
    expect(group.kind).toBe('object');
    if (group.kind !== 'object') throw new Error('expected group');
    expect(group.fields.map(f => f.path.at(-1))).toEqual(['E1', 'E2', 'E3', 'G12', 'G13', 'G23', 'nu12', 'nu13', 'nu23', 'k']);
    expect(materialFieldsFor(fields, []).map(f => f.path[0])).toEqual(['name', 'source']);
    const untagged: Field = { path: ['other'], label: 'Other', hint: '', required: false, tag: '', kind: 'text' };
    expect(materialFieldsFor([untagged], [])).toEqual([untagged]);
  });
});
