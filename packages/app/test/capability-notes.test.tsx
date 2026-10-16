import { createRequire } from 'node:module';
import { render } from 'preact';
import { expect, it } from 'vitest';
import type { ModelSummary } from '@femlab/registry';
import { batchModule } from '../../../tools/checked-batch.mjs';
import { Store } from '../src/store';
import { App } from '../src/ui/App';
import { afterEffects } from './wait-for';

const { Engine } = batchModule(createRequire(import.meta.url)('../../../tools/wasm-node/femlab_engine_wasm.js'));

it('keeps capability information visible without inventing a solve blocker or hiding a real error', async () => {
  const engine = new Engine(1);
  const root = document.createElement('div');
  document.body.append(root);
  try {
    for (const command of [
      { cmd: 'model.new', name: 'ready bar' },
      { cmd: 'geometry.addBox', name: 'bar', size: ['1 m', '0.1 m', '0.1 m'] },
      { cmd: 'material.add', name: 'steel', E: '200 GPa', nu: 0 },
      { cmd: 'material.assign', material: 'steel', bodies: ['bar'] },
      { cmd: 'mesh.set', mesher: { kind: 'lattice', size: { nx: 2, ny: 1, nz: 1 } }, order: 1, formulation: 'full' },
      { cmd: 'constraint.fix', name: 'root', on: 'bar.xmin' },
      { cmd: 'load.traction', name: 'tip', on: 'bar.xmax', total: ['1000 N', '0 N', '0 N'] },
      { cmd: 'step.add', name: 'axial', procedure: 'static', constraints: ['root'], loads: ['tip'] },
    ]) await engine.dispatch(JSON.stringify(command));
    const model = JSON.parse(engine.query(JSON.stringify({ query: 'query.model' }))) as ModelSummary;
    const note = 'Running single-threaded; open in Chrome and reload to enable threads.';
    const store = new Store();
    store.set({ ready: true, model, revision: model.revision, notes: [note] });
    render(<App store={store} dispatch={async () => undefined} viewer={{ current: null }} />, root);
    await afterEffects();
    const status = () => root.querySelector('[role="status"][aria-label="Engine capabilities"]');
    expect(status()?.textContent).toBe(note);
    expect(status()?.closest('.result-workspace')).not.toBeNull();
    expect(root.querySelectorAll('.banner')).toHaveLength(0);
    expect(root.querySelector<HTMLButtonElement>('button.solve')?.disabled).toBe(false);

    store.set({ lastError: { code: 'solve.example', cause: 'A real solve failure', where: 'solve.run', suggestion: 'solve.run' } });
    await afterEffects();
    expect(root.querySelectorAll('.banner')).toHaveLength(1);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('A real solve failure');
    expect(status()?.textContent).toBe(note);
    expect(root.querySelector<HTMLButtonElement>('button.solve')?.disabled).toBe(true);
  } finally { render(null, root); root.remove(); engine.free(); }
});
