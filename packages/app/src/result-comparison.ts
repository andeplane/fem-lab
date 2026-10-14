import { FemError, type ComparisonConfiguration, type ComparisonLegendSpec, type ComparisonLegendState, type ComparisonOperandInput, type ComparisonPaneName, type ComparisonPaneState, type ComparisonPick, type ComparisonPickSpec, type ComparisonVisibilitySpec, type DifferenceField, type EngineError, type EngineTransport, type ResultComparisonHost, type ResultComparisonState, type ResultField, type ResultSummary, type RetainedResults, type Surface, type Valued } from '@femlab/registry';
import { fieldChoices, formatNumber, type FieldChoice } from './fields';
import { checkResultIdentity } from './result-transfer';
import type { Store } from './store';
import type { CameraState, Viewer, ViewPreset } from './viewer/viewer';

/** The renderer boundary is injectable without pretending a fake owns a WebGL context. */
export type ComparisonViewer = Pick<Viewer, 'animate' | 'setField' | 'setDeformed' | 'setSurface' | 'setVisible' | 'setMode' | 'setDim' | 'setColormap' | 'setFieldValidity' | 'setSelection' | 'setCamera' | 'getCamera' | 'preset' | 'setProjection' | 'getProjection' | 'setComparisonFrameHeight' | 'getCameraZoom' | 'setCameraZoom' | 'setLayer' | 'setClip' | 'setTheme' | 'setHover' | 'setHighlight'>;
export interface ComparisonViewerRef { current: ComparisonViewer | null }

type PairConfiguration = Exclude<ComparisonConfiguration, { mode: 'single' }>;
interface Payload {
  pane: ComparisonPaneName;
  operand: ComparisonOperandInput;
  summary: ResultSummary;
  surface: Surface;
  field: ResultField;
  /** Scientific scalar projection in SI; nulls remain missing. */
  values: (number | null)[];
  display: Float32Array;
  valid: Uint8Array;
  scale: number;
  offset: number;
  unit: string;
  label: string;
  displacement: Float32Array | null;
}
export interface ComparisonLifecycle {
  pauseSingle(): void;
  restoreSingle(): Promise<void>;
}
const EMPTY_SURFACE = { positions: new Float32Array(), indices: new Uint32Array(), triBody: new Uint32Array(), triFace: new Uint32Array(), faceNames: [], bodyNames: [], source: 'mesh' as const };
const quantity = (value: number, unit: string): Valued => ({ value, unit });
const key = (operand: ComparisonOperandInput): string => `${operand.resultId}\0${operand.field}\0${operand.component ?? ''}`;
function engineError(error: unknown): EngineError {
  if (error instanceof FemError) return error.toJSON();
  return { code: 'internal', cause: String(error), where: 'view.compareResults', suggestion: 'retry the selected Result from query.results' };
}
/** Catalogue/state lifetime is one Bundle/transport; ids never cross a project replacement. */
export class ResultComparison implements ResultComparisonHost {
  private epoch = 0;
  private paneRequests = new Map<string, number>();
  private disposed = false;
  private syncingCamera = false;
  private payloads: Partial<Record<ComparisonPaneName, Payload>> = {};
  private conversions = new Map<string, { scale: number; offset: number }>();
  private requestedScale: number | 'auto' | 'true' = 'true';
  private clip: Parameters<Viewer['setClip']>[0] = null;

  constructor(private readonly store: Store, private readonly transport: EngineTransport,
    readonly viewers: { left: ComparisonViewerRef; right: ComparisonViewerRef }, private readonly lifecycle: ComparisonLifecycle) {}

