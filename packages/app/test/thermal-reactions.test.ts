import { batchModule } from '../../../tools/checked-batch.mjs';
// The browser's wasm engine produces SI power; the host converts it using Result metadata.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { ResultSummary } from '@femlab/registry';
import { displayUnitOf, siUnitOf } from '../src/fields';

const { Engine } = batchModule(createRequire(import.meta.url)('../../../tools/wasm-node/femlab_engine_wasm.js'));

describe('thermal reaction units through the actual wasm engine', () => {
  it('keeps the exact flux power in SI and converts the host view independently of force', async () => {
    const e = new Engine(1);
    const commands = [
      { cmd: 'model.new', name: 'heat' },
      { cmd: 'geometry.addBox', name: 'bar', size: ['1 m', '0.1 m', '0.1 m'] },
      { cmd: 'material.add', name: 'steel', E: '210 GPa', nu: 0.3, k: '45 W/(m K)' },
      { cmd: 'material.assign', material: 'steel', bodies: ['bar'] },
      { cmd: 'mesh.set', mesher: { kind: 'lattice', size: { nx: 2, ny: 1, nz: 1 } } },
      { cmd: 'constraint.temperature', name: 'cold', on: 'bar.xmin', value: '0 degC' },
      { cmd: 'load.heatFlux', name: 'in', on: 'bar.xmax', q: '1000 W/m^2' },
      { cmd: 'step.add', name: 'heat', procedure: 'heat-steady', constraints: ['cold'], loads: ['in'] },
      { cmd: 'solve.run', step: 'heat' },
    ];
    for (const cmd of commands) await e.dispatch(JSON.stringify(cmd), undefined);
    const raw = e.field('heat', 'reaction', 0);
    expect([...raw].reduce((sum, v) => sum + v, 0)).toBeCloseTo(10, 7); // q*A = 10 W
    for (const units of [{ force: 'kN', power: 'W' }, { force: 'N', power: 'kW' }]) {
      await e.dispatch(JSON.stringify({ cmd: 'model.setUnits', units }), undefined);
      const r = JSON.parse(e.query(JSON.stringify({ query: 'query.result', step: 'heat' }))) as ResultSummary;
      expect(r.reactionQuantity).toBe('power');
      expect(r.balance).toBeLessThan(1e-9);
      expect(r.storagePower).toEqual({ value: 0, unit: units.power });
      const from = siUnitOf('reaction', r.reactionQuantity);
      const to = displayUnitOf('reaction', units, r.reactionQuantity);
      expect(from).toBe('W');
      expect(to).toBe(units.power);
      const converted = JSON.parse(e.query(JSON.stringify({ query: 'query.convert', quantity: { value: 10, unit: from }, to }))) as { value: number };
      expect(r.reactions[0]!.total[0].unit).toBe(to);
      expect(r.reactions[0]!.total[0].value).toBeCloseTo(converted.value, 9);
      expect([...e.field('heat', 'reaction', 0)]).toEqual([...raw]);
    }
    e.free();
  });
});
