// Design states 4–7 (Solving, Results, Stale, Error) as one object: what the viewer draws once
// a Step has been solved, and how the `view.*` Commands reach it. Everything a person can do
// here is still one Command — this is only where the Command lands.
//
// Values arrive from the engine in SI and are shown in the Model's own units, so the array the
// viewer colours by is scaled once, here, with the factor `query.convert` gives; the deformed
// shape stays in SI because the mesh coordinates are.
import type { ResultSummary, StudyReport, Warning } from '@femlab/registry';
import { FIELD_CHOICES, choiceOf, type FieldChoice, displayUnitOf, fieldChoices, siUnitOf } from './fields';
import type { ViewerRef } from './host';
import type { Store } from './store';
import type { WorkerTransport } from './worker-transport';

/** `view.setDeformScale`'s argument. */
export type DeformScale = number | 'auto' | 'true';

/**
 * The contoured array for a derived choice. `safety` is `f_y / σ_vM` — unbounded where the
 * stress is nil, so it is capped at `CAP`, which is also where the legend stops; `utilisation`
 * is its reciprocal and needs no cap. Both take σ in the same units as the yield, which is why
 * the caller passes SI on both sides.
 */
export const SAFETY_CAP = 10;

export function derive(vonMises: Float32Array, yieldSi: number, kind: 'safety' | 'utilisation'): Float32Array {
  const out = new Float32Array(vonMises.length);
  for (let i = 0; i < out.length; i++) {
    const s = Math.abs(vonMises[i]!);
    out[i] = kind === 'utilisation' ? s / yieldSi : s === 0 ? SAFETY_CAP : Math.min(SAFETY_CAP, yieldSi / s);
  }
  return out;
}

/**
 * The range a derived field's legend opens on: a utilisation reads against 1 (the limit), a
 * safety factor against the cap, and both keep whatever the data actually reached.
 */
export function derivedRange(kind: 'safety' | 'utilisation', max: number): [number, number] {
  return kind === 'utilisation' ? [0, Math.max(1, max)] : [0, Math.min(SAFETY_CAP, Math.max(1, max))];
}

/**
 * The picker key to contour a Result by: the one already chosen when this Result has it, the
 * first mode shape when it is a modal Step, and otherwise the first field it did compute. A
 * Result is not obliged to carry the field the previous one did.
 */
export function available(current: string, result: ResultSummary, hasYield: boolean): string {
  const choices = fieldChoices(
    result.extremes.map((e) => e.field),
    result.frequencies?.length ?? 0,
    hasYield,
  );
  if (choices.some((c) => c.key === current)) return current;
  return (result.frequencies?.length ?? 0) > 0 ? 'mode:1' : (choices[0]?.key ?? 'vonMises');
}

export class ResultsView {
  /** Nodal displacement in SI for the shown Step, and what it was loaded for. */
  private displacement: Float32Array | null = null;
  private loadedFor = '';
  private factors = new Map<string, number>();

  constructor(
    private readonly store: Store,
    private readonly transport: WorkerTransport,
    private readonly viewer: ViewerRef,
  ) {}

  /** display = SI × factor, asked of the engine once per unit pair rather than tabulated here. */
  private async factor(field: string): Promise<number> {
    const si = siUnitOf(field);
    const to = displayUnitOf(field, this.store.state.model?.units);
    if (si === to) return 1;
    const key = `${si}→${to}`;
    const hit = this.factors.get(key);
    if (hit !== undefined) return hit;
    const { value } = (await this.transport.query({ query: 'query.convert', quantity: { value: 1, unit: si }, to } as never)) as { value: number };
    this.factors.set(key, value);
    return value;
  }

  /** The current materials' smallest yield in pascals — the conservative one — or `null`. */
  private async readYield(): Promise<number | null> {
    const quantities = (this.store.state.model?.materials ?? []).flatMap((material) => material.yield ? [material.yield] : []);
    if (quantities.length === 0) return null;
    const values = await Promise.all(
      quantities.map((quantity) =>
        this.transport
          .query({ query: 'query.convert', quantity, to: 'Pa' } as never)
          .then((c) => (c as { value: number }).value)
          .catch(() => null),
      ),
    );
    const good = values.filter((v): v is number => v !== null && Number.isFinite(v) && v > 0);
    return good.length === 0 ? null : Math.min(...good);
  }