  get configured(): boolean { return this.store.state.resultComparison.configuration.mode !== 'single'; }
  get active(): boolean { return this.configured && this.store.state.viewMode === 'results'; }
  state(): ResultComparisonState { return structuredClone({ ...this.store.state.resultComparison, viewMode: this.store.state.viewMode }); }
  private publish(patch: Partial<ResultComparisonState>): void {
    this.store.set({ resultComparison: { ...this.store.state.resultComparison, ...patch, viewMode: this.store.state.viewMode } });
  }
  private current(ticket: number): boolean { return !this.disposed && ticket === this.epoch; }
  private paneRequest(pane: ComparisonPaneName, action: 'legend' | 'pick') {
    const key = `${pane}:${action}`, sequence = (this.paneRequests.get(key) ?? 0) + 1, epoch = this.epoch;
    this.paneRequests.set(key, sequence);
    return () => this.current(epoch) && this.paneRequests.get(key) === sequence;
  }

  /** Prepare complete immutable payloads before changing either drawing or its labels. */
  async configure(configuration: ComparisonConfiguration): Promise<void> {
    if (this.disposed) throw new FemError('session.expired', 'comparison belongs to a closed project');
    const ticket = ++this.epoch;
    const wasActive = this.active;
    this.lifecycle.pauseSingle();
    this.publish({ loading: true, error: null });
    try {
      if (configuration.mode === 'single') {
        this.resetPresentation();
        this.payloads = {};
        this.publish({ configuration, left: null, right: null, difference: null, coverage: null, interpolated: false, warnings: [], loading: false });
        await this.lifecycle.restoreSingle();
        return;
      }
      const [left, right] = await Promise.all([this.prepare('left', configuration.left), this.prepare('right', configuration.right)]);
      const difference = configuration.mode === 'difference' ? await this.prepareDifference(configuration, left, right) : null;
      // Model writes from a separate producer can occur between these immutable payload reads.
      // Read status after preparation, so an earlier summary/catalogue cannot undo that edit.
      const catalogue = await this.transport.query({ query: 'query.results' }) as RetainedResults;
      if (!this.current(ticket)) return;
      for (const payload of [left, right]) {
        const record = catalogue.records.find(record => record.id === payload.operand.resultId);
        if (!record) throw new FemError('not-found', `retained Result '${payload.operand.resultId}' was evicted while loading`, 'resultId', 'select an available id from query.results');
        payload.summary = { ...payload.summary, stale: record.stale };
      }
      if (difference) difference.payload.summary = { ...difference.payload.summary, stale: left.summary.stale || right.summary.stale };
      this.payloads = { left, right, ...(difference ? { difference: difference.payload } : {}) };
      this.store.set({ viewMode: 'results', playing: false });
      this.publish({ configuration, catalogue, left: this.pane(left), right: this.pane(right), difference: difference ? this.pane(difference.payload) : null,
        coverage: difference?.response.coverage ?? null, interpolated: difference?.response.interpolated ?? false, warnings: difference?.response.warnings ?? [], loading: false });
      this.draw();
      if (!wasActive) this.preset('iso');
    } catch (error) {
      if (!this.current(ticket)) return;
      this.publish({ loading: false, error: engineError(error) });
      throw error;
    }
  }

  /** Ordinary edits refresh status without selecting a new solve or rebuilding old values. */
  async refresh(): Promise<void> {
    const ticket = this.epoch;
    const catalogue = await this.transport.query({ query: 'query.results' }) as RetainedResults;
    if (!this.current(ticket)) return;
    const patch: Partial<ResultComparisonState> = { catalogue, loading: false };
    for (const name of ['left', 'right', 'difference'] as const) {
      const pane = this.store.state.resultComparison[name];
      if (!pane) continue;
      const configuration = this.store.state.resultComparison.configuration;
      const ids = name === 'difference' && configuration.mode === 'difference' ? [configuration.left.resultId, configuration.right.resultId] : [pane.operand.resultId];
      const records = ids.map(id => catalogue.records.find(r => r.id === id));
      const absent = ids.find((_, i) => !records[i]);
      patch[name] = { ...pane, summary: { ...pane.summary, stale: records.some(r => !r || r.stale) }, error: absent ?
        new FemError('not-found', `retained Result '${absent}' is unavailable or evicted`, 'resultId', 'select an available id from query.results').toJSON() : null };
    }
    this.publish(patch);
    this.draw();
  }

