import type { JournalDump, ModelSummary, ProbeResult, ResultSummary, StudyReport, Valued } from '@femlab/registry';
import { FemError } from '@femlab/registry';
import type { ExampleDifficulty } from './store';

export interface ExampleEntry {
  name: string;
  commands: number;
  summary: string;
  title: string;
  tag: string;
  theory: string;
  tags: string[];
  difficulty: ExampleDifficulty;
  thumbnail: string | null;
  expected: { quantity: string; value: number | number[]; unit: string; reference: string };
}

type Locator =
  | { kind: 'extreme'; field: string; component: number; pick: 'min' | 'max' }
  | { kind: 'probe'; field: string; component: number; at: [string, string, string] }
  | { kind: 'frequencies' }
  | { kind: 'study-extrapolated' };

type Tolerance = { kind: 'percent'; value: number } | { kind: 'absolute'; value: number; unit: string };

export interface BenchmarkComparison {
  locator: Locator;
  reference: { values: number[]; unit: string; label: string };
  tolerance?: Tolerance;
  /** Explanation shown when a useful approximation has no sourced validation tolerance. */
  informative?: string;
  magnitude?: boolean;
  source: string;
}

/**
 * The explicit bridge from bundled examples to Result observables. `null` means the cited theory
 * and the Result's available observable are not the same quantity; the companion reason names the
 * mismatch. Adding an example without deciding here fails the fixture test. LE10 uses the
 * independently published full-face support reference corrected by #183.
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
  'free-free-beam-modal': {
    locator: { kind: 'frequencies' },
    reference: { values: [0, 0, 0, 0, 0, 0, 133.34, 266.68], unit: 'Hz', label: 'the six rigid modes, then f₇ and f₈' },
    tolerance: { kind: 'absolute', value: 3, unit: 'Hz' },
    source: 'Six rigid-body modes at zero, then the free-free beam frequency formula with β₁ = 4.730041',
  },
  'heated-fin-convection': {
    locator: { kind: 'extreme', field: 'temperature', component: 0, pick: 'min' },
    reference: { values: [37.39], unit: 'degC', label: 'temperature at the adiabatic tip' },
    tolerance: { kind: 'absolute', value: 0.5, unit: 'degC' },
    source: 'One-dimensional convection fin solution · bundled benchmark metadata',
  },
  'heated-fin': {
    locator: { kind: 'extreme', field: 'displacement', component: 0, pick: 'max' },
    reference: { values: [0.1656], unit: 'mm', label: 'uˣ at the free tip' },
    tolerance: { kind: 'percent', value: 2 },
    source: 'Uniform thermal-strain closed form u = αΔTL · bundled dimensions and material data',
  },
  'kirsch-quarter-plate': {
    locator: { kind: 'extreme', field: 'stress', component: 0, pick: 'max' },
    reference: { values: [300], unit: 'MPa', label: 'σₓₓ at the hole edge' },
    tolerance: { kind: 'percent', value: 2 },
    source: 'Kirsch (1898), infinite plate Kₜ = 3 · catalogue C1',
  },
  'lame-cylinder-axisymmetric': {
    locator: { kind: 'extreme', field: 'stress', component: 2, pick: 'max' },
    reference: { values: [100], unit: 'MPa', label: 'σθθ at the bore' },
    tolerance: { kind: 'percent', value: 2 },
    source: 'Lamé thick-cylinder solution · catalogue C2',
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
  'mesh-convergence-cantilever': {
    locator: { kind: 'study-extrapolated' },
    reference: { values: [0.1904762], unit: 'mm', label: '|uᶻ| Richardson limit at the tip' },
    tolerance: { kind: 'percent', value: 0.2 },
    magnitude: true,
    source: 'Euler–Bernoulli bending solution PL³/3EI · catalogue B1; the bundled convergence example documents the ≤ 0.2% agreement',
  },
  'nafems-le1-membrane': {
    locator: { kind: 'probe', field: 'stress', component: 1, at: ['2 m', '0 m', '0 m'] },
    reference: { values: [92.7], unit: 'MPa', label: 'σᵧᵧ at point D' },
    tolerance: { kind: 'percent', value: 2 },
    source: 'NAFEMS “The Standard NAFEMS Benchmarks” P18 (1990), LE1 · catalogue C5',
  },
  'nafems-le10-plate': {
    locator: { kind: 'probe', field: 'stress', component: 1, at: ['2 m', '0 m', '0.6 m'] },
    reference: { values: [-5.25], unit: 'MPa', label: 'σᵧᵧ at upper-surface point D' },
    tolerance: { kind: 'percent', value: 2 },
    source: 'ESRD StressCheck Benchmarks Guide, pp. 29–31, full outer-face support variant',
  },
  'plate-with-hole-2d': null,
  'simply-supported-beam': null,
  'slab-strip': null,
  'thermal-stress-plate': {
    locator: { kind: 'probe', field: 'stress', component: 0, at: ['0.5 m', '0.5 m', '0 m'] },
    reference: { values: [-150], unit: 'MPa', label: 'σₓₓ at mid-height' },
    tolerance: { kind: 'percent', value: 2 },
    source: 'Restrained thermal-strain closed form −EαΔT/(1−ν) · catalogue C8',
  },
  'tube-under-pressure': {
    locator: { kind: 'probe', field: 'stress', component: 1, at: ['47.5 mm', '0 mm', '100 mm'] },
    reference: { values: [76], unit: 'MPa', label: 'σθ at the mid-wall, halfway from the base' },
    informative: 'Thin-wall membrane estimate only; no sourced pass/fail tolerance is assigned.',
    source: 'Thin-wall membrane estimate prₘ/t at the wall mid-surface; the probe is halfway from the welded-base boundary layer',
  },
};

/** Why a bundled reference cannot honestly be presented as a live pass/fail comparison. */
export const BENCHMARK_UNMAPPED_REASONS: Record<string, string> = {
  'bolt-flange': 'No live comparison: the quoted peak is a stair-stepped bolt-hole stress with only two or three elements across the hole. The metadata explicitly treats it as a load-path picture, not a converged stress oracle.',
  'bracket-L': 'No live comparison: the Result peak lies at the sharp re-entrant corner, where linear-elastic stress is singular and rises with refinement. There is no finite corner-stress reference to pass.',
  'plate-with-hole-2d': 'No live comparison: 3σ is the local hoop stress of an infinite plate, while this finite-width full model reports global Cartesian and von Mises extrema. Those are different stress quantities and locations.',
  'simply-supported-beam': 'No live comparison: the textbook formulas assume ideal line supports at the neutral axis, but this solid model restrains translation over both complete end faces. Its bundled expected value is the resulting global von Mises peak at a support, not the mid-span beam quantity.',
  'slab-strip': 'No live comparison: 6M/bh² is longitudinal stress at the mid-span extreme fibre for ideal line supports, but this solid model restrains both complete end faces. Its bundled expected value is the resulting global von Mises peak near a support.',
};

