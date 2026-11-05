import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { batchModule } from '../../../tools/checked-batch.mjs';
import { TUTORIALS } from '../src/tutorial/tutorials';
import type { TutorialCommand } from '../src/tutorial/types';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(import.meta.url);
interface Engine { replay_hashes(json: string, skip: boolean, verify: boolean): Promise<string>; query(json: string): string; free(): void }
const wasm = batchModule(require(path.join(root, 'tools/wasm-node/femlab_engine_wasm.js'))) as { Engine: new (threads: number) => Engine };
function commands(id: string): TutorialCommand[] {
  return TUTORIALS.find(tutorial => tutorial.id === id)!.steps.flatMap(step => step.doIt && step.doIt.cmd !== 'view.fit' ? [step.doIt] : []);
}
async function run(id: string, inspect: (engine: Engine) => void, change: (commands: TutorialCommand[]) => TutorialCommand[] = commands => commands): Promise<void> {
  const engine = new wasm.Engine(1);
  try {
    await engine.replay_hashes(JSON.stringify(change(commands(id)).map((cmd, seq) => ({ seq, cmd, hashAfter: '' }))), false, false);
    inspect(engine);
  } finally { engine.free(); }
}
function query<T>(engine: Engine, input: Record<string, unknown>): T { return JSON.parse(engine.query(JSON.stringify(input))) as T; }
function probe(engine: Engine, field: string, at: string[], component?: number): { value: number; unit: string } {
  return query<{ value: { value: number; unit: string } }>(engine, { query: 'query.probe', field, at, ...(component === undefined ? {} : { component }) }).value;
}

// Separation of variables for a finite cylinder with all physical surfaces held hot:
// (Tb-T)/Tb = [sum 2J0(j_n r/R)/(j_n J1(j_n)) exp(-alpha j_n²t/R²)]
//             [sum_(n odd) 4/(n pi) sin(n pi z/H) exp(-alpha n²pi²t/H²)].
// This oracle never calls FEM assembly, time integration, or any engine utility.
function bessel(x: number, order: 0 | 1): number {
  let term = order === 0 ? 1 : x / 2;
  let sum = term;
  for (let k = 1; k < 80; k++) {
    term *= -(x * x / 4) / (k * (k + order));
    sum += term;
    if (Math.abs(term) < 1e-15) break;
  }
  return sum;
}
const roots = [2.404825557695773, 5.520078110286311, 8.653727912911013, 11.791534439014281, 14.930917708487787, 18.071063967910924, 21.21163662987926, 24.352471530749302];
function cylinderTemperature(terms = 8): number {
  const alpha = 52 / (7850 * 460), t = 190, r = 0.1, radius = 0.3, z = 0.3, height = 0.4;
  const radial = roots.slice(0, terms).reduce((sum, j) => sum + 2 * bessel(j * r / radius, 0) / (j * bessel(j, 1)) * Math.exp(-alpha * j * j * t / radius ** 2), 0);
  let axial = 0;
  for (let n = 1; n < 40; n += 2) axial += 4 / (n * Math.PI) * Math.sin(n * Math.PI * z / height) * Math.exp(-alpha * (n * Math.PI / height) ** 2 * t);
  return 1000 * (1 - radial * axial);
}

it('axisymmetric tutorial reaches the independent finite-cylinder temperature and converges in time', async () => {
  const reference = cylinderTemperature();
  expect(reference).toBeCloseTo(186.48527933, 6);
  expect(Math.abs(reference - cylinderTemperature(7))).toBeLessThan(1e-5);
  const errors: number[] = [];
  for (const dt of [2, 1, 0.5]) {
    await run('axisymmetric-transient-heat', engine => {
      const actual = probe(engine, 'temperature', ['0.1 m', '0.3 m', '0 m']);
      expect(actual.unit).toBe('degC');
      errors.push(Math.abs(actual.value - reference));
      const history = query<{ frames: { timeSi: number }[] }>(engine, { query: 'query.frames', step: 'warm-up' });
      expect(history.frames.at(-1)!.timeSi).toBe(190);
      expect(history.frames[0]!.timeSi).toBe(0);
    }, list => list.map(command => command.cmd === 'step.add' ? { ...command, dt: `${dt} s` } : command));
  }
  expect(errors[0]!).toBeLessThan(0.3);
  expect(errors[1]!).toBeLessThan(errors[0]!);
  expect(errors[2]!).toBeLessThan(errors[1]!);
  expect(errors[2]!).toBeLessThan(0.06);
}, 30_000);

