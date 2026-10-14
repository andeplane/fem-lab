import type { MaterialRow, ModelSummary } from '@femlab/registry';
import { describe, expect, it } from 'vitest';
import { materialPickerSummary, materialProperties } from '../src/ui/materialSummary';

const value = (value: number, unit = 'MPa') => ({ value, unit });
const orthotropic: NonNullable<MaterialRow['orthotropic']> = {
  E1: value(100_000), E2: value(10_000), E3: value(10_000), G12: value(5_000), G13: value(5_000), G23: value(5_000),
  nu12: 0.2, nu13: 0.2, nu23: 0.3,
};
const model = (procedure: string): ModelSummary => ({
  name: 'usage', revision: 0, hash: 'h', units: { length: 'm', stress: 'Pa', force: 'N' }, idealisation: 'solid3d',
  bodies: [], materials: [], sets: [], constraints: [], connections: [], points: [], loads: [],
  steps: [{ name: 'analysis', procedure, loads: [], constraints: [], solved: false }], warnings: [],
});
const used = (material: MaterialRow, summary: ModelSummary) => materialProperties(material, summary).filter((property) => property.usedBy?.length).map((property) => property.key);

describe('material summaries', () => {
  it('reports every orthotropic constant and uses E1 in its picker hint', () => {
    const material: MaterialRow = { name: 'wood', orthotropic, alpha: value(1e-5, '1/K'), assignedTo: [] };
    expect(materialProperties(material).map((property) => property.text)).toEqual([
      'E1 100000 MPa', 'E2 10000 MPa', 'E3 10000 MPa', 'G12 5000 MPa', 'G13 5000 MPa', 'G23 5000 MPa',
      'ν12 0.2', 'ν13 0.2', 'ν23 0.3', 'α 0.00001 1/K',
    ]);
    expect(materialPickerSummary(material)).toBe('E1 100000 MPa');
  });

  it('keeps isotropic stiffness first and falls back to density or an empty description', () => {
    expect(materialPickerSummary({ name: 'steel', E: value(210000), k: value(50, 'W/(m K)'), assignedTo: [] })).toBe('E 210000 MPa');
    expect(materialPickerSummary({ name: 'mass', rho: value(7200, 'kg/m^3'), assignedTo: [] })).toBe('ρ 7200 kg/m^3');
    expect(materialPickerSummary({ name: 'empty', assignedTo: [] })).toBe('no properties');
    expect(materialProperties({ name: 'empty', assignedTo: [] })).toEqual([]);
  });

  it('retains distinct material-axis conductivity in the picker', () => {
    expect(materialPickerSummary({ name: 'axes', k: [value(1, 'W/(m K)'), value(2, 'W/(m K)'), value(3, 'W/(m K)')], assignedTo: [] })).toBe('k [1 W/(m K), 2 W/(m K), 3 W/(m K)]');
  });

  it('emphasizes the thermal properties each heat procedure reads while preserving stiffness', () => {
    const material: MaterialRow = { name: 'slab', E: value(200000), nu: 0.3, rho: value(7200, 'kg/m^3'), k: value(35, 'W/(m K)'), cp: value(440.5, 'J/(kg K)'), source: 'measured', assignedTo: ['bar'] };
    expect(used(material, model('heat-steady'))).toEqual(['k']);
    expect(used(material, model('heat-transient'))).toEqual(['rho', 'k', 'cp']);
    expect(used(material, model('static'))).toEqual(['E', 'nu']);
    expect(used(material, model('modal'))).toEqual(['E', 'nu', 'rho']);
    expect(used({ ...material, assignedTo: [] }, model('heat-transient'))).toEqual([]);
    expect(used(material, model('future-procedure'))).toEqual([]);
    expect(materialProperties(material, model('heat-transient')).filter((property) => property.usedBy?.length).every((property) => property.usedBy?.[0] === 'analysis')).toBe(true);
  });

  it('emphasizes material axes for anisotropic conductivity and mechanical stiffness', () => {
    const material: MaterialRow = { name: 'axes', orthotropic, orientation: { axis: [0, 0, 1], degrees: 30 }, k: [value(1, 'W/(m K)'), value(2, 'W/(m K)'), value(3, 'W/(m K)')], assignedTo: ['bar'] };
    expect(used(material, model('heat-steady'))).toEqual(['orientation', 'k']);
    expect(used(material, model('static'))).toEqual(['E1', 'E2', 'E3', 'G12', 'G13', 'G23', 'nu12', 'nu13', 'nu23', 'orientation']);
    expect(used({ ...material, k: value(1, 'W/(m K)') }, model('heat-steady'))).toEqual(['k']);
  });

  it('emphasizes density for active gravity and plasticity only for the nonlinear law', () => {
    const material: MaterialRow = { name: 'steel', E: value(200000), nu: 0.3, rho: value(7850, 'kg/m^3'), yield: value(355), assignedTo: ['bar'] };
    const summary = { ...model('static'), loads: [{ name: 'gravity', kind: 'gravity', summary: 'g = 9.81 m/s^2' }] };
    expect(used(material, summary)).toEqual(['E', 'nu']);
    summary.steps[0]!.loads = ['gravity'];
    expect(used(material, summary)).toEqual(['E', 'nu', 'rho']);
    expect(used(material, model('static-nonlinear'))).toEqual(['E', 'nu']);
    expect(used({ ...material, plasticity: true }, model('static-nonlinear'))).toEqual(['E', 'nu', 'yield', 'plasticity']);
  });
});
