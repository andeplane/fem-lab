import { batchModule } from '../../../tools/checked-batch.mjs';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const readData = (name: string) => readFileSync(path.join(root, name), 'utf8');

const { Engine } = batchModule(createRequire(import.meta.url)('../../../tools/wasm-node/femlab_engine_wasm.js'));

it('replays the corrected fin Journal hashes with its actual solve and preserves the independent tip-temperature reference', async () => {
  const text = readData('crates/engine/benches/journals/heated-fin-convection.json');
  const entries = JSON.parse(text) as { hashAfter: string }[];
  const engine = new Engine(1);
  try {
    expect(JSON.parse(await engine.replay_hashes(text, false, true))).toEqual(entries.map(entry => entry.hashAfter));
    const probe = (x: string) => JSON.parse(engine.query(JSON.stringify({
      query: 'query.probe', field: 'temperature', at: [x, '12.5 mm', '1 mm'],
    }))) as { value: { value: number; unit: string } };
    const tip = probe('150 mm').value;
    const root = probe('0 mm').value;
    // Independent adiabatic-tip fin solution: prescribed root120°C, ambient20°C,
    // h50 W/(m²K), perimeter0.054m, area5e-5m² and k205 W/(mK).
    const m = Math.sqrt(50 * 0.054 / (205 * 5e-5));
    const reference = 20 + 100 / Math.cosh(m * 0.15);
    expect(tip.unit).toBe('degC');
    expect(root.unit).toBe('degC');
    expect(reference).toBeCloseTo(37.39456466134858, 10);
    expect(Math.abs(tip.value - reference)).toBeLessThan(0.05);
    expect(root.value).toBeCloseTo(120, 8);
    const meta = JSON.parse(readData('crates/engine/benches/journals/heated-fin-convection.meta.json')) as { expected: { quantity: string; value: number; unit: string } };
    expect(meta.expected.quantity).toBe('tip temperature');
    expect(meta.expected.unit).toBe(tip.unit);
    expect(Math.abs(meta.expected.value - tip.value)).toBeLessThan(0.01);
    const original = new Engine(1);
    try {
      const inputs = (JSON.parse(text) as { cmd: { cmd: string; [key: string]: unknown } }[]).map(({ cmd }, seq) => ({
        seq, cmd: cmd.cmd === 'material.add' ? { ...cmd, source: 'EN 573-3 6061-T6' } : cmd, hashAfter: '',
      }));
      await original.replay_hashes(JSON.stringify(inputs), false, false);
      const values = (owner: typeof engine) => {
        const result = JSON.parse(owner.query(JSON.stringify({ query: 'query.field', field: 'temperature' }))) as { values: number[] };
        return Array.from(new Uint8Array(new Float64Array(result.values).buffer));
      };
      expect(values(engine)).toEqual(values(original));
    } finally { original.free(); }
  } finally { engine.free(); }
}, 30_000);

it.each(['heated-fin', 'thermal-bar'])('%s retains the uniform-expansion solution and all Result field bytes after correcting provenance', async name => {
  const commands = name === 'heated-fin'
    ? (JSON.parse(readData('crates/engine/benches/journals/heated-fin.json')) as { cmd: { cmd: string; [key: string]: unknown }; hashAfter: string }[]).map(entry => entry.cmd)
    : (JSON.parse(readData('packages/app/tutorials/thermal-bar.json')) as { steps: { doIt?: { cmd: string; [key: string]: unknown } }[] }).steps.filter(step => step.doIt).map(step => step.doIt!);
  const fields = [];
  for (const originalProvenance of [false, true]) {
    const engine = new Engine(1);
    try {
      const inputs = commands.map(cmd => cmd.cmd === 'material.add' && originalProvenance ? { ...cmd, source: 'EN 573-3 6061-T6' } : cmd);
      if (name === 'heated-fin' && !originalProvenance) {
        const text = readData('crates/engine/benches/journals/heated-fin.json');
        const entries = JSON.parse(text) as { hashAfter: string }[];
        expect(JSON.parse(await engine.replay_hashes(text, false, true))).toEqual(entries.map(entry => entry.hashAfter));
      } else {
        await engine.replay_hashes(JSON.stringify(inputs.map((cmd, seq) => ({ seq, cmd, hashAfter: '' }))), false, false);
      }
      // Thermal bar's authored steps stop before solve; exercise their actual model here.
      if (name === 'thermal-bar') await engine.dispatch(JSON.stringify({ cmd: 'solve.run', step: 'static' }));
      const probe = (x: string) => JSON.parse(engine.query(JSON.stringify({
        query: 'query.probe', field: 'displacement', component: 0, at: [x, '10 mm', '1.5 mm'],
      }))) as { value: { value: number; unit: string } };
      const tip = probe('120 mm').value;
      const interior = probe('80 mm').value;
      // Far from the restrained end, free axial expansion is alpha*deltaT*deltaX.
      const expansion = 2.3e-5 * (80 - 20) * (120 - 80); // mm
      expect(tip.unit).toBe('mm');
      expect(interior.unit).toBe('mm');
      expect(Math.abs((tip.value - interior.value) / expansion - 1)).toBeLessThan(0.01);
      const result = JSON.parse(engine.query(JSON.stringify({ query: 'query.result', step: 'static' }))) as { extremes: { field: string; max: { value: number; unit: string } }[] };
      const peak = result.extremes.find(extreme => extreme.field === 'vonMises')!.max;
      expect(peak.unit).toBe('MPa');
      expect(Math.abs(peak.value - 160.2)).toBeLessThan(0.1); // Existing example value, not a closed-form stress oracle.
      fields.push(['displacement', 'stress'].map(field => {
        const result = JSON.parse(engine.query(JSON.stringify({ query: 'query.field', step: 'static', field }))) as { values: number[] };
        return Array.from(new Uint8Array(new Float64Array(result.values).buffer));
      }));
    } finally { engine.free(); }
  }
  expect(fields[0]).toEqual(fields[1]);
}, 30_000);


it.each(['heated-fin', 'heated-fin-convection'])('%s keeps its committed native hash sidecar consistent with the canonical Journal', name => {
  const entries = JSON.parse(readData(`crates/engine/benches/journals/${name}.json`)) as { hashAfter: string }[];
  const hashes = readData(`crates/engine/benches/journals/${name}.hashes`).trim().split(/\r?\n/);
  expect(hashes).toEqual(entries.map(entry => entry.hashAfter));
});
