import type { ModelSummary } from '@femlab/registry';
import { describe, expect, it } from 'vitest';
import { solveBlockers } from '../src/ui/schema';

type SolveModel = NonNullable<Parameters<typeof solveBlockers>[0]>;
const model = (steps: SolveModel['steps'], warnings: SolveModel['warnings'] = []): SolveModel => ({
  steps, warnings,
  bodies: [{ name: 'bar', bbox: [
    { value: 0, unit: 'm' }, { value: 0, unit: 'm' }, { value: 0, unit: 'm' },
    { value: 1, unit: 'm' }, { value: 1, unit: 'm' }, { value: 1, unit: 'm' },
  ], faces: [], measure: { value: 1, unit: 'm^3' } }],
  meshSettings: { mesher: { kind: 'lattice', counts: [1, 1, 1], size: null }, order: 1, formulation: 'full' } as ModelSummary['meshSettings'],
});

describe('solve input blockers', () => {
  it('allows a free modal solve while a later static Step is unfinished', () => {
    const m = model([{ name: 'free', procedure: 'modal' }, { name: 'later', procedure: 'static' }], [
      { code: 'model.unconstrained', text: 'no supports in this Step', step: 'later', where: "step 'later'" },
      { code: 'model.unloaded', text: 'no load in this Step', step: 'later', where: "step 'later'" },
    ]);
    expect(solveBlockers(m, 'free')).toEqual([]);
    expect(solveBlockers(m, 'later').map(w => w.code)).toEqual(['W-1300', 'W-1400']);
  });

  it('keeps material/geometry warnings global and scopes thermal property requirements', () => {
    const m = model([{ name: 'bend', procedure: 'static' }, { name: 'warm', procedure: 'heat-steady' }], [
      { code: 'material.missing-property', text: 'needs k', where: "material 'steel'", step: 'warm' },
      { code: 'model.no-material', text: 'unassigned Body', where: "body 'unassigned'" },
    ]);
    expect(solveBlockers(m, 'bend').map(w => w.code)).toEqual(['W-1101']);
    expect(solveBlockers(m, 'warm').map(w => w.code)).toEqual(['material.missing-property', 'W-1101']);
  });

  it('keeps all required predecessor inputs and ignores an unrelated Step', () => {
    const m = model([
      { name: 'response', procedure: 'harmonic', after: 'modal' },
      { name: 'modal', procedure: 'modal', after: 'prestress' },
      { name: 'prestress', procedure: 'static' },
      { name: 'unrelated', procedure: 'heat-steady' },
    ], [
      { code: 'model.unconstrained', text: 'prestress needs supports', step: 'prestress', where: "step 'prestress'" },
      { code: 'material.missing-property', text: 'modal needs rho', step: 'modal' },
      { code: 'material.missing-property', text: 'unrelated needs k', step: 'unrelated' },
    ]);
    const required = solveBlockers(m, 'response');
    expect(required).toHaveLength(2);
    expect(required.find(w => w.code === 'material.missing-property')?.text).toBe('modal needs rho');
    expect(required.find(w => w.code === 'W-1300')?.where).toBe("step 'prestress'");
    expect(solveBlockers(m, 'prestress').map(w => w.code)).toEqual(['W-1300']);
  });

  it('uses typed Step identity even when names contain quotes and display text names another Step', () => {
    const requested = "free'quoted";
    const m = model([{ name: requested, procedure: 'modal' }, { name: 'later', procedure: 'static' }], [
      { code: 'model.unconstrained', text: `warning about ${requested}`, where: `step '${requested}'`, step: 'later' },
      { code: 'material.missing-property', text: 'warning about later', where: 'material display location', step: requested },
    ]);
    expect(solveBlockers(m, requested).map(w => w.code)).toEqual(['material.missing-property']);
  });

  it('fails closed for unscoped warnings and unknown Step identities', () => {
    const m = model([{ name: 'free', procedure: 'modal' }, { name: 'later', procedure: 'static' }], [
      { code: 'legacy-warning', text: 'legacy', where: "step 'later'" },
      { code: 'future-warning', text: 'future', step: 'unknown' },
      { code: 'global-warning', text: 'global', step: null },
    ]);
    expect(solveBlockers(m, 'free').map(w => w.code)).toEqual(['future-warning', 'global-warning', 'legacy-warning']);
  });

  it('retains target/predecessor warnings without looping if a malformed chain cycles', () => {
    const m = model([{ name: 'a', procedure: 'static', after: 'b' }, { name: 'b', procedure: 'static', after: 'a' }], [
      { code: 'model.unloaded', text: 'b has no drive', step: 'b' },
    ]);
    expect(solveBlockers(m, 'a')[0]?.code).toBe('W-1400');
  });

  it('retains mesh and missing-Step blockers and handles no active Model', () => {
    const m = { ...model([], [{ code: 'model.no-step', text: 'add a Step' }]), meshSettings: null };
    expect(solveBlockers(m, '').map(w => w.code)).toEqual(['W-1200', 'W-1500']);
    expect(solveBlockers(null, '')).toEqual([]);
  });
});
