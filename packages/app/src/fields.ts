// What a Result field is called, what dimension it carries and how it reaches a legend. Pure
// and dependency-free, so the engine Worker and the viewer chrome can share one table instead
// of two that drift. The dimensions mirror `field_dimension` in crates/engine/src/solve_run.rs.
import type { Field, UnitSet } from '@femlab/registry';

/** SI unit per dimension, the same strings `query.convert` normalises to. */
export const SI_UNIT: Record<string, string> = {
  length: 'm',
  force: 'N',
  stress: 'Pa',
  temperature: 'K',
  dimensionless: '',
};

export const FIELD_DIMENSION: Record<Field, keyof typeof SI_UNIT> = {
  displacement: 'length',
  reaction: 'force',
  stress: 'stress',
  stressUnaveraged: 'stress',
  vonMises: 'stress',
  principal: 'stress',
  strain: 'dimensionless',
  temperature: 'temperature',
};

/** The SI unit a raw `transport.field` array is in. */
export function siUnitOf(field: Field): string {
  return SI_UNIT[FIELD_DIMENSION[field]] ?? '';
}

/** The unit the Model displays that dimension in, falling back to SI when it names none. */
export function displayUnitOf(field: Field, units: UnitSet | undefined): string {
  const dim = FIELD_DIMENSION[field];
  const named = (units as Record<string, string | null | undefined> | undefined)?.[dim];
  return named ?? siUnitOf(field);
}

/** One entry of the legend's field picker: what to fetch and what to call it. */
export interface FieldChoice {
  key: string;
  label: string;
  field: Field;
  /** `null` with `magnitude` fetches every component; `null` alone fetches the scalar. */
  component: number | null;
  magnitude?: true;
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
  ...VEC.map((a, i) => ({ key: `u${a}`, label: `u${a}`, field: 'displacement' as Field, component: i })),
  ...VOIGT.map((a, i) => ({ key: `s${a}`, label: `σ${a}`, field: 'stress' as Field, component: i })),
  ...[0, 1, 2].map((i) => ({ key: `p${i + 1}`, label: `σ${i + 1}`, field: 'principal' as Field, component: i })),
  { key: 'temperature', label: 'T', field: 'temperature', component: 0 },
];

/** The picker's rows for a Result: temperature only when the Step actually computed one. */
export function fieldChoices(fields: string[]): FieldChoice[] {
  return FIELD_CHOICES.filter((c) => fields.includes(c.field));
}

export function choiceOf(key: string): FieldChoice {
  return FIELD_CHOICES.find((c) => c.key === key) ?? FIELD_CHOICES[0]!;
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
