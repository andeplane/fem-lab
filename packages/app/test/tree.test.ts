// The Model tree is a pure reading of one `query.model` snapshot, so a fixture is enough:
// the groups, their badges, the one-line summaries in display units, and the Command each row
// puts back in the form (an edit is the create Command re-issued, brief §2.1).
import type { ModelSummary } from '@femlab/registry';
import { describe, expect, it } from 'vitest';
import { Store, initialState, type UiState } from '../src/store';
import { treeGroups } from '../src/ui/Tree';

const v = (value: number, unit: string) => ({ value, unit });

const MODEL = {
  name: 'cantilever',
  revision: 9,
  hash: 'h',
  units: { length: 'mm', force: 'kN', stress: 'MPa' },
  idealisation: 'solid3d',
  bodies: [{ name: 'beam', material: 'steel', bbox: [v(0, 'mm'), v(0, 'mm'), v(0, 'mm'), v(1000, 'mm'), v(100, 'mm'), v(100, 'mm')], measure: v(1e7, 'mm^3'), faces: ['beam.xmin', 'beam.xmax'] }],
  materials: [{ name: 'steel', E: v(210_000, 'MPa'), nu: 0.3, rho: v(7850, 'kg/m^3'), assignedTo: ['beam'] }],
  sets: [{ name: 'tip_face', kind: 'face', summary: 'rule: x == 1000 mm' }],
  constraints: [{ name: 'root', on: 'beam.xmin', summary: 'fix ux, uy, uz' }],
  loads: [{ name: 'tip', kind: 'traction', on: 'beam.xmax', summary: 'total [0, 0, -1] kN' }],
  steps: [
    { name: 'uls', procedure: 'static', constraints: ['root'], loads: ['tip'], solved: true },
    { name: 'sls', procedure: 'static', constraints: ['root'], loads: ['tip'], solved: false },
  ],
  meshSettings: { mesher: { kind: 'lattice', size: v(25, 'mm') }, order: 1, formulation: 'incompatible-modes' },
  warnings: [],
} as unknown as ModelSummary;

const state = (model: ModelSummary | null): UiState => ({ ...initialState, model });
const group = (s: UiState, label: string) => treeGroups(s).find((g) => g.label === label)!;

describe('treeGroups', () => {
  it('lists the design\'s eight groups in workflow order, even with no Model at all', () => {
    expect(treeGroups(state(null)).map((g) => g.label)).toEqual(['Geometry', 'Materials', 'Mesh', 'Constraints', 'Loads', 'Steps', 'Results', 'Plugins']);
    for (const g of treeGroups(state(null))) {
      expect(g.items).toEqual([]);
      expect(g.badge).toBe('—');
      expect(g.note.length).toBeGreaterThan(20);
    }
    // Every group a person can add to offers the Command that adds to it.
    expect(treeGroups(state(null)).filter((g) => g.add).map((g) => g.add!.cmd)).toEqual(['geometry.addBox', 'material.add', 'mesh.set', 'constraint.fix', 'load.pressure', 'step.add']);
  });

  it('puts bodies and named faces in Geometry, with their glyphs and summaries', () => {
    const g = group(state(MODEL), 'Geometry');
    expect(g.items.map((i) => [i.glyph, i.name])).toEqual([
      ['◈', 'beam'],
      ['▣', 'tip_face'],
    ]);
    expect(g.items[0]!.summary).toBe('10000000 mm^3 · 2 faces · steel');
    expect(g.items[0]!.select).toEqual({ bodies: ['beam'] });
    expect(g.items[0]!.remove).toBe('geometry.remove');
  });

  it('reads a Body\'s size and position back out of its bounding box, so a click can edit it', () => {
    expect(group(state(MODEL), 'Geometry').items[0]).toMatchObject({
      cmd: 'geometry.addBox',
      args: { name: 'beam', size: ['1000 mm', '100 mm', '100 mm'], at: ['0 mm', '0 mm', '0 mm'] },
    });
  });

  it('survives a Model whose bounding box is not there yet', () => {
    const g = group(state({ ...MODEL, bodies: [{ ...MODEL.bodies[0]!, bbox: [] as never }] }), 'Geometry');
    expect((g.items[0]!.args as { size: string[] }).size).toEqual(['', '', '']);
  });

  it('summarises materials, constraints, loads, the mesh and the steps in display units', () => {
    const s = state(MODEL);
    expect(group(s, 'Materials').items[0]!.summary).toBe('E 210000 MPa · ν 0.3 · ρ 7850 kg/m^3 · on beam');
    expect(group(s, 'Materials').items[0]!.args).toEqual({ name: 'steel', E: '210000 MPa', nu: 0.3, rho: '7850 kg/m^3' });
    expect(group(s, 'Constraints').items[0]!.summary).toBe('fix ux, uy, uz on beam.xmin');
    expect(group(s, 'Loads').items[0]).toMatchObject({ cmd: 'load.traction', summary: 'total [0, 0, -1] kN on beam.xmax' });
    expect(group(s, 'Mesh').items[0]!.summary).toBe('lattice · order 1 · incompatible-modes');
    expect(group(s, 'Steps').items[0]!.summary).toBe('static · 1 constraints · 1 loads · solved');
  });

  it('badges a group as ok, as warning, or as empty', () => {
    const s = state(MODEL);
    expect(group(s, 'Geometry').badge).toBe('ok');
    expect(group(s, 'Results').badge).toBe('ok');
    expect(group(s, 'Plugins').badge).toBe('—');
    const warned = state({ ...MODEL, warnings: [{ code: 'model.no-material', text: 'x', where: null }, { code: 'model.unloaded', text: 'y', where: null }] } as ModelSummary);
    expect(group(warned, 'Materials')).toMatchObject({ badge: '1 warning', badgeClass: 'badge warn' });
    expect(group(warned, 'Loads').badge).toBe('1 warning');
  });

  it('warns on Mesh when there are Bodies but no mesh settings, which no engine warning covers', () => {
    const s = state({ ...MODEL, meshSettings: null } as ModelSummary);
    expect(group(s, 'Mesh').badge).toBe('1 warning');
    expect(group(state({ ...MODEL, bodies: [], meshSettings: null } as unknown as ModelSummary), 'Mesh').badge).toBe('—');
  });

  it('marks the row whose Command the Properties panel is showing', () => {
    const store = new Store();
    store.set({ model: MODEL });
    store.openForm('geometry.addBox', { name: 'beam' });
    expect(store.state.form!.values['name']).toBe('beam');
    expect(group(store.state, 'Geometry').items[0]!.name).toBe('beam');
  });
});