export interface BenchmarkProvenance {
  /** Model identity, separate from the display title stored in the example metadata. */
  modelName: string | null;
  modelHash: string | null;
  modelRevision: number;
  /** Complete Journal-history identity at the end of the bundled replay. */
  journalHash: string | null;
}

export interface ActiveBenchmark extends ExampleEntry, BenchmarkProvenance {
  comparison: BenchmarkComparison | null;
}

export interface BenchmarkReading {
  actual: number[];
  reference: number[];
  unit: string;
  percent: number;
  delta: number;
  pass: boolean | null;
}

export type BenchmarkQuery = (q: Record<string, unknown> & { query: string }) => Promise<unknown>;

/**
 * Use the engine's complete-history hash when available. Older engines expose the exact history
 * instead, so the serialized entry sequence remains an unambiguous fallback across undo/branch.
 */
export function completeJournalHash(journal: JournalDump | null): string | null {
  if (!journal) return null;
  const supplied = (journal as JournalDump & { hash?: unknown }).hash;
  return typeof supplied === 'string' ? supplied : JSON.stringify(journal.entries.map(({ seq, cmd, hashAfter }) => [seq, cmd, hashAfter]));
}

export function benchmarkProvenance(model: ModelSummary | null, journal: JournalDump | null, revision: number): BenchmarkProvenance {
  return { modelName: model?.name ?? null, modelHash: model?.hash ?? null, modelRevision: revision, journalHash: completeJournalHash(journal) };
}

/** True once a different Model or a different Journal history occupies the same revision. */
export function benchmarkChanged(benchmark: BenchmarkProvenance, current: BenchmarkProvenance): boolean {
  return !benchmark.modelHash || !benchmark.journalHash || benchmark.modelName !== current.modelName || benchmark.modelHash !== current.modelHash || benchmark.modelRevision !== current.modelRevision || benchmark.journalHash !== current.journalHash;
}

export function attachComparison(entry: ExampleEntry, provenance: BenchmarkProvenance = { modelName: null, modelHash: null, modelRevision: 0, journalHash: null }): ActiveBenchmark {
  if (!Object.hasOwn(BENCHMARK_COMPARISONS, entry.name)) throw new FemError('file.not-found', `example '${entry.name}' has no comparison decision`, entry.name, 'add it to BENCHMARK_COMPARISONS');
  return { ...entry, comparison: BENCHMARK_COMPARISONS[entry.name]!, ...provenance };
}

/** Read the exact Result observable named by the example, including point probes when needed. */
export async function readBenchmark(comparison: BenchmarkComparison, result: ResultSummary, query: BenchmarkQuery, study: StudyReport | null = null): Promise<BenchmarkReading> {
  let values: Valued[];
  const at = comparison.locator;
  if (at.kind === 'extreme') {
    const extreme = result.extremes.find((e) => e.field === at.field && e.component === at.component);
    if (!extreme) throw new Error(`${at.field}.${at.component} is absent from this Result`);
    values = [extreme[at.pick]];
  } else if (at.kind === 'probe') {
    const probe = (await query({ query: 'query.probe', step: result.step, field: at.field, component: at.component, at: at.at })) as ProbeResult;
    values = [probe.value];
  } else if (at.kind === 'frequencies') {
    values = result.frequencies ?? [];
  } else {
    if (!study || study.rows.length < 3 || typeof study.extrapolated !== 'number') throw new Error('this Result has no three-mesh convergence-study extrapolation');
    values = [{ value: study.extrapolated, unit: study.unit }];
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
  return { actual, reference: comparison.reference.values, unit: comparison.reference.unit, percent, delta, pass: tolerance ? (tolerance.kind === 'percent' ? percent <= tolerance.value : tolerance.unit === comparison.reference.unit && delta <= tolerance.value) : null };
}

export function clearsBenchmark(command: string, output: unknown = true): boolean {
  return ['model.new', 'file.open', 'project.open', 'project.new'].includes(command) || (command === 'file.restore' && output !== null);
}
