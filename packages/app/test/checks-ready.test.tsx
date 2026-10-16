import { createRequire } from 'node:module';
import { render } from 'preact';
import { describe, expect, it } from 'vitest';
import type { Command, JournalDump, ModelSummary } from '@femlab/registry';
import { batchModule } from '../../../tools/checked-batch.mjs';
import { initialState } from '../src/store';
import { Checks } from '../src/ui/Results';
import type { Query } from '../src/ui/SchemaForm';
import { waitForText } from './wait-for';

const { Engine } = batchModule(createRequire(import.meta.url)('../../../tools/wasm-node/femlab_engine_wasm.js'));

interface ReadyModel {
  name: string;
  commands: Command[];
  constraints: number;
  loads: number;
  dofs: number;
}
const box: Command[] = [
  { cmd: 'geometry.addBox', name: 'bar', size: ['1 m', '100 mm', '100 mm'] },
  { cmd: 'mesh.set', mesher: { kind: 'lattice', size: { nx: 2, ny: 1, nz: 1 } }, order: 1, formulation: 'full' },
];
const steel: Command[] = [
  { cmd: 'material.add', name: 'steel', E: '200 GPa', nu: 0, rho: '7800 kg/m^3' },
  { cmd: 'material.assign', material: 'steel', bodies: ['bar'] },
];
const readyModels: ReadyModel[] = [
  {
    name: 'free modal Body', constraints: 0, loads: 0, dofs: 36,
    commands: [...box, ...steel,
      { cmd: 'step.add', name: 'free-modes', procedure: 'modal', constraints: [], loads: [], nModes: 8 }],
  },
  {
    name: 'insulated transient heat Body', constraints: 0, loads: 0, dofs: 12,
    commands: [...box,
      { cmd: 'material.add', name: 'conductor', k: '12 W/(m K)', rho: '1000 kg/m^3', cp: '1000 J/(kg K)' },
      { cmd: 'material.assign', material: 'conductor', bodies: ['bar'] },
      { cmd: 'step.add', name: 'insulated-heat', procedure: 'heat-transient', constraints: [], loads: [], dt: '0.1 s', tEnd: '0.2 s', initial: '300 K' }],
  },
  {
    name: 'supported loaded static Body', constraints: 1, loads: 1, dofs: 36,
    commands: [...box, ...steel,
      { cmd: 'constraint.fix', name: 'root', on: 'bar.xmin' },
      { cmd: 'load.traction', name: 'pull', on: 'bar.xmax', total: ['1000 N', '0 N', '0 N'] },
      { cmd: 'step.add', name: 'static-pull', procedure: 'static', constraints: ['root'], loads: ['pull'] }],
  },
];

describe('Checks reports the actual pre-solve outcome', () => {
  it.each(readyModels)('does not invent supports, loads or a solved Result for $name', async fixture => {
    const engine = new Engine(1);
    const root = document.createElement('div');
    try {
      for (const command of [{ cmd: 'model.new', name: fixture.name }, ...fixture.commands]) {
        await engine.dispatch(JSON.stringify(command));
      }
      const query: Query = async q => JSON.parse(engine.query(JSON.stringify(q)));
      const model = await query({ query: 'query.model' }) as ModelSummary;
      expect(model.warnings).toEqual([]);
      expect(model.constraints).toHaveLength(fixture.constraints);
      expect(model.loads).toHaveLength(fixture.loads);
      expect(model.steps[0]!.solved).toBe(false);
      const before = await query({ query: 'query.journal' }) as JournalDump;
      render(<Checks s={{ ...initialState, model, revision: model.revision }} query={query} dispatch={async () => undefined} />, root);
      await waitForText(() => root, `degrees of freedom${fixture.dofs}`);
      const pass = root.querySelector('.surface.pass')!;
      expect(pass.textContent).toContain('No current pre-solve blockers are reported.');
      expect(pass.textContent).not.toMatch(/\bheld\b|\bloaded\b|guaranteed|successful solve/);
      expect(root.querySelectorAll('.check-row')).toHaveLength(0);
      expect(await query({ query: 'query.journal' })).toEqual(before);
    } finally { render(null, root); engine.free(); }
  });

  it('keeps actual structural blockers instead of advertising a ready Model', async () => {
    const engine = new Engine(1);
    const root = document.createElement('div');
    try {
      for (const command of [{ cmd: 'model.new', name: 'unfinished static' }, ...box, ...steel,
        { cmd: 'step.add', name: 'unfinished', procedure: 'static', constraints: [], loads: [] }]) {
        await engine.dispatch(JSON.stringify(command));
      }
      const query: Query = async q => JSON.parse(engine.query(JSON.stringify(q)));
      const model = await query({ query: 'query.model' }) as ModelSummary;
      expect(model.warnings.map(w => w.code)).toContain('model.unconstrained');
      expect(model.warnings.map(w => w.code)).toContain('model.unloaded');
      render(<Checks s={{ ...initialState, model, revision: model.revision }} query={query} dispatch={async () => undefined} />, root);
      await waitForText(() => root, 'degrees of freedom36');
      expect(root.querySelector('.surface.pass')).toBeNull();
      expect(root.textContent).toContain('W-1300');
      expect(root.textContent).toContain('W-1400');
    } finally { render(null, root); engine.free(); }
  });
});