it('axisymmetric heat refines in space independently and rejects a missing heated end', async () => {
  const reference = cylinderTemperature(), errors: number[] = [];
  for (const [nx, ny] of [[3, 4], [6, 8], [12, 16]]) await run('axisymmetric-transient-heat', engine => {
    errors.push(Math.abs(probe(engine, 'temperature', ['0.1 m', '0.3 m', '0 m']).value - reference));
  }, list => list.map(command => command.cmd === 'mesh.set'
    ? { ...command, mesher: { kind: 'lattice', size: { nx, ny, nz: 1 } } }
    : command.cmd === 'step.add' ? { ...command, theta: 0.5, dt: '0.5 s' } : command));
  expect(errors[1]!).toBeLessThan(errors[0]!);
  expect(errors[2]!).toBeLessThan(errors[1]!);
  expect(errors[2]!).toBeLessThan(0.03);
  await run('axisymmetric-transient-heat', engine => {
    expect(Math.abs(probe(engine, 'temperature', ['0.1 m', '0.3 m', '0 m']).value - reference)).toBeGreaterThan(20);
  }, list => list.map(command => command.cmd === 'step.add' ? { ...command, constraints: ['rim-hot', 'bottom-hot'] } : command));
}, 30_000);

it('one-eighth tutorial preserves expansion and exactly combines thermal strain with pressure', async () => {
  for (const n of [1, 2, 3]) await run('eighth-thermal-stress', engine => {
    for (const [component, expected] of [0.475, 0.5075, 0.5075].entries()) {
      const actual = probe(engine, 'displacement', ['0.5 m', '0.5 m', '0.5 m'], component);
      expect(actual.unit).toBe('mm');
      expect(actual.value).toBeCloseTo(expected, 8);
    }
    for (const [component, expected] of [-10, 0, 0, 0, 0, 0].entries()) {
      const actual = probe(engine, 'stress', ['0.25 m', '0.25 m', '0.25 m'], component);
      expect(actual.unit).toBe('MPa');
      expect(actual.value).toBeCloseTo(expected, 7);
    }
    expect(probe(engine, 'vonMises', ['0.25 m', '0.25 m', '0.25 m']).value).toBeCloseTo(10, 7);
    const result = query<{ reactions: { constraint: string; total: { value: number; unit: string }[] }[]; balance: number }>(engine, { query: 'query.result' });
    expect(result.reactions.find(row => row.constraint === 'mirror-x')!.total[0]).toEqual(expect.objectContaining({ unit: 'N' }));
    expect(result.reactions.find(row => row.constraint === 'mirror-x')!.total[0]!.value).toBeCloseTo(2_500_000, 3);
    expect(result.balance).toBeLessThan(1e-9);
  }, list => list.map(command => command.cmd === 'mesh.set' ? { ...command, mesher: { kind: 'lattice', size: { nx: n, ny: n, nz: n } } } : command));
}, 30_000);

it('removing pressure gives stress-free heating, while clamping a mirror plane introduces stress', async () => {
  await run('eighth-thermal-stress', engine => {
    for (const component of [0, 1, 2]) expect(probe(engine, 'displacement', ['0.5 m', '0.5 m', '0.5 m'], component).value).toBeCloseTo(0.5, 8);
    expect(probe(engine, 'vonMises', ['0.25 m', '0.25 m', '0.25 m']).value).toBeLessThan(1e-7);
  }, list => list.map(command => command.cmd === 'step.add' ? { ...command, loads: ['heating'] } : command));
  await run('eighth-thermal-stress', engine => {
    expect(probe(engine, 'vonMises', ['0.25 m', '0.25 m', '0.25 m']).value).toBeGreaterThan(20);
  }, list => list.map(command => command.cmd === 'constraint.symmetry' && command.name === 'mirror-x' ? { cmd: 'constraint.fix', name: 'mirror-x', on: 'octant.xmin' } : command));
}, 30_000);

it('LE10 tutorial uses the full-face oracle and improves under in-plane and thickness refinement', async () => {
  const errors: number[] = [];
  for (const fine of [false, true]) await run('le10-full-face', engine => {
    const actual = probe(engine, 'stress', ['2 m', '0 m', '0.6 m'], 1);
    expect(actual.unit).toBe('MPa');
    errors.push(Math.abs(actual.value - -5.25) / 5.25);
    expect(query<{ balance: number }>(engine, { query: 'query.result' }).balance).toBeLessThan(1e-9);
  }, list => list.map(command => {
    if (command.cmd !== 'mesh.set' || fine) return command;
    const mesher = structuredClone(command.mesher) as { base: { blocks: { n: number[] }[] }; sweep: { layers: number } };
    mesher.base.blocks[0]!.n = [6, 6]; mesher.sweep.layers = 2;
    return { ...command, mesher };
  }));
  expect(errors[0]!).toBeGreaterThan(0.04);
  expect(errors[1]!).toBeLessThan(0.02);
  expect(errors[1]!).toBeLessThan(errors[0]! / 10);
  const prose = TUTORIALS.find(t => t.id === 'le10-full-face')!.steps.map(s => `${s.explain} ${s.theory ?? ''}`).join(' ');
  expect(prose).toContain('−5.38');
  expect(prose).toContain('mid-plane');
}, 30_000);