  invalidate(): void { this.epoch++; }
  dispose(): void { this.disposed = true; this.invalidate(); this.payloads = {}; this.conversions.clear(); }
  /** Current geometry/mesh modes borrow the primary renderer without replacing pinned ids. */
  suspend(): void { this.invalidate(); this.publish({ loading: false }); this.resetPresentation(); }
  resume(): void { this.draw(); }
  private resetPresentation(): void {
    if (!Object.keys(this.payloads).length) return;
    for (const viewer of [this.viewers.left.current, this.viewers.right.current]) {
      if (!viewer) continue;
      viewer.setVisible([...new Set(Object.values(this.payloads).flatMap(p => p.surface.bodyNames))], true);
      viewer.setFieldValidity(null);
      viewer.setComparisonFrameHeight(null);
      viewer.setSelection({ bodies: [], faces: [], sets: [] });
    }
    this.viewers.left.current?.setVisible(this.store.state.hiddenBodies, false);
  }

  private async prepare(pane: 'left' | 'right', operand: ComparisonOperandInput): Promise<Payload> {
    const summary = await this.transport.query({ query: 'query.result', resultId: operand.resultId }) as ResultSummary;
    if (summary.resultId !== operand.resultId) throw new FemError('result.stale', 'the summary belongs to a different solve', 'resultId');
    const request = { query: 'query.field' as const, resultId: operand.resultId, field: operand.field };
    const [surface, field] = await Promise.all([this.transport.surface({ resultId: operand.resultId }), this.transport.query(request) as Promise<ResultField>]);
    checkResultIdentity({ query: 'query.surface', resultId: operand.resultId }, surface);
    checkResultIdentity(request, field);
    const values = scalarValues(field, operand);
    const unit = summary.extremes.find(e => e.field === operand.field)?.min.unit ??
      (operand.field.startsWith('mode:') ? summary.extremes.find(e => e.field === 'displacement')?.min.unit : undefined) ?? field.unit;
    const conversion = await this.conversion(field.unit, unit);
    const label = labelOf(operand, summary, field.components);
    const displacement = operand.field.startsWith('mode:') ? Float32Array.from(field.values) :
      summary.extremes.some(e => e.field === 'displacement') ? await this.displacement(operand.resultId) : null;
    return { pane, operand: { ...operand }, summary, surface, field, values, ...displayValues(values, conversion.scale, conversion.offset), ...conversion, unit, label, displacement };
  }

  private async displacement(resultId: string): Promise<Float32Array> {
    const request = { query: 'query.field' as const, resultId, field: 'displacement' };
    const field = await this.transport.query(request) as ResultField;
    checkResultIdentity(request, field);
    return Float32Array.from(field.values);
  }
  private async prepareDifference(configuration: Extract<PairConfiguration, { mode: 'difference' }>, left: Payload, right: Payload) {
    const response = await this.transport.query({ query: 'query.difference', left: configuration.left, right: configuration.right, onto: configuration.onto }) as DifferenceField;
    checkResultIdentity({ query: 'query.difference', left: configuration.left, right: configuration.right, onto: configuration.onto }, response);
    const target = configuration.onto === 'left' ? left : right;
    const values = projectValues(response.values, response.components);
    const conversion = await this.conversion(response.unit, target.unit);
    const vector = response.components > 1;
    const payload: Payload = { ...target, summary: { ...target.summary, stale: left.summary.stale || right.summary.stale }, pane: 'difference', values, field: { ...target.field, field: 'difference', per: 'node', components: response.components, unit: response.unit, nodeCount: response.nodeCount, entityCount: response.nodeCount, values: [] },
      ...displayValues(values, conversion.scale, 0), scale: conversion.scale, offset: 0,
      label: vector ? `|${configuration.left.field} left − ${configuration.right.field} right|` : `${left.label} − ${right.label}` };
    return { response, payload };
  }

