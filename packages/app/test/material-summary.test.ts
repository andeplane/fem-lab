import type { MaterialRow } from '@femlab/registry';
import { describe, expect, it } from 'vitest';
import { materialPickerSummary, materialProperties } from '../src/ui/materialSummary';

const value = (value: number, unit = 'MPa') => ({ value, unit });
const orthotropic: NonNullable<MaterialRow['orthotropic']> = {
  E1: value(100_000), E2: value(10_000), E3: value(10_000), G12: value(5_000), G13: value(5_000), G23: value(5_000),
  nu12: 0.2, nu13: 0.2, nu23: 0.3,
};

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
});
