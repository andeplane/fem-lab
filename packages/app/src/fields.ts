// What a Result field is called, what dimension it carries and how it reaches a legend. Pure
// and dependency-free, so the engine Worker and the viewer chrome can share one table instead
// of two that drift. The dimensions mirror `field_dimension` in crates/engine/src/solve_run.rs.
//
// A "field" here is the wire name `Engine::field_named` takes: a `Field` spelling
// (`displacement`, `vonMises`, …) or `mode:k` for the k-th mode shape of a modal or buckling Step. Two
// more names never reach the engine at all — `safety` and `utilisation` are computed in the
// app from von Mises and the Material's yield, which is why they carry a `derived` tag.
import type { Field, ResultSummary, UnitSet } from '@femlab/registry';

/** SI unit per dimension, the same strings `query.convert` normalises to. */
export const SI_UNIT: Record<string, string> = {
  length: 'm',
  force: 'N',
  power: 'W',
  stress: 'Pa',
  temperature: 'K',
  torque: 'N m',
  dimensionless: '',
};

export const FIELD_DIMENSION: Record<Field, keyof typeof SI_UNIT> = {
  displacement: 'length',
  reaction: 'force',
  stress: 'stress',
  stressUnaveraged: 'stress',
  stressTop: 'stress',
  stressBottom: 'stress',
  vonMises: 'stress',
  principal: 'stress',
  strain: 'dimensionless',
  plasticStrain: 'dimensionless',
  temperature: 'temperature',
  rotation: 'dimensionless',
  sectionForce: 'force',
  sectionMoment: 'torque',
};

/** `mode:3` is a displacement; a safety factor and a utilisation are pure numbers. */
export function dimensionOf(field: string, reactionQuantity: 'force' | 'power' = 'force'): keyof typeof SI_UNIT {
  if (field === 'reaction') return reactionQuantity;
  if (field.startsWith('mode:')) return 'length';
  if (field === 'safety' || field === 'utilisation') return 'dimensionless';
  return FIELD_DIMENSION[field as Field] ?? 'dimensionless';
}

/** The SI unit a raw `transport.field` array is in. */
export function siUnitOf(field: string, reactionQuantity: 'force' | 'power' = 'force'): string {
  return SI_UNIT[dimensionOf(field, reactionQuantity)] ?? '';
}

/** The unit the Model displays that dimension in, falling back to SI when it names none. */
export function displayUnitOf(field: string, units: UnitSet | undefined, reactionQuantity: 'force' | 'power' = 'force'): string {
  const dim = dimensionOf(field, reactionQuantity);
  const named = (units as Record<string, string | null | undefined> | undefined)?.[dim];
  return named ?? siUnitOf(field, reactionQuantity);
}

/** One entry of the legend's field picker: what to fetch and what to call it. */
export interface FieldChoice {
  key: string;
  label: string;
  /** The wire name `transport.field` takes; `vonMises` for the two derived choices. */
  field: string;
  /** `null` with `magnitude` fetches every component; `null` alone fetches the scalar. */
  component: number | null;
  magnitude?: true;
  /**
   * Computed in the app from the fetched array rather than by the engine: `safety` is
   * `yield / σ_vM`, `utilisation` is `σ_vM / yield`. Both need the Material's yield.
   */
  derived?: 'safety' | 'utilisation';
  /** The k of a `mode:k` shape, so the deformation bar knows to sweep it sinusoidally. */
  mode?: number;
}

const VEC = ['x', 'y', 'z'];
const VOIGT = ['xx', 'yy', 'zz', 'xy', 'xz', 'yz'];

/**
 * Every scalar the viewer can contour, in the order the design's picker lists them: the one
 * number an engineer looks at first, then the displacement, then the stress components.
 */
