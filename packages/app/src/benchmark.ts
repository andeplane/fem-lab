import type { ProbeResult, ResultSummary, Valued } from '@femlab/registry';
import { FemError } from '@femlab/registry';

export interface ExampleEntry {
  name: string;
  commands: number;
  summary: string;
  title: string;
  tag: string;
  theory: string;
  expected: { quantity: string; value: number | number[]; unit: string; reference: string };
}

type Locator =
  | { kind: 'extreme'; field: string; component: number; pick: 'min' | 'max' }
  | { kind: 'probe'; field: string; component: number; at: [string, string, string] }
  | { kind: 'frequencies' };

type Tolerance = { kind: 'percent'; value: number } | { kind: 'absolute'; value: number; unit: string };

export interface BenchmarkComparison {
  locator: Locator;
  reference: { values: number[]; unit: string; label: string };
  tolerance: Tolerance;
  magnitude?: boolean;
  source: string;
}

/**
 * The explicit bridge from bundled examples to Result observables. `null` means the reference is
 * local, ambiguous or not represented by ResultSummary; adding an example without deciding here
 * fails the fixture test. LE10 stays null until #183 matches the published support condition.
 */
export const BENCHMARK_COMPARISONS: Record<string, BenchmarkComparison | null> = {
  'bar-transient-heat': {
    locator: { kind: 'probe', field: 'temperature', component: 0, at: ['80 mm', '2.5 mm', '2.5 mm'] },
    reference: { values: [36.6], unit: 'K', label: 'T at x = 80 mm, t = 32 s' },
    tolerance: { kind: 'absolute', value: 0.5, unit: 'K' },
    source: 'NAFEMS “The Standard NAFEMS Benchmarks” P18 (1990), T3 · catalogue E3',
  },
  'bolt-flange': null,
  'bracket-L': null,
  'cantilever-hex20': {
    locator: { kind: 'extreme', field: 'displacement', component: 2, pick: 'min' },
    reference: { values: [0.1904762], unit: 'mm', label: '|uᶻ| at the tip' },
    tolerance: { kind: 'percent', value: 1 },
    magnitude: true,
    source: 'Euler–Bernoulli bending solution PL³/3EI · bundled benchmark metadata',
  },
  'cantilever-modal': {
    locator: { kind: 'frequencies' },
    reference: { values: [20.96, 41.91, 131.32, 262.66], unit: 'Hz', label: 'f₁ … f₄' },
    tolerance: { kind: 'percent', value: 3 },
    source: 'Euler–Bernoulli clamped-free beam frequencies · catalogue B4',
  },
  cantilever: {
    locator: { kind: 'extreme', field: 'displacement', component: 2, pick: 'min' },
    reference: { values: [0.1919619], unit: 'mm', label: '|uᶻ| at the tip' },
    tolerance: { kind: 'percent', value: 2 },
    magnitude: true,
    source: 'Euler–Bernoulli plus Timoshenko shear correction · catalogue B1',
  },
  'column-under-gravity': {
    locator: { kind: 'extreme', field: 'vonMises', component: 0, pick: 'max' },
    reference: { values: [0.0770085], unit: 'MPa', label: 'ρgL at the base' },
    tolerance: { kind: 'percent', value: 2 },
    source: 'Self-weight closed form σ = ρgL · bundled benchmark metadata',
  },
  'cook-membrane': {
    locator: { kind: 'probe', field: 'displacement', component: 1, at: ['48 mm', '52 mm', '0 mm'] },
    reference: { values: [23.9], unit: 'mm', label: 'uʸ at loaded-edge midpoint C' },
    tolerance: { kind: 'percent', value: 1 },
    source: 'Cook (1974), plane stress; converged value 23.9 · catalogue C4',
  },
  'explicit-free-fall': {
    locator: { kind: 'extreme', field: 'displacement', component: 2, pick: 'min' },
    reference: { values: [0.004905], unit: 'mm', label: '|uᶻ| after 1 ms' },
    tolerance: { kind: 'percent', value: 0.5 },
    magnitude: true,
    source: 'Constant-acceleration closed form gt²/2 · catalogue F1/F2',
  },
  'heated-fin-convection': {
    locator: { kind: 'extreme', field: 'temperature', component: 0, pick: 'min' },
    reference: { values: [37.39], unit: 'degC', label: 'temperature at the adiabatic tip' },
    tolerance: { kind: 'absolute', value: 0.5, unit: 'degC' },
    source: 'One-dimensional convection fin solution · bundled benchmark metadata',
  },
  'heated-fin': null,
  'kirsch-quarter-plate': {
    locator: { kind: 'extreme', field: 'stress', component: 0, pick: 'max' },
    reference: { values: [300], unit: 'MPa', label: 'σₓₓ at the hole edge' },
    tolerance: { kind: 'percent', value: 2 },
    source: 'Kirsch (1898), infinite plate Kₜ = 3 · catalogue C1',
  },
  'lame-cylinder-plane-strain': {
    locator: { kind: 'extreme', field: 'stress', component: 0, pick: 'min' },
    reference: { values: [-60], unit: 'MPa', label: 'σᵣᵣ at the bore' },
    tolerance: { kind: 'percent', value: 2 },
    source: 'Lamé thick-cylinder solution · catalogue C2',
  },
  'macneal-harder-beam': {
    locator: { kind: 'extreme', field: 'displacement', component: 1, pick: 'max' },
    reference: { values: [0.1081], unit: 'm', label: 'uʸ at the tip' },
    tolerance: { kind: 'percent', value: 2 },
    source: 'MacNeal & Harder, Finite Elements in Analysis and Design 1 (1985) · catalogue B2',
  },
  'mesh-convergence-cantilever': null,
  'nafems-le1-membrane': {
    locator: { kind: 'probe', field: 'stress', component: 1, at: ['2 m', '0 m', '0 m'] },
    reference: { values: [92.7], unit: 'MPa', label: 'σᵧᵧ at point D' },
    tolerance: { kind: 'percent', value: 2 },
    source: 'NAFEMS “The Standard NAFEMS Benchmarks” P18 (1990), LE1 · catalogue C5',
  },
  'nafems-le10-plate': null,
  'plate-with-hole-2d': null,
  'simply-supported-beam': null,
  'slab-strip': null,
  'thermal-stress-plate': {
    locator: { kind: 'probe', field: 'stress', component: 0, at: ['0.5 m', '0.5 m', '0 m'] },
    reference: { values: [-150], unit: 'MPa', label: 'σₓₓ at mid-height' },
    tolerance: { kind: 'percent', value: 2 },
    source: 'Restrained thermal-strain closed form −EαΔT/(1−ν) · catalogue C8',
  },
  'tube-under-pressure': null,
};