  /**
   * Re-read `query.result` and, when the Step or the chosen field changed, the arrays behind
   * the contours. Called after every engine Command, so it has to be cheap when nothing moved.
   */
  async refresh(force = false): Promise<void> {
    const result = await this.readResult();
    this.store.set({ result });
    if (!result) {
      this.loadedFor = '';
      this.displacement = null;
      this.viewer.current?.setField(null, [0, 1]);
      this.viewer.current?.setDeformed(null, 0);
      this.store.set({ legend: null, yieldStress: null });
      return;
    }
    this.viewer.current?.setDim(result.stale);
    // A modal Step computes no stress and a heat Step no displacement, so the field the last
    // Result was contoured by may not exist in this one. Choosing before loading is what keeps
    // a solve from failing on `step 'modes' has no vonMises field`.
    const yieldStress = await this.readYield();
    const fieldKey = available(this.store.state.fieldKey, result, yieldStress !== null);
    this.store.set({ yieldStress, ...(fieldKey === this.store.state.fieldKey ? {} : { fieldKey }) });
    const key = `${result.step}|${fieldKey}|${String(this.store.state.clamp)}|${this.store.state.journal?.revision ?? 0}`;
    if (!force && key === this.loadedFor) return;
    this.loadedFor = key;
    await this.load(result);
  }

  private async readResult(): Promise<ResultSummary | null> {
    // No Step has been solved is a normal state, not a failure: `query.result` says so with
    // `not-found`, which is the one error this call swallows.
    try {
      return (await this.transport.query({ query: 'query.result' })) as ResultSummary;
    } catch {
      return null;
    }
  }

  /** Fetch the contoured scalar and the displacement, and hand both to the viewer. */
  private async load(result: ResultSummary): Promise<void> {
    const v = this.viewer.current;
    // No Viewer yet (its chunk is still arriving): forget the key, so the refresh the Viewer
    // asks for on arrival loads the arrays instead of finding them "already loaded".
    if (!v) {
      this.loadedFor = '';
      return;
    }
    const choice = choiceOf(this.store.state.fieldKey);
    const scalar = await this.transport.field(result.step, choice.field as never, choice.component ?? undefined);
    const { values, range, unit } = await this.contour(choice, scalar.values);
    v.setField(values, range);
    this.store.set({ legend: { min: range[0], max: range[1], unit } });

    // A mode shape is its own deformation; every other field rides on the Step's displacement,
    // which a heat Step does not have — there the mesh simply stays where it is.
    const moves = choice.mode !== undefined || result.extremes.some((e) => e.field === 'displacement');
    this.displacement = !moves ? null : choice.mode === undefined ? (await this.transport.field(result.step, 'displacement')).values : scalar.values;
    this.store.set({ lengthFactor: await this.factor('displacement') });
    v.setDeformed(this.displacement, this.store.state.deformScale);
    // A mode's amplitude is arbitrary, so it opens at a visible one rather than at ×1.
    if (choice.mode !== undefined) this.setDeformScale('auto');
  }

  /** The array the viewer colours by, in display units, and the range and unit for the legend. */
  private async contour(choice: FieldChoice, raw: Float32Array): Promise<{ values: Float32Array; range: [number, number]; unit: string }> {
    const yieldSi = this.store.state.yieldStress;
    if (choice.derived && yieldSi !== null) {
      const values = derive(raw, yieldSi, choice.derived);
      const [, max] = extent(values);
      return { values, range: this.store.state.clamp ?? derivedRange(choice.derived, max), unit: '' };
    }
    const factor = await this.factor(choice.field);
    const values = magnitude(raw, choice.magnitude === true);
    for (let i = 0; i < values.length; i++) values[i] = values[i]! * factor;
    const [min, max] = extent(values);
    return { values, range: this.store.state.clamp ?? [min, max], unit: displayUnitOf(choice.field, this.store.state.model?.units) };
  }