export const FIELD_CHOICES: FieldChoice[] = [
  { key: 'vonMises', label: 'σ_vM', field: 'vonMises', component: 0 },
  { key: 'umag', label: '|u|', field: 'displacement', component: null, magnitude: true },
  ...VEC.map((a, i) => ({ key: `u${a}`, label: `u${a}`, field: 'displacement', component: i })),
  ...VOIGT.map((a, i) => ({ key: `s${a}`, label: `σ${a}`, field: 'stress', component: i })),
  ...[0, 1, 2].map((i) => ({ key: `p${i + 1}`, label: `σ${i + 1}`, field: 'principal', component: i })),
  { key: 'peeq', label: 'ε̄ᵖ', field: 'plasticStrain', component: 0 },
  { key: 'temperature', label: 'T', field: 'temperature', component: 0 },
];

/** `yield / σ_vM` and its reciprocal: the two numbers a check is actually written against. */
export const DERIVED_CHOICES: FieldChoice[] = [
  { key: 'safety', label: 'n_y', field: 'vonMises', component: 0, derived: 'safety' },
  { key: 'utilisation', label: 'σ/f_y', field: 'vonMises', component: 0, derived: 'utilisation' },
];

type ModeSpectrum = Pick<ResultSummary, 'frequencies' | 'bucklingFactors'>;

/** Modal frequencies and buckling factors each identify one displacement mode shape. */
export function modeCount(result: ModeSpectrum | null | undefined): number {
  return result?.frequencies?.length || result?.bucklingFactors?.length || 0;
}

/** The k-th mode shape, contoured by its magnitude and swept by the deformation bar. */
export function modeChoice(k: number, result?: ModeSpectrum | null): FieldChoice {
  const factor = result?.frequencies?.length ? undefined : result?.bucklingFactors?.[k - 1];
  const label = factor === undefined ? `mode ${k}` : `Mode ${k} · λ ${formatNumber(factor)}`;
  return { key: `mode:${k}`, label, field: `mode:${k}`, component: null, magnitude: true, mode: k };
}

/**
 * The picker's rows for a Result: the fields the Step computed, then one row per mode shape
 * it found, then the two derived rows once a Material names a yield.
 */
export function fieldChoices(fields: string[], modes: number | ModeSpectrum | null = 0, hasYield = false): FieldChoice[] {
  return [
    ...FIELD_CHOICES.filter((c) => fields.includes(c.field)),
    ...Array.from({ length: typeof modes === 'number' ? modes : modeCount(modes) }, (_, i) => modeChoice(i + 1, typeof modes === 'number' ? undefined : modes)),
    ...(hasYield && fields.includes('vonMises') ? DERIVED_CHOICES : []),
  ];
}

/**
 * The `view.showField` arguments that select this choice. A derived check is named by its own
 * key even though the array it reads is von Mises — otherwise its chip would be the σ_vM chip.
 */
export function showFieldArgs(c: FieldChoice): { field: string; component?: number } {
  if (c.derived) return { field: c.key };
  return { field: c.field, ...(c.component === null ? {} : { component: c.component }) };
}

export function choiceOf(key: string, result?: ModeSpectrum | null): FieldChoice {
  const known = [...FIELD_CHOICES, ...DERIVED_CHOICES].find((c) => c.key === key);
  if (known) return known;
  const k = /^mode:(\d+)$/.exec(key);
  return k ? modeChoice(Number(k[1]), result) : FIELD_CHOICES[0]!;
}

/**
 * A number as the design's mono tables write it: four significant figures, exponential once
 * the plain form would be unreadable. `-0` is written as `0`, which is what a reader expects.
 */
export function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs >= 1e5 || abs < 1e-3) return v.toExponential(3);
  return String(Number(v.toPrecision(4)));
}

/** The legend's ticks, top (max) first, so the strip reads down the gradient bar. */
export function legendTicks(lo: number, hi: number, n = 6): string[] {
  const span = hi - lo;
  return Array.from({ length: n }, (_, i) => formatNumber(hi - (span * i) / (n - 1)));
}
