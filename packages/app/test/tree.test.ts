// The Model tree is a pure reading of one `query.model` snapshot, so a fixture is enough:
// the groups, their badges, the one-line summaries in display units, and the Command each row
// puts back in the form (an edit is the create Command re-issued, brief §2.1).
import schema from '../../registry/src/generated/engine.schema.json';
import { humanise } from '../src/ui/schema';
import { parseRef, type ModelSummary } from '@femlab/registry';
import { describe, expect, it } from 'vitest';
import { Store, initialState, type UiState } from '../src/store';
import { reorderSteps, shapeMenu, treeGroups } from '../src/ui/Tree';

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
  connections: [{ name: 'weld', kind: 'bonded', master: 'beam.xmax', slave: 'plate.xmin', summary: 'bonded, pairing within 0.1 mm' }],
  loads: [{ name: 'tip', kind: 'traction', on: 'beam.xmax', summary: 'total [0, 0, -1] kN' }],
  steps: [
    { name: 'uls', procedure: 'static', constraints: ['root'], loads: ['tip'], solved: true },
    { name: 'sls', procedure: 'static', constraints: ['root'], loads: ['tip'], solved: false },
  ],
  meshSettings: { mesher: { kind: 'lattice', size: v(25, 'mm') }, order: 1, formulation: 'incompatible-modes' },
  warnings: [],
} as unknown as ModelSummary;

/** Enough of `query.result` for the Results group: one contourable field on one Step. */
const RESULT = {
  resultId: 'result-7',
  step: 'uls',
  revision: 9,
  stale: false,
  solver: 'cpu-direct',
  iterations: 1,
  residual: 0,
  timeMs: 1,
  extremes: [{ field: 'vonMises', component: 0, min: v(0, 'MPa'), minAt: [], max: v(12.4, 'MPa'), maxAt: [] }],
  reactions: [],
  appliedTotal: [v(0, 'kN'), v(0, 'kN'), v(0, 'kN')],
  balance: 0,
} as unknown as NonNullable<UiState['result']>;

const state = (model: ModelSummary | null): UiState => ({ ...initialState, model });
const group = (s: UiState, label: string) => treeGroups(s).find((g) => g.label === label)!;