  private pane(payload: Payload): ComparisonPaneState {
    const prior = this.store.state.resultComparison[payload.pane];
    const retain = prior && key(prior.operand) === key(payload.operand);
    return { operand: payload.operand, summary: payload.summary, label: payload.label,
      legend: this.legendOf(payload, retain ? prior.legend : null), bodyNames: [...payload.surface.bodyNames],
      hiddenBodies: retain ? prior.hiddenBodies : [], pick: null, error: null };
  }
  private legendOf(payload: Payload, prior: ComparisonLegendState | null): ComparisonLegendState | null {
    const bounds = extent(payload.values, payload.scale, payload.offset);
    if (!bounds && (!prior || prior.automatic)) return null;
    const [min, max] = bounds ?? [prior!.min.value, prior!.max.value];
    return { min: prior && !prior.automatic ? prior.min : quantity(min, payload.unit), max: prior && !prior.automatic ? prior.max : quantity(max, payload.unit),
      colormap: prior?.colormap ?? 'viridis', automatic: prior?.automatic ?? true, difference: payload.pane === 'difference' };
  }
  private target(pane: ComparisonPaneName, resultId: string) {
    const metadata = this.store.state.resultComparison[pane], payload = this.payloads[pane];
    const configuration = this.store.state.resultComparison.configuration;
    const visible = configuration.mode === 'sideBySide' ? pane !== 'difference' : configuration.mode === 'difference' && pane === 'difference';
    if (!visible || !metadata || !payload || metadata.error || resultId !== metadata.operand.resultId)
      throw new FemError('result.stale', 'this pane no longer displays the requested Result', 'resultId', 'read query.resultComparison and use its exact pane/id');
    return { metadata, payload };
  }

  async legend(input: ComparisonLegendSpec): Promise<void> {
    const { metadata, payload } = this.target(input.pane, input.resultId);
    const current = this.paneRequest(input.pane, 'legend');
    let legend = metadata.legend;
    if (input.range === 'auto') legend = this.legendOf(payload, legend ? { ...legend, automatic: true } : null);
    else if (input.range) {
      const bounds = await Promise.all(input.range.map(async q => {
        const value = await this.convert(q, payload.unit);
        return input.pane === 'difference' ? value - await this.convert(quantity(0, q.unit), payload.unit) : value;
      }));
      if (bounds[0]! >= bounds[1]!) throw new FemError('schema', 'legend lower bound must be less than its upper bound', 'range');
      legend = { min: quantity(bounds[0]!, payload.unit), max: quantity(bounds[1]!, payload.unit), automatic: false, colormap: legend?.colormap ?? 'viridis', difference: input.pane === 'difference' };
    }
    if (!current()) return;
    const latest = this.target(input.pane, input.resultId).metadata;
    this.publish({ [input.pane]: { ...latest, legend: legend ? { ...legend, colormap: input.colormap ?? latest.legend?.colormap ?? legend.colormap } : null } });
    this.draw();
  }
  visible(input: ComparisonVisibilitySpec): void {
    const { metadata } = this.target(input.pane, input.resultId);
    for (const body of input.bodies) if (!metadata.bodyNames.includes(body)) throw new FemError('not-found', `Body '${body}' does not belong to this retained Result`, 'bodies');
    const hiddenBodies = input.on ? metadata.hiddenBodies.filter(body => !input.bodies.includes(body)) : [...new Set([...metadata.hiddenBodies, ...input.bodies])];
    this.publish({ [input.pane]: { ...metadata, hiddenBodies, pick: metadata.pick?.body && hiddenBodies.includes(metadata.pick.body) ? null : metadata.pick } });
    this.draw();
  }
  async pick(input: ComparisonPickSpec): Promise<ComparisonPick | null> {
    const { payload } = this.target(input.pane, input.resultId);
    if (!this.active) throw new FemError('unsupported', 'comparison picking requires Results view', 'pane', 'view.setMode results');
    if (input.body && !payload.surface.bodyNames.includes(input.body)) throw new FemError('not-found', `Body '${input.body}' does not belong to this retained Result`, 'body');
    if (input.face && !payload.surface.faceNames.includes(input.face) && !payload.surface.setNames?.includes(input.face))
      throw new FemError('not-found', `face or Set '${input.face}' does not belong to this retained Result`, 'face');
    const current = this.paneRequest(input.pane, 'pick');
    const at = await Promise.all(input.at.map(q => this.convert(q, 'm')));
    if (!current()) return null;
    const { metadata } = this.target(input.pane, input.resultId);
    const picked = nearestEntity(payload, metadata.hiddenBodies, at, input.body, input.face, this.store.state.deformScale);
    if (!picked) return null;
    const raw = payload.values[picked.entity] ?? null;
    const pick: ComparisonPick = { resultId: input.resultId, pane: input.pane, field: payload.operand.field, component: payload.operand.component ?? null,
      at: [quantity(payload.surface.positions[picked.node * 3]!, 'm'), quantity(payload.surface.positions[picked.node * 3 + 1]!, 'm'), quantity(payload.surface.positions[picked.node * 3 + 2]!, 'm')],
      body: picked.body, face: picked.face, node: picked.node, value: raw === null ? null : quantity(raw, payload.field.unit), difference: input.pane === 'difference' };
    this.publish({ [input.pane]: { ...metadata, pick } });
    this.draw();
    return structuredClone(pick);
  }