export interface ActiveBenchmark extends ExampleEntry {
  comparison: BenchmarkComparison | null;
  /** Model revision immediately after the bundled Journal finished replaying. */
  modelRevision: number;
}

export interface BenchmarkReading {
  actual: number[];
  reference: number[];
  unit: string;
  percent: number;
  delta: number;
  pass: boolean;
}

export type BenchmarkQuery = (q: Record<string, unknown> & { query: string }) => Promise<unknown>;

export function attachComparison(entry: ExampleEntry, modelRevision = 0): ActiveBenchmark {
  if (!Object.hasOwn(BENCHMARK_COMPARISONS, entry.name)) throw new FemError('file.not-found', `example '${entry.name}' has no comparison decision`, entry.name, 'add it to BENCHMARK_COMPARISONS');
  return { ...entry, comparison: BENCHMARK_COMPARISONS[entry.name]!, modelRevision };
}

/** Read the exact Result observable named by the example, including point probes when needed. */
export async function readBenchmark(comparison: BenchmarkComparison, result: ResultSummary, query: BenchmarkQuery): Promise<BenchmarkReading> {
  let values: Valued[];
  const at = comparison.locator;
  if (at.kind === 'extreme') {
    const extreme = result.extremes.find((e) => e.field === at.field && e.component === at.component);
    if (!extreme) throw new Error(`${at.field}.${at.component} is absent from this Result`);
    values = [extreme[at.pick]];
  } else if (at.kind === 'probe') {
    const probe = (await query({ query: 'query.probe', field: at.field, component: at.component, at: at.at })) as ProbeResult;
    values = [probe.value];
  } else {
    values = result.frequencies ?? [];
  }
  if (values.length !== comparison.reference.values.length) throw new Error(`expected ${comparison.reference.values.length} values, Result has ${values.length}`);
  values = await Promise.all(
    values.map(async (value) => {
      if (value.unit === comparison.reference.unit) return value;
      const converted = (await query({ query: 'query.convert', quantity: value, to: comparison.reference.unit })) as Partial<Valued>;
      if (typeof converted.value !== 'number' || converted.unit !== comparison.reference.unit) throw new Error(`could not convert ${value.unit} to ${comparison.reference.unit}`);
      return converted as Valued;
    }),
  );
  const actual = values.map((value) => value.value);
  const measured = comparison.magnitude ? actual.map(Math.abs) : actual;
  const reference = comparison.magnitude ? comparison.reference.values.map(Math.abs) : comparison.reference.values;
  const differences = measured.map((value, i) => Math.abs(value - reference[i]!));
  const percents = differences.map((value, i) => (Math.abs(reference[i]!) === 0 ? (value === 0 ? 0 : Infinity) : (value / Math.abs(reference[i]!)) * 100));
  const delta = Math.max(...differences);
  const percent = Math.max(...percents);
  const tolerance = comparison.tolerance;
  return { actual, reference: comparison.reference.values, unit: comparison.reference.unit, percent, delta, pass: tolerance.kind === 'percent' ? percent <= tolerance.value : tolerance.unit === comparison.reference.unit && delta <= tolerance.value };
}

export function clearsBenchmark(command: string, output: unknown = true): boolean {
  return command === 'model.new' || command === 'file.open' || (command === 'file.restore' && output !== null);
}