describe('treeGroups', () => {
  it('supplies an explicit supported context target for every reference button', () => {
    const s = { ...state(MODEL), result: RESULT };
    const rows = treeGroups(s).flatMap(group => group.items);
    expect(rows.map(row => row.ref)).toEqual(['body:beam', 'set:tip_face', 'material:steel', 'mesh:mesh', 'constraint:root', 'constraint:weld', 'load:tip', 'step:uls', 'step:sls', 'result:id:result-7']);
    for (const row of rows) expect(parseRef(row.ref)).not.toBeNull();
    expect(rows.at(-1)!.name).toBe('σ_vM');
    expect(rows.at(-1)!.ref).not.toContain('σ_vM');
  });
  it('lists the design\'s nine groups in workflow order, even with no Model at all', () => {
    expect(treeGroups(state(null)).map((g) => g.label)).toEqual(['Geometry', 'Materials', 'Mesh', 'Constraints', 'Connections', 'Loads', 'Steps', 'Results', 'Plugins']);
    for (const g of treeGroups(state(null))) {
      expect(g.items).toEqual([]);
      expect(g.badge).toBe('—');
      expect(g.note.length).toBeGreaterThan(20);
    }
    // Every group a person can add to offers the Command that adds to it.
    expect(treeGroups(state(null)).filter((g) => g.add).map((g) => g.add!.cmd)).toEqual(['geometry.addBox', 'material.add', 'mesh.set', 'constraint.fix', 'contact.add', 'load.pressure', 'step.add']);
  });

  it('describes both physics and every callable Load and Constraint kind without stale promises', () => {
    const s = state(null);
    expect(group(s, 'Materials').note).toBe('Assign Materials to Bodies. Each Step uses the mechanical or thermal properties it needs.');
    expect(group(s, 'Steps').note).toBe('Choose a procedure and its active Constraints and Loads. Steps run in the order shown.');
    expect(group(s, 'Loads').note).toBe('Available loads: pressure, traction, force, moment, gravity, temperature, convection, heat flux, radiation, heat source, torque. A Step chooses which are active.');
    expect(group(s, 'Constraints').note).toBe('Available constraints: fix, pin, prescribe, symmetry, temperature, cyclic, couple. A Step chooses which are active.');
    for (const prefix of ['load', 'constraint']) {
      const note = group(s, prefix === 'load' ? 'Loads' : 'Constraints').note;
      const commands = schema.commands.oneOf.map(variant => variant.properties.cmd.const);
      for (const name of commands.filter(name => name.startsWith(`${prefix}.`) && name !== `${prefix}.remove`)) {
        expect(note).toContain(humanise(name.slice(prefix.length + 1)).toLowerCase());
      }
    }
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

  it('requests a lossless definition by explicit object identity rather than bbox values', () => {
    expect(group(state(MODEL), 'Geometry').items[0]).toMatchObject({
      cmd: 'form.edit', args: { kind: 'body', name: 'beam' }, run: true,
    });
    const g = group(state({ ...MODEL, bodies: [{ ...MODEL.bodies[0]!, bbox: [] as never }] }), 'Geometry');
    expect(g.items[0]!.args).toEqual({ kind: 'body', name: 'beam' });
  });

  it('summarises materials, constraints, loads, the mesh and the steps in display units', () => {
    const s = state(MODEL);
    expect(group(s, 'Materials').items[0]!.summary).toBe('E 210000 MPa · ν 0.3 · ρ 7850 kg/m^3 · on beam');
    expect(group(s, 'Materials').items[0]!.args).toEqual({ kind: 'material', name: 'steel' });
    expect(group(s, 'Constraints').items[0]!.summary).toBe('fix ux, uy, uz on beam.xmin');
    // A tie is its own group, edited through the Constraint it is, and highlights both faces.
    expect(group(s, 'Connections').items[0]).toMatchObject({
      cmd: 'form.edit',
      args: { kind: 'constraint', name: 'weld' },
      summary: 'bonded, pairing within 0.1 mm · beam.xmax to plate.xmin',
      select: { sets: ['beam.xmax', 'plate.xmin'] },
      remove: 'constraint.remove',
    });
    expect(group(s, 'Loads').items[0]).toMatchObject({ cmd: 'form.edit', summary: 'total [0, 0, -1] kN on beam.xmax' });
    expect(group(s, 'Mesh').items[0]!.summary).toBe('lattice · order 1 · incompatible-modes');
    expect(group(s, 'Steps').items[0]!.summary).toBe('static · needs elastic stiffness (E, ν or orthotropic) · gives u, stress, reactions · 1 constraints · 1 loads · solved');
  });

  it('badges a group as ok, as warning, or as empty', () => {
    const s = state(MODEL);
    expect(group(s, 'Geometry').badge).toBe('ok');
    // Results badge from the Result itself, not from the Step's `solved` flag.
    expect(group(s, 'Results').badge).toBe('—');
    expect(group({ ...s, result: RESULT }, 'Results').badge).toBe('ok');
    expect(group({ ...s, result: { ...RESULT, stale: true } }, 'Results').badge).toBe('stale');
    expect(group(s, 'Plugins').badge).toBe('—');
    const warned = state({ ...MODEL, warnings: [{ code: 'model.no-material', text: 'x', where: null }, { code: 'model.unloaded', text: 'y', where: null }] } as ModelSummary);
    expect(group(warned, 'Materials')).toMatchObject({ badge: '1 warning', badgeClass: 'badge warn' });
    expect(group(warned, 'Loads').badge).toBe('1 warning');
  });

  it('explains a heat Step through its material inputs and temperature results', () => {
    const s = state({ ...MODEL, steps: [{ name: 'cooling', procedure: 'heat-transient', constraints: ['root'], loads: [], solved: false }] });
    expect(group(s, 'Steps').items[0]).toMatchObject({
      cmd: 'form.edit', args: { kind: 'step', name: 'cooling' },
      summary: 'heat-transient · needs k, ρ, cp · gives T, reaction power, stored-energy rate · 1 constraints · 0 loads',
    });
  });

  it('shows conductivity and specific heat on a thermal material without mechanical placeholders', () => {
    const s = state({ ...MODEL, materials: [{ name: 'slab', rho: v(7200, 'kg/m^3'), k: v(35, 'W/(m K)'), cp: v(440.5, 'J/(kg K)'), assignedTo: ['beam'] }] });
    const item = group(s, 'Materials').items[0]!;
    expect(item.summary).toBe('ρ 7200 kg/m^3 · k 35 W/(m K) · cp 440.5 J/(kg K) · on beam');
    expect(item.properties?.map((property) => property.key)).toEqual(['rho', 'k', 'cp', 'assignment']);
    expect(item.summary).not.toContain('undefined');
    expect(item.summary).not.toContain('E ');
  });

  it('keeps expansion, plasticity, citation and material-axis properties visible in a fixed order', () => {
    const s = state({ ...MODEL, materials: [{
      name: 'combined', nu: 0, E: v(210_000, 'MPa'), rho: v(7850, 'kg/m^3'),
      alpha: [v(1e-5, '1/K'), v(2e-5, '1/K'), v(3e-5, '1/K')],
      k: [v(1, 'W/(m K)'), v(2, 'W/(m K)'), v(3, 'W/(m K)')], cp: v(460, 'J/(kg K)'),
      orientation: { axis: [0, 0, 1], degrees: 30 }, yield: v(355, 'MPa'), plasticity: true, source: 'measured', assignedTo: [],
    }] });
    expect(group(s, 'Materials').items[0]!.summary).toBe('E 210000 MPa · ν 0 · axes 30° · ρ 7850 kg/m^3 · α [0.00001 1/K, 0.00002 1/K, 0.00003 1/K] · k [1 W/(m K), 2 W/(m K), 3 W/(m K)] · cp 460 J/(kg K) · yield 355 MPa · plasticity · source measured · on nothing');
  });

  it('warns on Mesh when there are Bodies but no mesh settings, which no engine warning covers', () => {
    const s = state({ ...MODEL, meshSettings: null } as ModelSummary);
    expect(group(s, 'Mesh').badge).toBe('1 warning');
    expect(group(state({ ...MODEL, bodies: [], meshSettings: null } as unknown as ModelSummary), 'Mesh').badge).toBe('—');
  });

  // Issue #43: the tree offered `geometry.addBox` and nothing else.
  it('offers every shape ShapeSpec declares plus the cut, with box keeping its own Command', () => {
    const menu = shapeMenu([
      { kind: 'box', hint: 'a box' },
      { kind: 'cylinder', hint: 'a cylinder' },
      { kind: 'wormhole', hint: 'an engine kind this file has never heard of' },
    ]);
    expect(menu.map((m) => m.label)).toEqual(['box', 'cylinder', 'wormhole', 'cut']);
    expect(menu[0]).toMatchObject({ cmd: 'geometry.addBox', args: {} });
    expect(menu[1]).toMatchObject({ cmd: 'geometry.add', args: { shape: { kind: 'cylinder' } } });
    expect(menu[2]!.glyph).toBe('◇');
    expect(menu[3]).toMatchObject({ cmd: 'geometry.subtract' });
  });

  it('hangs that menu off the Geometry chip, and nowhere else', () => {
    const s = state(MODEL);
    const shapes = [{ kind: 'box', hint: 'a box' }];
    expect(treeGroups(s, shapes).find((g) => g.label === 'Geometry')!.add!.menu!.map((m) => m.label)).toEqual(['box', 'cut']);
    expect(treeGroups(s, shapes).find((g) => g.label === 'Materials')!.add!.menu).toBeUndefined();
    // No shapes handed in (a test that does not care) and the chip is the plain one it was.
    expect(treeGroups(s).find((g) => g.label === 'Geometry')!.add).toEqual({ what: 'body', cmd: 'geometry.addBox' });
  });

  it('marks the row whose Command the Properties panel is showing', () => {
    const store = new Store();
    store.set({ model: MODEL });
    store.openForm('geometry.addBox', { name: 'beam' });
    expect(store.state.form!.values['name']).toBe('beam');
    expect(group(store.state, 'Geometry').items[0]!.name).toBe('beam');
  });
});

describe('reorderSteps', () => {
  const order = ['heat', 'static', 'modal'];

  it('inserts a dragged Step on either edge of its target', () => {
    expect(reorderSteps(order, 'modal', 'heat', 'before')).toEqual(['modal', 'heat', 'static']);
    expect(reorderSteps(order, 'heat', 'static', 'after')).toEqual(['static', 'heat', 'modal']);
  });

  it('does not emit a permutation for the same place or an unknown drag source', () => {
    expect(reorderSteps(order, 'heat', 'static', 'before')).toBeNull();
    expect(reorderSteps(order, 'static', 'static', 'after')).toBeNull();
    expect(reorderSteps(order, 'unknown', 'static', 'after')).toBeNull();
  });
});
