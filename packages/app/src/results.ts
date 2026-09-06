// Design states 4–7 (Solving, Results, Stale, Error) as one object: what the viewer draws once
// a Step has been solved, and how the `view.*` Commands reach it. Everything a person can do
// here is still one Command — this is only where the Command lands.
//
// Values arrive from the engine in SI and are shown in the Model's own units, so the array the
// viewer colours by is converted once, here, with the scale and offset `query.convert` gives; the deformed
// shape stays in SI because the mesh coordinates are.
import { FemError, type FrameResult, type FramesResult, type ResultSummary, type StudyReport, type Warning } from '@femlab/registry';
import { FIELD_CHOICES, choiceOf, type FieldChoice, displayUnitOf, fieldChoices, siUnitOf } from './fields';
import type { ViewerRef } from './host';
import type { Store } from './store';
import type { WorkerTransport } from './worker-transport';
import { TransientPlayback, type PlaybackClock, type TransientInput } from './transient';

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
  private conversions = new Map<string, { scale: number; offset: number }>();
  /** What was *asked* for, not what it resolved to: an `"auto"` that could not be computed while
   *  the Viewer or the displacement was missing is recomputed on the next `load`, and a person
   *  who typed ×200 keeps ×200 across a field switch and a re-solve. */
  private requested: DeformScale = 'auto';
  private selectedStep: string | undefined;
  private readonly transient: TransientPlayback;
  private displayEpoch = 0;

  constructor(
    private readonly store: Store,
    private readonly transport: WorkerTransport,
    private readonly viewer: ViewerRef,
    clock?: PlaybackClock,
  ) {
    this.transient = new TransientPlayback(transport, clock,
      (frame, catalogue) => this.prepareFrame(frame, catalogue),
      (state) => store.set({ transient: state }),
      (error) => store.fail(error));
    viewer.previewTransient = (input) => this.playTransient(input);
  }

  invalidateTransient(): void {
    this.displayEpoch++;
    this.transient.invalidate();
  }

  playTransient(input: TransientInput): Promise<void> {
    this.displayEpoch++;
    return this.transient.select(input);
  }

  private async prepareFrame(frame: FrameResult, catalogue: FramesResult): Promise<() => void> {
    const result = await this.transport.query({ query: 'query.result', step: catalogue.step }) as ResultSummary;
    if (result.stale || frame.sample.modelHash !== catalogue.modelHash || frame.sample.step !== catalogue.step)
      throw new FemError('result.stale', 'the Result changed while its frame was loading', 'view.playTransient', 'solve.run for this Step');
    const current = choiceOf(this.store.state.fieldKey);
    const choice = current.field === frame.field && !current.derived ? current : choiceOf(frame.field === 'temperature' ? 'temperature' : 'umag');
    const raw = choice.component === null
      ? new Float32Array(frame.values)
      : Float32Array.from({ length: frame.nodeCount }, (_, node) => frame.values[node * frame.components + choice.component!]!);
    const contour = await this.contour(choice, raw);
    const displacement = frame.field === 'displacement' ? new Float32Array(frame.values) : null;
    const lengthFactor = (await this.conversion('displacement')).scale;
    return () => {
      this.selectedStep = catalogue.step;
      this.displacement = displacement;
      this.viewer.current?.animate(false);
      this.viewer.current?.setDim(false);
      this.viewer.current?.setMode('results');
      this.viewer.current?.setField(contour.values, contour.range);
      this.viewer.current?.setDeformed(displacement, this.store.state.deformScale);
      this.store.set({ result, fieldKey: choice.key, viewMode: 'results', playing: false, lengthFactor,
        legend: { min: contour.range[0], max: contour.range[1], unit: contour.unit } });
    };
  }

  /** display = SI × scale + offset, derived from the engine once per unit pair. */
  private async conversion(field: string): Promise<{ scale: number; offset: number }> {
    const si = siUnitOf(field);
    const to = displayUnitOf(field, this.store.state.model?.units);
    if (si === to) return { scale: 1, offset: 0 };
    const key = `${si}→${to}`;
    const hit = this.conversions.get(key);
    if (hit !== undefined) return hit;
    const [zero, one] = await Promise.all([0, 1].map(async (value) =>
      (await this.transport.query({ query: 'query.convert', quantity: { value, unit: si }, to } as never)) as { value: number },
    ));
    const conversion = { scale: one!.value - zero!.value, offset: zero!.value };
    this.conversions.set(key, conversion);
    return conversion;
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
    const epoch = this.displayEpoch;
    const result = await this.readResult();
    if (epoch !== this.displayEpoch) return;
    this.store.set({ result });
    const transient = this.store.state.transient;
    if (transient) {
      if (!result || result.stale || result.step !== transient.catalogue.step) this.invalidateTransient();
      else {
        if (force) await this.playTransient({ step: result.step, playing: transient.playing, speed: transient.speed });
        return;
      }
    }
    if (!result) {
      this.selectedStep = undefined;
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
    if (epoch !== this.displayEpoch) return;
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
      return (await this.transport.query({ query: 'query.result', ...(this.selectedStep === undefined ? {} : { step: this.selectedStep }) })) as ResultSummary;
    } catch {
      return null;
    }
  }

  /** Fetch the contoured scalar and the displacement, and hand both to the viewer. */
  private async load(result: ResultSummary): Promise<void> {
    const epoch = this.displayEpoch;
    const v = this.viewer.current;
    // No Viewer yet (its chunk is still arriving), or one that has not been handed a surface:
    // its bounding box is still the placeholder, so an `"auto"` computed here would exaggerate
    // against the wrong model size — the ×1311 of the report. Forget the key either way, so the
    // refresh that follows the surface push loads the arrays instead of finding them "loaded".
    if (!v?.hasSurface) {
      this.loadedFor = '';
      return;
    }
    const choice = choiceOf(this.store.state.fieldKey);
    const scalar = await this.transport.field(result.step, choice.field as never, choice.component ?? undefined);
    const { values, range, unit } = await this.contour(choice, scalar.values);

    // A mode shape is its own deformation; every other field rides on the Step's displacement,
    // which a heat Step does not have — there the mesh simply stays where it is.
    const moves = choice.mode !== undefined || result.extremes.some((e) => e.field === 'displacement');
    const displacement = !moves ? null : choice.mode === undefined ? (await this.transport.field(result.step, 'displacement')).values : scalar.values;
    const lengthFactor = (await this.conversion('displacement')).scale;
    if (epoch !== this.displayEpoch) return;
    this.displacement = displacement;
    v.setField(values, range);
    this.store.set({ legend: { min: range[0], max: range[1], unit }, lengthFactor });
    // A mode's amplitude is arbitrary, so it opens at a visible one rather than at ×1.
    if (choice.mode !== undefined) this.requested = 'auto';
    // The one code path: the field and the deformation are pushed by the same function, in the
    // same order, every time — so every field shows the same shape at the same scale (#42).
    this.setDeformScale(this.requested);
  }

  /** The array the viewer colours by, in display units, and the range and unit for the legend. */
  private async contour(choice: FieldChoice, raw: Float32Array): Promise<{ values: Float32Array; range: [number, number]; unit: string }> {
    const yieldSi = this.store.state.yieldStress;
    if (choice.derived && yieldSi !== null) {
      const values = derive(raw, yieldSi, choice.derived);
      const [, max] = extent(values);
      return { values, range: this.store.state.clamp ?? derivedRange(choice.derived, max), unit: '' };
    }
    const { scale, offset } = await this.conversion(choice.field);
    const values = magnitude(raw, choice.magnitude === true);
    for (let i = 0; i < values.length; i++) values[i] = values[i]! * scale + offset;
    const [min, max] = extent(values);
    return { values, range: this.store.state.clamp ?? [min, max], unit: displayUnitOf(choice.field, this.store.state.model?.units) };
  }

  /** `view.showField`: `{ field: null }` turns contours off, anything else picks a scalar. */
  async showField(f: { field: string | null; component?: number | null }): Promise<void> {
    if (f.field === null) {
      this.invalidateTransient();
      this.store.set({ viewMode: 'geometry' });
      this.viewer.current?.setMode('geometry');
      this.viewer.current?.setField(null, [0, 1]);
      return;
    }
    const key = fieldKeyOf(f.field, f.component ?? null);
    const result = this.store.state.result;
    const choices = result
      ? fieldChoices(result.extremes.map((e) => e.field), result.frequencies?.length ?? 0, this.store.state.yieldStress !== null)
      : [];
    if (!result || !choices.some((c) => c.key === key)) throw unavailableField(f.field, f.component ?? null);
    if (this.store.state.transient && choiceOf(key).field !== this.store.state.transient.catalogue.field)
      throw new FemError('unsupported', `retained frames contain only ${this.store.state.transient.catalogue.field}`, 'view.showField', 'query.frames for available historical fields');
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
    this.requested = s;
    const scale = typeof s === 'number' ? s : s === 'true' ? 1 : this.displacement && v ? v.autoScale(this.displacement) : 1;
    this.store.set({ deformScale: scale });
    v?.setDeformed(this.displacement, scale);
  }

  /** Select the requested solved Step/mode before applying playback speed or phase. */
  async animate(a: { step: string; mode?: number; playing: boolean; speed?: number; frame?: number }): Promise<void> {
    const epoch = ++this.displayEpoch;
    const hadTransient = this.store.state.transient !== null;
    const result = await this.transport.query({ query: 'query.result', step: a.step }) as ResultSummary;
    if (epoch !== this.displayEpoch) return;
    if (a.mode !== undefined && a.mode > (result.frequencies?.length ?? 0))
      throw new FemError('not-found', `Step '${a.step}' has no mode ${a.mode}`, 'view.animate.mode', 'query.result for the available modes');
    if (a.mode === undefined && !result.extremes.some((e) => e.field === 'displacement') && !result.frequencies?.length)
      throw new FemError('unsupported', `Step '${a.step}' has no displacement to animate`, 'view.animate', 'view.showField to inspect its static field');
    this.invalidateTransient();
    const fieldKey = a.mode === undefined ? available(this.store.state.fieldKey, result, this.store.state.yieldStress !== null) : `mode:${a.mode}`;
    const needsLoad = hadTransient || this.selectedStep !== a.step || this.store.state.result?.step !== a.step || this.store.state.fieldKey !== fieldKey;
    this.selectedStep = a.step;
    this.store.set({ result, fieldKey, viewMode: 'results' });
    this.viewer.current?.setMode('results');
    const loadingEpoch = this.displayEpoch;
    if (needsLoad) await this.load(result);
    if (loadingEpoch !== this.displayEpoch) return;
    const phase = a.frame === undefined ? undefined : a.frame / 100;
    const speed = a.speed ?? this.store.state.animationSpeed;
    this.viewer.current?.animate(a.playing, speed, phase);
    this.store.set({ playing: a.playing, animationSpeed: speed, phase: phase ?? (a.playing ? 0 : 0.25) });
  }

  /** What the legend burns into a screenshot; `null` outside Results mode. */
  legendBurn(): { title: string; unit: string; min: number; max: number; colormap: string } | null {
    const { legend, fieldKey, colormap, viewMode } = this.store.state;
    if (!legend || viewMode !== 'results') return null;
    const sample = this.store.state.transient?.frame;
    return { title: `${choiceOf(fieldKey).label}${sample ? ` · ${sample.time.value} ${sample.time.unit}` : ''}`, unit: legend.unit, min: legend.min, max: legend.max, colormap };
  }

  /**
   * A Command's Ack, after the Journal has been re-read: a solve opens the Results tab and the
   * contours (design "Solve completion"), a study keeps its report for the convergence bars.
   */
  async onAck(ack: unknown): Promise<void> {
    const out = (ack as { output?: { type?: string; report?: StudyReport } } | undefined)?.output;
    if (out?.type === 'study' && out.report) this.store.set({ study: out.report });
    if (out?.type !== 'solve') return;
    this.invalidateTransient();
    const epoch = this.displayEpoch;
    this.selectedStep = undefined;
    const warnings = (ack as { warnings?: Warning[] }).warnings ?? [];
    this.store.set({ tab: 'results', viewMode: 'results', assumptions: warnings });
    this.viewer.current?.setMode('results');
    // A real displacement is invisible at ×1, so a fresh Result opens exaggerated (design §5) —
    // which `load` does through `requested`, defaulting to `"auto"`.
    await this.refresh(true);
    if (epoch !== this.displayEpoch) return;
    const result = this.store.state.result;
    if (result?.history?.length) await this.playTransient({ step: result.step, playing: false, sample: { kind: 'frame', index: result.history.length - 1 } });
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
  if (field === 'safety' || field === 'utilisation') {
    if (component !== null) throw unsupportedField(field, component);
    return field;
  }
  if (field.startsWith('mode:')) {
    if (!/^mode:[1-9]\d*$/.test(field) || component !== null) throw unsupportedField(field, component);
    return field;
  }
  const choices = FIELD_CHOICES.filter((c) => c.field === field);
  if (choices.length === 0) throw unsupportedField(field, component);
  if (component === null) return choices.find((c) => c.component === null)?.key ?? choices[0]!.key;
  const exact = choices.find((c) => c.component === component);
  if (!exact) throw unsupportedField(field, component);
  return exact.key;
}

function unsupportedField(field: string, component: number | null): FemError {
  const suffix = component === null ? '' : ` component ${component}`;
  return new FemError(
    'unsupported',
    `the browser cannot contour result field '${field}'${suffix}`,
    'view.showField',
    'run query.result, then call view.showField with a supported field and component from that Result',
  );
}

function unavailableField(field: string, component: number | null): FemError {
  const suffix = component === null ? '' : ` component ${component}`;
  return new FemError(
    'unsupported',
    `the current Result does not contain browser-contourable field '${field}'${suffix}`,
    'view.showField',
    'run query.result, then call view.showField with one of that Result\'s available fields and components',
  );
}
