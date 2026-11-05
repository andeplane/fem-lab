// @vitest-environment node
// Exercise the shipped Rust WASM through the public registry, not a host-side derivative.
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import type { ResultField } from '@femlab/registry';
import { batchModule } from '../../../tools/checked-batch.mjs';

interface Engine {
  dispatch(json: string): Promise<string>;
  query(json: string): string;
  export_file(): string;
  replay_hashes(json: string, skip: boolean, verify: boolean): Promise<string>;
  free(): void;
}
const { Engine } = batchModule(createRequire(import.meta.url)('../../../tools/wasm-node/femlab_engine_wasm.js')) as { Engine: new (threads: number) => Engine };
const query = <T>(engine: Engine, input: Record<string, unknown>): T => JSON.parse(engine.query(JSON.stringify(input))) as T;

it('solves Fourier vectors at three refinements, preserves SI/display units and replays exact endpoint arrays', async () => {
  for (const order of [1, 2]) for (const nx of [2, 4, 8]) {
    const engine = new Engine(1), replay = new Engine(1);
    try {
      for (const command of [
        { cmd: 'model.new', name: 'thermal vectors' },
        { cmd: 'model.setUnits', units: { temperature: 'degC', temperatureGradient: 'degC/mm', heatFlux: 'kW/m^2' } },
        { cmd: 'geometry.addBox', name: 'bar', size: ['1 m', '0.1 m', '0.1 m'] },
        { cmd: 'material.add', name: 'conductor', k: '5 W/(m K)' },
        { cmd: 'material.assign', material: 'conductor', bodies: ['bar'] },
        { cmd: 'mesh.set', mesher: { kind: 'lattice', size: { nx, ny: 1, nz: 1 } }, order },
        { cmd: 'constraint.temperature', name: 'cold', on: 'bar.xmin', value: '300 K' },
        { cmd: 'constraint.temperature', name: 'hot', on: 'bar.xmax', value: '320 K' },
        { cmd: 'step.add', name: 'heat', procedure: 'heat-steady', constraints: ['cold', 'hot'], loads: [] },
        { cmd: 'solve.run', step: 'heat', solver: 'cpu-direct' },
      ]) await engine.dispatch(JSON.stringify(command));
      const journal = JSON.parse(engine.export_file()).journal.entries as { hashAfter: string }[];
      expect(JSON.parse(await replay.replay_hashes(JSON.stringify(journal), false, true))).toEqual(journal.map(entry => entry.hashAfter));
      for (const [field, unit, expected] of [
        ['temperatureGradient', 'K/m', 20], ['heatFlux', 'W/m^2', -100],
      ] as const) {
        const input = { query: 'query.field', step: 'heat', field };
        const result = query<ResultField>(engine, input);
        expect(result).toEqual(query(replay, input));
        expect(result.per).toBe('elementNode');
        expect(result.unit).toBe(unit);
        expect(result.components).toBe(3);
        expect(result.entityCount).toBe(nx * (order === 1 ? 8 : 20));
        for (let i = 0; i < result.values.length; i++) expect(Math.abs(result.values[i]! - (i % 3 === 0 ? expected : 0))).toBeLessThan(1e-8);
      }
      const point = query<{ value: { value: number; unit: string }; interpolated: boolean }>(engine,
        { query: 'query.probe', step: 'heat', field: 'temperatureGradient', component: 0, at: ['0.37 m', '0.05 m', '0.05 m'] });
      expect(point.interpolated).toBe(true);
      expect(point.value.unit).toBe('degC/mm');
      expect(point.value.value).toBeCloseTo(0.02, 10); // no absolute-temperature offset
      const path = query<{ values: number[]; unit: string }>(engine,
        { query: 'query.path', step: 'heat', field: 'heatFlux', component: 0,
          from: ['0.1 m', '0.05 m', '0.05 m'], to: ['0.9 m', '0.05 m', '0.05 m'], n: 5 });
      expect(path.unit).toBe('kW/m^2');
      for (const value of path.values) expect(value).toBeCloseTo(-0.1, 10);
    } finally { engine.free(); replay.free(); }
  }
});

it('keeps varying quadratic conduction gradients and source/support heat balance in actual WASM', async () => {
  for (const nx of [2, 4, 8]) {
    const engine = new Engine(1);
    try {
      for (const command of [
        { cmd: 'geometry.addBox', name: 'bar', size: ['1 m', '0.1 m', '0.1 m'] },
        { cmd: 'material.add', name: 'conductor', k: '5 W/(m K)' },
        { cmd: 'material.assign', material: 'conductor', bodies: ['bar'] },
        { cmd: 'mesh.set', mesher: { kind: 'lattice', size: { nx, ny: 1, nz: 1 } }, order: 2 },
        { cmd: 'constraint.temperature', name: 'left', on: 'bar.xmin', value: '300 K' },
        { cmd: 'constraint.temperature', name: 'right', on: 'bar.xmax', value: '300 K' },
        { cmd: 'load.heatSource', name: 'source', bodies: ['bar'], q: '100 W/m^3' },
        { cmd: 'step.add', name: 'heat', procedure: 'heat-steady', constraints: ['left', 'right'], loads: ['source'] },
        { cmd: 'solve.run', step: 'heat', solver: 'cpu-direct' },
      ]) await engine.dispatch(JSON.stringify(command));
      // T=300+10x(1-x), so grad_x=10-20x and q_x=100x-50.
      for (const x of [0.2, 0.5, 0.8]) for (const [field, expected] of [
        ['temperatureGradient', 10 - 20 * x], ['heatFlux', 100 * x - 50],
      ] as const) {
        const result = query<{ value: { value: number } }>(engine,
          { query: 'query.probe', step: 'heat', field, component: 0, at: [`${x} m`, '0.05 m', '0.05 m'] });
        expect(Math.abs(result.value.value - expected)).toBeLessThan(1e-8);
      }
      const result = query<{ reactions: { total: { value: number; unit: string }[] }[] }>(engine, { query: 'query.result', step: 'heat' });
      for (const support of result.reactions) {
        expect(support.total[0]!.unit).toBe('W');
        expect(support.total[0]!.value).toBeCloseTo(0.5, 10);
      }
    } finally { engine.free(); }
  }
});