  private async convert(q: Valued, to: string): Promise<number> {
    return (await this.transport.query({ query: 'query.convert', quantity: q, to }) as Valued).value;
  }
  private async conversion(from: string, to: string) {
    const cacheKey = `${from}\0${to}`;
    const prior = this.conversions.get(cacheKey);
    if (prior) return prior;
    const [zero, one] = await Promise.all([this.convert(quantity(0, from), to), this.convert(quantity(1, from), to)]);
    const conversion = { scale: one - zero, offset: zero };
    this.conversions.set(cacheKey, conversion);
    return conversion;
  }

  /** Camera synchronization never changes a Result’s own surface bounds. */
  cameraChanged(side: 'left' | 'right'): void {
    if (!this.active || this.syncingCamera) return;
    const source = this.viewers[side].current, other = this.viewers[side === 'left' ? 'right' : 'left'].current;
    if (!source || !other) return;
    this.syncingCamera = true;
    try { other.setCamera(source.getCamera()); other.setCameraZoom(source.getCameraZoom()); } finally { this.syncingCamera = false; }
  }
  setCamera(camera: CameraState): void {
    this.syncingCamera = true;
    try { this.viewers.left.current?.setCamera(camera); this.viewers.right.current?.setCamera(camera); } finally { this.syncingCamera = false; }
  }
  preset(view: ViewPreset): void {
    const positions = this.displayedPayloads().map(p => p.surface.positions);
    const bounds = unionBounds(positions);
    this.viewers.left.current?.preset(view, bounds);
    this.viewers.right.current?.setCameraZoom(1);
    const camera = this.viewers.left.current?.getCamera();
    if (camera) this.setCamera(camera);
  }
  setProjection(projection: 'perspective' | 'orthographic'): void {
    this.syncingCamera = true;
    try { this.viewers.left.current?.setProjection(projection); this.viewers.right.current?.setProjection(projection); }
    finally { this.syncingCamera = false; }
    this.cameraChanged('left');
  }
  setClip(clip: Parameters<Viewer['setClip']>[0]): void { this.clip = clip; this.viewers.left.current?.setClip(clip); this.viewers.right.current?.setClip(clip); }
  setDeformScale(scale: number | 'auto' | 'true'): void {
    this.requestedScale = scale;
    this.draw();
  }
  private draw(): void {
    if (!this.active || this.disposed) return;
    const configuration = this.store.state.resultComparison.configuration;
    const names: ComparisonPaneName[] = configuration.mode === 'difference' ? ['difference'] : ['left', 'right'];
    const bounds = unionBounds(this.displayedPayloads().map(p => p.surface.positions));
    const height = Math.max(Math.hypot(...bounds.max.map((v, i) => v - bounds.min[i]!)) * 0.7, 1e-6);
    let deformScale = this.requestedScale === 'true' ? 1 : this.requestedScale === 'auto' ? this.autoScale() : this.requestedScale;
    if (!Number.isFinite(deformScale)) deformScale = 1;
    if (this.store.state.deformScale !== deformScale) this.store.set({ deformScale });
    this.syncingCamera = true;
    try { for (const name of names) {
      const viewer = this.viewers[name === 'right' ? 'right' : 'left'].current;
      const metadata = this.store.state.resultComparison[name], payload = this.payloads[name];
      if (!viewer || !metadata || !payload) continue;
      viewer.animate(false);
      viewer.setField(null, [0, 1]); viewer.setDeformed(null, 0);
      if (metadata.error) { viewer.setSurface(EMPTY_SURFACE); continue; }
      viewer.setVisible(payload.surface.bodyNames, true);
      viewer.setSurface({ ...payload.surface, source: 'mesh' });
      viewer.setComparisonFrameHeight(height);
      if (name === 'right') viewer.setProjection(this.viewers.left.current?.getProjection() ?? 'perspective');
      viewer.setTheme(this.store.state.theme);
      viewer.setClip(this.clip);
      for (const [layer, on] of Object.entries(this.store.state.layerVisibility)) viewer.setLayer(layer, on);
      viewer.setHover({ bodies: [], faces: [], sets: [] }); viewer.setHighlight({});
      viewer.setVisible(metadata.hiddenBodies, false);
      viewer.setMode('results'); viewer.setDim(metadata.summary.stale);
      const legend = metadata.legend;
      viewer.setColormap(legend?.colormap ?? 'viridis');
      viewer.setField(payload.display, legend ? [legend.min.value, legend.max.value] : [0, 1], payload.field.per);
      viewer.setFieldValidity(payload.valid);
      viewer.setDeformed(payload.displacement, deformScale);
      viewer.setSelection({ bodies: metadata.pick?.body ? [metadata.pick.body] : [], faces: metadata.pick?.face ? [metadata.pick.face] : [], sets: [] });
    } } finally { this.syncingCamera = false; }
    this.cameraChanged('left');
  }
  private displayedPayloads(): Payload[] {
    const configuration = this.store.state.resultComparison.configuration;
    const names: ComparisonPaneName[] = configuration.mode === 'difference' ? ['difference'] : ['left', 'right'];
    return names.flatMap(name => this.payloads[name] ? [this.payloads[name]!] : []);
  }
  private autoScale(): number {
    let peak = 0;
    for (const p of this.displayedPayloads()) {
      const u = p.displacement;
      if (!u) continue;
      for (let i = 0; i < u.length; i += 3) peak = Math.max(peak, Math.hypot(u[i]!, u[i + 1]!, u[i + 2]!));
    }
    const box = unionBounds(this.displayedPayloads().map(p => p.surface.positions));
    return peak > 0 ? Math.hypot(...box.max.map((v, i) => v - box.min[i]!)) * 0.1 / peak : 1;
  }
}