  /** `view.showField`: `{ field: null }` turns contours off, anything else picks a scalar. */
  async showField(f: { field: string | null; component?: number | null }): Promise<void> {
    if (!f.field) {
      this.store.set({ viewMode: 'geometry' });
      this.viewer.current?.setMode('geometry');
      this.viewer.current?.setField(null, [0, 1]);
      return;
    }
    const key = fieldKeyOf(f.field, f.component ?? null);
    this.store.set({ fieldKey: key, viewMode: 'results' });
    this.viewer.current?.setMode('results');
    await this.refresh(true);
  }

  /** `view.setLegend`: the colour map, and the clamp that stops one hot node flattening the rest. */
  async setLegend(l: { colormap?: string; range?: [number, number] | 'auto' }): Promise<void> {
    if (l.colormap) {
      this.store.set({ colormap: l.colormap as never });
      this.viewer.current?.setColormap(l.colormap as never);
    }
    if (l.range !== undefined) {
      this.store.set({ clamp: l.range === 'auto' ? null : l.range });
      await this.refresh(true);
    }
  }

  /** `view.setDeformScale`: `"true"` is ×1, `"auto"` makes the largest displacement visible. */
  setDeformScale(s: DeformScale): void {
    const v = this.viewer.current;
    const scale = typeof s === 'number' ? s : s === 'true' ? 1 : this.displacement && v ? v.autoScale(this.displacement) : 1;
    this.store.set({ deformScale: scale });
    v?.setDeformed(this.displacement, scale);
  }

  /** What the legend burns into a screenshot; `null` outside Results mode. */
  legendBurn(): { title: string; unit: string; min: number; max: number; colormap: string; scale: number } | null {
    const { legend, fieldKey, colormap, viewMode, screenshotScale } = this.store.state;
    if (!legend || viewMode !== 'results') return null;
    return { title: choiceOf(fieldKey).label, unit: legend.unit, min: legend.min, max: legend.max, colormap, scale: screenshotScale };
  }

  /**
   * A Command's Ack, after the Journal has been re-read: a solve opens the Results tab and the
   * contours (design "Solve completion"), a study keeps its report for the convergence bars.
   */
  async onAck(ack: unknown): Promise<void> {
    const out = (ack as { output?: { type?: string; report?: StudyReport } } | undefined)?.output;
    if (out?.type === 'study' && out.report) this.store.set({ study: out.report });
    if (out?.type !== 'solve') return;
    const warnings = (ack as { warnings?: Warning[] }).warnings ?? [];
    this.store.set({ tab: 'results', viewMode: 'results', assumptions: warnings });
    this.viewer.current?.setMode('results');
    await this.refresh(true);
    // A real displacement is invisible at ×1, so a fresh Result opens exaggerated (design §5).
    this.setDeformScale('auto');
  }
}

/** The smallest and largest of an array, in one pass. */
export function extent(values: Float32Array): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const x of values) {
    if (x < min) min = x;
    if (x > max) max = x;
  }
  return [Number.isFinite(min) ? min : 0, Number.isFinite(max) ? max : 1];
}

/** Three components per node collapsed to their length, or the array as it came. */
export function magnitude(values: Float32Array, on: boolean): Float32Array {
  if (!on) return values;
  const out = new Float32Array(values.length / 3);
  for (let i = 0; i < out.length; i++) out[i] = Math.hypot(values[i * 3]!, values[i * 3 + 1]!, values[i * 3 + 2]!);
  return out;
}

/** `view.showField { field, component }` → the picker key that names the same scalar. */
export function fieldKeyOf(field: string, component: number | null): string {
  if (field.startsWith('mode:') || field === 'safety' || field === 'utilisation') return field;
  const exact = FIELD_CHOICES.find((c) => c.field === field && c.component === component);
  return (exact ?? FIELD_CHOICES.find((c) => c.field === field))?.key ?? 'vonMises';
}