function scalarValues(field: ResultField, operand: ComparisonOperandInput): number[] {
  if (operand.component !== undefined) {
    if (operand.component >= field.components) throw new FemError('schema', `field has ${field.components} components`, 'component');
    return field.values.filter((_, i) => i % field.components === operand.component);
  }
  if (field.components > 1 && operand.field !== 'displacement' && !operand.field.startsWith('mode:'))
    throw new FemError('unsupported', 'choose an explicit component of this field', 'component', 'query.result for the available field components');
  return projectValues(field.values, field.components) as number[];
}
function projectValues(values: (number | null)[], components: number): (number | null)[] {
  if (components === 1) return [...values];
  const out: (number | null)[] = [];
  for (let i = 0; i < values.length; i += components) {
    const vector = values.slice(i, i + components);
    out.push(vector.some(v => v === null) ? null : Math.hypot(...vector as number[]));
  }
  return out;
}
function displayValues(values: (number | null)[], scale: number, offset: number) {
  const display = new Float32Array(values.length), valid = new Uint8Array(values.length);
  values.forEach((v, i) => { if (v !== null) { display[i] = v * scale + offset; valid[i] = 1; } });
  return { display, valid };
}
function extent(values: (number | null)[], scale: number, offset: number): [number, number] | null {
  let min = Infinity, max = -Infinity;
  values.forEach(raw => { if (raw !== null) { const v = raw * scale + offset; min = Math.min(min, v); max = Math.max(max, v); } });
  return min === Infinity ? null : [min, max];
}
function labelOf(operand: ComparisonOperandInput, summary: ResultSummary, components: number): string {
  const choice: FieldChoice | undefined = fieldChoices(summary.extremes.map(e => e.field), summary).find(c => c.field === operand.field &&
    (operand.component === undefined ? c.magnitude || components === 1 : c.component === operand.component));
  return choice?.label ?? `${operand.field}${operand.component === undefined ? '' : ` [${operand.component}]`}`;
}
export function unionBounds(arrays: Float32Array[]): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const array of arrays) for (let i = 0; i < array.length; i++) { const axis = i % 3; min[axis] = Math.min(min[axis]!, array[i]!); max[axis] = Math.max(max[axis]!, array[i]!); }
  if (min[0] === Infinity) return { min: [0, 0, 0], max: [1, 1, 1] };
  return { min, max };
}
/** Named/point selection on drawn entities only; no reconstruction of a physics field. */
type RetainedEntity = { node: number; entity: number; body: string | null; face: string | null };
function nearestEntity(payload: Payload, hidden: string[], at: number[], body?: string, face?: string, scale = 1): RetainedEntity | null {
  const s = payload.surface;
  let best: RetainedEntity | null = null;
  let distance = Infinity;
  const visit = (node: number, entity: number, bodyIndex: number, faceIndex: number, inSet = false) => {
    const bodyName = s.bodyNames[bodyIndex] ?? null, faceName = s.faceNames[faceIndex] ?? null;
    if (bodyName && hidden.includes(bodyName) || body && body !== bodyName || face && face !== faceName && !inSet) return;
    let d = 0;
    for (let k = 0; k < 3; k++) { const p = s.positions[node * 3 + k]! + (payload.displacement?.[node * 3 + k] ?? 0) * scale; d += (p - at[k]!) ** 2; }
    if (d < distance) { distance = d; best = { node, entity, body: bodyName, face: faceName }; }
  };
  for (let i = 0; i < s.indices.length; i++) {
    const triangle = Math.floor(i / 3), node = s.indices[i]!;
    let inSet = false;
    if (face && s.triSetOffsets && s.triSets && s.setNames)
      for (let j = s.triSetOffsets[triangle]!; j < s.triSetOffsets[triangle + 1]!; j++) inSet ||= s.setNames[s.triSets[j]!] === face;
    visit(node, payload.field.per === 'elementNode' ? s.triElementNode![i]! : payload.field.per === 'element' ? s.triElement![triangle]! : node, s.triBody[triangle]!, s.triFace[triangle]!, inSet);
  }
  for (let i = 0; i < (s.edges?.length ?? 0); i++) { const edge = Math.floor(i / 2), node = s.edges![i]!; visit(node, payload.field.per === 'elementNode' ? s.edgeElementNode![i]! : payload.field.per === 'element' ? s.edgeElement![edge]! : node, s.edgeBody?.[edge] ?? -1, s.edgeFace?.[edge] ?? -1); }
  return best;
}

export function comparisonPickText(pick: ComparisonPick | null): string {
  return pick ? `${pick.resultId} · node ${pick.node} · ${pick.value ? `${formatNumber(pick.value.value)} ${pick.value.unit}` : 'unavailable coverage'}` : '';
}
