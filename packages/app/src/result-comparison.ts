import { FemError, type ComparisonConfiguration, type ComparisonLegendSpec, type ComparisonLegendState, type ComparisonOperandInput, type ComparisonPaneName, type ComparisonPaneState, type ComparisonPick, type ComparisonPickSpec, type ComparisonVisibilitySpec, type DifferenceField, type EngineError, type EngineTransport, type FrameResult, type FramesResult, type ResolvedFrame, type ResultComparisonHost, type ResultComparisonState, type ResultField, type ResultSummary, type RetainedResults, type Surface, type Valued } from '@femlab/registry';
import { fieldChoices, formatNumber, type FieldChoice } from './fields';
import { checkResultIdentity } from './result-transfer';
import type { Store } from './store';
import type { CameraState, Viewer, ViewPreset } from './viewer/viewer';
import { ComparisonPlayback, type ComparisonPlaybackCheckpoint } from './comparison-playback';
import type { PlaybackClock } from './transient';
import type { ComparisonPlaybackSpec } from '@femlab/registry';

/** The renderer boundary is injectable without pretending a fake owns a WebGL context. */
export type ComparisonViewer = Pick<Viewer, 'animate' | 'setField' | 'setDeformed' | 'setSurface' | 'setVisible' | 'setMode' | 'setDim' | 'setColormap' | 'setFieldValidity' | 'setSelection' | 'setCamera' | 'getCamera' | 'preset' | 'setProjection' | 'getProjection' | 'setComparisonFrameHeight' | 'getCameraZoom' | 'setCameraZoom' | 'setLayer' | 'setClip' | 'setTheme' | 'setHover' | 'setHighlight' | 'viewportAspect' | 'screenshot'>;
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
  frames: FramesResult | null;
  sample: ResolvedFrame | null;
}
type Side = 'left' | 'right';
type PaneUpdate = { frame: FrameResult; catalogue: FramesResult } | { payload: Payload };
/** Opaque by object identity: a later project may reuse the number, never this receipt. */
export interface ComparisonScrubTicket { readonly id: number }
interface ScrubReceipt {
  ticket: ComparisonScrubTicket;
  epoch: number;
  playback: ComparisonPlaybackCheckpoint;
  payloads: Partial<Record<Side, Payload>>;
}
export interface ComparisonLifecycle {
  pauseSingle(): void;
  restoreSingle(): Promise<void>;
}
const EMPTY_SURFACE = { positions: new Float32Array(), indices: new Uint32Array(), triBody: new Uint32Array(), triFace: new Uint32Array(), faceNames: [], bodyNames: [], source: 'mesh' as const };
const quantity = (value: number, unit: string): Valued => ({ value, unit });
const key = (operand: ComparisonOperandInput): string => `${operand.resultId}\0${operand.field}\0${operand.component ?? ''}`;
function sameSample(a: ResolvedFrame | null, b: ResolvedFrame | null): boolean {
  return a === null || b === null ? a === b : a.resultId === b.resultId && a.step === b.step && a.modelHash === b.modelHash && a.frame.index === b.frame.index && a.frame.timeSi === b.frame.timeSi;
}
function sampleCaption(sample: ResolvedFrame | null): string {
  return sample ? `frame ${sample.frame.index} · ${formatNumber(sample.frame.time.value)} ${sample.frame.time.unit}` : 'final field';
}
function engineError(error: unknown): EngineError {
  if (error instanceof FemError) return error.toJSON();
  return { code: 'internal', cause: String(error), where: 'view.compareResults', suggestion: 'retry the selected Result from query.results' };
}
/** Catalogue/state lifetime is one Bundle/transport; ids never cross a project replacement. */
export class ResultComparison implements ResultComparisonHost {
  private epoch = 0;
  private statusSequence = 0;
  private paneRequests = new Map<string, number>();
  private disposed = false;
  private syncingCamera = false;
  private payloads: Partial<Record<ComparisonPaneName, Payload>> = {};
  private conversions = new Map<string, { scale: number; offset: number }>();
  private requestedScale: number | 'auto' | 'true' = 'true';
  /** First entry waits for the actual pane layout; an explicit camera action wins. */
  private initialFit: number | null = null;
  private cameraRevision = 0;
  private clip: Parameters<Viewer['setClip']>[0] = null;
  private readonly playback: ComparisonPlayback;
  private scrub: ScrubReceipt | null = null;
  private scrubSequence = 0;

  constructor(private readonly store: Store, private readonly transport: EngineTransport,
    readonly viewers: { left: ComparisonViewerRef; right: ComparisonViewerRef }, private readonly lifecycle: ComparisonLifecycle, clock?: PlaybackClock) {
    this.playback = new ComparisonPlayback(transport, clock, {
      configuration: () => this.store.state.resultComparison.configuration,
      commit: (frames, catalogues, current) => this.commitFrames(frames, catalogues, current),
      changed: playback => this.publish({ playback }), failed: error => this.playbackFailed(error),
    });
  }

  get configured(): boolean { return this.store.state.resultComparison.configuration.mode !== 'single'; }
  get active(): boolean { return !this.disposed && this.configured && this.store.state.viewMode === 'results'; }
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
    this.initialFit = null;
    this.scrub = null; this.scrubSequence++;
    this.playback.invalidate();
    const wasActive = this.active;
    const cameraRevision = this.cameraRevision;
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
      this.statusSequence++;
      this.payloads = { left, right, ...(difference ? { difference: difference.payload } : {}) };
      if (!wasActive && cameraRevision === this.cameraRevision) this.initialFit = ticket;
      this.store.set({ viewMode: 'results', playing: false });
      this.publish({ configuration, catalogue, left: this.pane(left), right: this.pane(right), difference: difference ? this.pane(difference.payload) : null,
        coverage: difference?.response.coverage ?? null, interpolated: difference?.response.interpolated ?? false, warnings: difference?.response.warnings ?? [], loading: false });
      this.draw();
    } catch (error) {
      if (!this.current(ticket)) return;
      this.publish({ loading: false, error: engineError(error) });
      throw error;
    }
  }

  /** Ordinary edits refresh status without selecting a new solve or rebuilding old values. */
  async refresh(): Promise<void> {
    const ticket = this.epoch, request = ++this.statusSequence;
    const catalogue = await this.transport.query({ query: 'query.results' }) as RetainedResults;
    if (!this.current(ticket) || request !== this.statusSequence) return;
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

  invalidate(): void { this.epoch++; this.initialFit = null; this.pausePlayback(); }
  dispose(): void { this.disposed = true; this.invalidate(); this.playback.invalidate(); this.payloads = {}; this.conversions.clear(); }
  /** Current geometry/mesh modes borrow the primary renderer without replacing pinned ids. */
  suspend(): void { this.invalidate(); this.publish({ loading: false }); this.resetPresentation(); }
  resume(): void { this.draw(); this.fitInitial(); }
  pausePlayback(): void { this.scrub = null; this.scrubSequence++; this.playback.releasePreview(); this.playback.pause(); }
  async play(input: ComparisonPlaybackSpec): Promise<void> {
    if (!this.active) throw new FemError('unsupported', 'comparison playback requires Results view', 'view.playComparison', 'view.setMode results');
    const original = this.scrub, sequence = ++this.scrubSequence, epoch = this.epoch;
    this.scrub = null; this.playback.releasePreview();
    try { await this.playback.select(input); }
    catch (error) {
      const current = () => this.current(epoch) && this.active && sequence === this.scrubSequence;
      if (original && current()) await this.restoreScrub(original, current);
      if (current()) this.playbackFailed(error);
      throw error;
    }
  }
  beginScrub(side: Side | 'synchronized'): ComparisonScrubTicket {
    if (!this.active) throw new FemError('unsupported', 'comparison scrub requires Results view', 'view.playComparison');
    this.scrub = null; this.playback.releasePreview();
    const ticket = { id: ++this.scrubSequence }, playback = this.playback.capturePreview(side);
    const payloads = Object.fromEntries(playback.sides.flatMap(name => this.payloads[name] ? [[name, this.payloads[name]!]] : []));
    this.scrub = { ticket, epoch: this.epoch, playback, payloads };
    return ticket;
  }
  ownsScrub(ticket: ComparisonScrubTicket): boolean { return this.scrub?.ticket === ticket && this.current(this.scrub.epoch) && this.active; }
  async previewScrub(ticket: ComparisonScrubTicket, input: ComparisonPlaybackSpec): Promise<void> {
    if (!this.ownsScrub(ticket)) return;
    const receipt = this.scrub!;
    if (input.playing || (input.mode === 'synchronized' ? receipt.playback.sides.length !== 2 : !receipt.playback.sides.includes(input.pane)))
      throw new FemError('schema', 'a scrub previews only its captured paused pane or pair', 'view.playComparison');
    try { await this.playback.select(input, () => this.ownsScrub(ticket)); }
    catch (error) { if (this.ownsScrub(ticket)) this.publish({ error: engineError(error) }); throw error; }
  }
  async cancelScrub(ticket: ComparisonScrubTicket): Promise<void> {
    if (!this.ownsScrub(ticket)) return;
    const receipt = this.scrub!, sequence = ++this.scrubSequence;
    this.scrub = null;
    await this.restoreScrub(receipt, () => this.current(receipt.epoch) && this.active && this.scrubSequence === sequence);
  }
  private async restoreScrub(receipt: ScrubReceipt, current: () => boolean): Promise<void> {
    const updates = Object.fromEntries(Object.entries(receipt.payloads).map(([side, payload]) => [side, { payload }]));
    try { if (await this.commitUpdates(updates, current) && current()) this.playback.restorePreview(receipt.playback); }
    catch (error) { if (current()) { this.playback.releasePreview(); this.playbackFailed(error); } throw error; }
  }
  private playbackFailed(error: unknown): void {
    const epoch = this.epoch;
    this.publish({ error: engineError(error) });
    // A retained id may have been evicted by another producer. Clear its drawing using
    // the current catalogue, while a valid independent pane can continue on its own id.
    void this.refresh().catch(refreshError => { if (this.current(epoch)) this.publish({ error: engineError(refreshError) }); });
  }
  resize(): void {
    if (!this.active) return;
    const height = this.frameHeight();
    this.viewers.left.current?.setComparisonFrameHeight(height); this.viewers.right.current?.setComparisonFrameHeight(height);
    this.fitInitial();
  }
  private fitInitial(): void {
    if (this.initialFit === null || !this.current(this.initialFit) || !this.active || !this.viewers.left.current) return;
    if (this.store.state.resultComparison.configuration.mode === 'sideBySide' && !this.viewers.right.current) return;
    this.initialFit = null;
    this.applyPreset('iso');
  }
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
    const [surface, { field, frames, sample }] = await Promise.all([this.transport.surface({ resultId: operand.resultId }), this.readField(operand)]);
    checkResultIdentity({ query: 'query.surface', resultId: operand.resultId }, surface);
    const values = scalarValues(field, operand);
    const unit = summary.extremes.find(e => e.field === operand.field)?.min.unit ??
      (operand.field.startsWith('mode:') ? summary.extremes.find(e => e.field === 'displacement')?.min.unit : undefined) ?? field.unit;
    const conversion = await this.conversion(field.unit, unit);
    const label = labelOf(operand, summary, field.components);
    const displacement = sample ? field.field === 'displacement' ? Float32Array.from(field.values) : null : operand.field.startsWith('mode:') ? Float32Array.from(field.values) :
      summary.extremes.some(e => e.field === 'displacement') ? await this.displacement(operand.resultId) : null;
    return { pane, operand: { ...operand }, summary, surface, field, values, ...displayValues(values, conversion.scale, conversion.offset), ...conversion, unit, label, displacement, frames, sample };
  }

  private async readField(operand: ComparisonOperandInput): Promise<{ field: ResultField; frames: FramesResult | null; sample: ResolvedFrame | null }> {
    if (!operand.sample) {
      const request = { query: 'query.field' as const, resultId: operand.resultId, field: operand.field };
      const field = await this.transport.query(request) as ResultField;
      checkResultIdentity(request, field);
      return { field, frames: null, sample: null };
    }
    const frames = await this.transport.query({ query: 'query.frames', resultId: operand.resultId }) as FramesResult;
    if (frames.resultId !== operand.resultId) throw new FemError('result.stale', 'the frame catalogue belongs to a different solve', 'resultId');
    if (operand.field !== frames.field) throw new FemError('unsupported', `this History retains only ${frames.field}`, 'field', 'select the primary field from query.frames, or omit sample for a final derived field');
    const request = { query: 'query.frame' as const, resultId: operand.resultId, field: frames.field, sample: operand.sample };
    const frame = await this.transport.query(request) as FrameResult;
    checkResultIdentity(request, frame);
    if (frames.modelHash !== frame.sample.modelHash || frames.field !== frame.field || frames.frames[frame.sample.frame.index]?.timeSi !== frame.sample.frame.timeSi)
      throw new FemError('result.stale', 'the retained frame does not match its catalogue', 'sample', 'select a retained index from query.frames');
    return { field: { resultId: frame.sample.resultId, step: frame.sample.step, field: frame.field, components: frame.components, nodeCount: frame.nodeCount,
      per: 'node', entityCount: frame.nodeCount, unit: frame.unit, values: frame.values }, frames, sample: frame.sample };
  }

  private async displacement(resultId: string): Promise<Float32Array> {
    const request = { query: 'query.field' as const, resultId, field: 'displacement' };
    const field = await this.transport.query(request) as ResultField;
    checkResultIdentity(request, field);
    return Float32Array.from(field.values);
  }
  private async framePayload(prior: Payload, frame: FrameResult, frames: FramesResult): Promise<Payload> {
    if (frame.sample.resultId !== prior.operand.resultId || frame.field !== prior.operand.field)
      throw new FemError('result.stale', 'playback frame does not belong to this pane', 'resultId');
    const operand: ComparisonOperandInput = { ...prior.operand, sample: { kind: 'frame', index: frame.sample.frame.index } };
    const field: ResultField = { resultId: frame.sample.resultId, step: frame.sample.step, field: frame.field, components: frame.components,
      per: 'node', entityCount: frame.nodeCount, nodeCount: frame.nodeCount, unit: frame.unit, values: frame.values };
    const values = scalarValues(field, operand), conversion = await this.conversion(frame.unit, prior.unit);
    return { ...prior, operand, field, values, ...conversion, ...displayValues(values, conversion.scale, conversion.offset), frames, sample: frame.sample,
      displacement: frame.field === 'displacement' ? Float32Array.from(frame.values) : null };
  }
  /** Independent completions merge the latest other pane; synchronized pairs commit together.
   * A status receipt follows all asynchronous scientific and display preparation. */
  private async commitFrames(frames: Partial<Record<'left' | 'right', FrameResult>>, catalogues: Partial<Record<'left' | 'right', FramesResult>>, current: () => boolean): Promise<boolean> {
    const updates = Object.fromEntries(Object.entries(frames).map(([side, frame]) => [side, { frame, catalogue: catalogues[side as Side]! }]));
    return this.commitUpdates(updates, current);
  }
  private async commitUpdates(updates: Partial<Record<Side, PaneUpdate>>, current: () => boolean): Promise<boolean> {
    const epoch = this.epoch;
    const owns = () => current() && this.current(epoch) && this.active;
    while (owns()) {
      const configuration = this.store.state.resultComparison.configuration;
      if (configuration.mode === 'single') return false;
      const priorLeft = this.payloads.left!, priorRight = this.payloads.right!;
      const prepare = (side: Side, prior: Payload): Promise<Payload> | Payload => {
        const update = updates[side];
        return update ? 'payload' in update ? update.payload : this.framePayload(prior, update.frame, update.catalogue) : prior;
      };
      const [left, right] = await Promise.all([prepare('left', priorLeft), prepare('right', priorRight)]);
      const next = { ...configuration, left: left.operand, right: right.operand };
      const difference = next.mode === 'difference' ? await this.prepareDifference(next, left, right) : null;
      const catalogue = await this.transport.query({ query: 'query.results' }) as RetainedResults;
      if (!owns()) return false;
      // A separate pane selection can finish during any await above. Recompute the pair/difference
      // with its latest payload; never publish that pane's former sample or metadata.
      if ((!updates.left && priorLeft !== this.payloads.left) || (!updates.right && priorRight !== this.payloads.right)) continue;
      const missing: Partial<Record<Side, EngineError>> = {};
      for (const [side, payload] of [['left', left], ['right', right]] as const) {
        const record = catalogue.records.find(record => record.id === payload.operand.resultId);
        if (!record) {
          const error = new FemError('not-found', `retained Result '${payload.operand.resultId}' is unavailable or evicted`, `${side}.resultId`, 'query.results');
          if (updates[side] || next.mode === 'difference') throw error;
          missing[side] = error.toJSON();
        }
        payload.summary = { ...payload.summary, stale: record?.stale ?? true };
      }
      if (difference) difference.payload.summary = { ...difference.payload.summary, stale: left.summary.stale || right.summary.stale };
      this.statusSequence++;
      this.payloads = { left, right, ...(difference ? { difference: difference.payload } : {}) };
      this.publish({ configuration: next, catalogue, left: { ...this.pane(left), error: missing.left ?? null }, right: { ...this.pane(right), error: missing.right ?? null }, difference: difference ? this.pane(difference.payload) : null,
        coverage: difference?.response.coverage ?? null, interpolated: difference?.response.interpolated ?? false, warnings: difference?.response.warnings ?? [], error: null });
      this.draw(); return true;
    }
    return false;
  }
  private async prepareDifference(configuration: Extract<PairConfiguration, { mode: 'difference' }>, left: Payload, right: Payload) {
    const response = await this.transport.query({ query: 'query.difference', left: configuration.left, right: configuration.right, onto: configuration.onto }) as DifferenceField;
    checkResultIdentity({ query: 'query.difference', left: configuration.left, right: configuration.right, onto: configuration.onto }, response);
    if (!sameSample(response.left.sample ?? null, left.sample) || !sameSample(response.right.sample ?? null, right.sample))
      throw new FemError('result.stale', 'difference operands do not match the prepared retained frames', 'sample', 'retry the selected comparison samples');
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
      hiddenBodies: retain ? prior.hiddenBodies : [], canDeform: payload.displacement !== null, frames: payload.frames, sample: payload.sample, pick: null, error: null };
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
    if (this.target(input.pane, input.resultId).payload !== payload) return null;
    const { metadata } = this.target(input.pane, input.resultId);
    const picked = nearestEntity(payload, metadata.hiddenBodies, at, input.body, input.face, this.store.state.deformScale);
    if (!picked) return null;
    const raw = payload.values[picked.entity] ?? null;
    const pick: ComparisonPick = { resultId: input.resultId, pane: input.pane, field: payload.operand.field, component: payload.operand.component ?? null,
      at: [quantity(payload.surface.positions[picked.node * 3]!, 'm'), quantity(payload.surface.positions[picked.node * 3 + 1]!, 'm'), quantity(payload.surface.positions[picked.node * 3 + 2]!, 'm')],
      body: picked.body, face: picked.face, node: picked.node, value: raw === null ? null : quantity(raw, payload.field.unit), difference: input.pane === 'difference',
      samples: { left: this.payloads.left?.sample ?? null, right: this.payloads.right?.sample ?? null } };
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
    if (this.disposed || this.syncingCamera) return;
    this.cameraRevision++;
    this.initialFit = null;
    if (!this.active) return;
    this.syncCamera(side);
  }
  private syncCamera(side: 'left' | 'right'): void {
    if (!this.active || this.syncingCamera) return;
    const source = this.viewers[side].current, other = this.viewers[side === 'left' ? 'right' : 'left'].current;
    if (!source || !other) return;
    this.syncingCamera = true;
    try { other.setCamera(source.getCamera()); other.setCameraZoom(source.getCameraZoom()); } finally { this.syncingCamera = false; }
  }
  setCamera(camera: CameraState): void {
    this.cameraRevision++;
    this.initialFit = null;
    this.syncingCamera = true;
    try { this.viewers.left.current?.setCamera(camera); this.viewers.right.current?.setCamera(camera); } finally { this.syncingCamera = false; }
  }
  preset(view: ViewPreset): void {
    this.cameraRevision++;
    this.initialFit = null;
    this.applyPreset(view);
  }
  private applyPreset(view: ViewPreset): void {
    const positions = this.displayedPayloads().map(p => p.surface.positions);
    const bounds = unionBounds(positions);
    this.viewers.left.current?.preset(view, bounds, this.frameAspect());
    this.viewers.right.current?.setCameraZoom(1);
    const camera = this.viewers.left.current?.getCamera();
    if (camera) this.setCamera(camera);
  }
  setProjection(projection: 'perspective' | 'orthographic'): void {
    this.cameraRevision++;
    this.initialFit = null;
    this.syncingCamera = true;
    try { this.viewers.left.current?.setProjection(projection); this.viewers.right.current?.setProjection(projection); }
    finally { this.syncingCamera = false; }
    this.syncCamera('left');
  }
  setClip(clip: Parameters<Viewer['setClip']>[0]): void { this.clip = clip; this.viewers.left.current?.setClip(clip); this.viewers.right.current?.setClip(clip); }
  setDeformScale(scale: number | 'auto' | 'true'): void {
    this.requestedScale = scale;
    this.draw();
  }
  /** Capture each actual retained pane with its own label/physical legend; the host joins PNGs. */
  captureGuard(): () => void {
    const ticket = this.epoch;
    return () => {
      if (this.disposed) throw new FemError('session.expired', 'comparison capture belongs to a closed project');
      if (!this.current(ticket)) throw new FemError('result.stale', 'comparison changed while its capture was being prepared', 'query.screenshot', 'retry query.screenshot for the current comparison');
    };
  }
  capture(input: { width?: number; height?: number; title?: string; legend?: boolean }): string[] {
    if (!this.active) throw new FemError('unsupported', 'comparison capture requires Results view', 'query.screenshot');
    const payloads = this.displayedPayloads();
    if (input.width !== undefined && input.width < payloads.length) throw new FemError('schema', 'image width must allow at least one pixel per pane', 'width');
    return payloads.map((payload, index) => {
      const viewer = this.viewers[payload.pane === 'right' ? 'right' : 'left'].current;
      if (!viewer) throw new FemError('unsupported', 'both comparison viewers must be mounted before capture', 'query.screenshot');
      const metadata = this.store.state.resultComparison[payload.pane]!;
      const legend = metadata.legend;
      const burn = input.legend === false || !legend || metadata.error ? undefined : {
        title: payload.label, unit: `${legend.difference ? 'Δ ' : ''}${legend.min.unit}`, min: legend.min.value, max: legend.max.value, colormap: legend.colormap,
      };
      const width = input.width === undefined ? undefined : Math.floor(input.width / payloads.length) + (index < input.width % payloads.length ? 1 : 0);
      const samples = payload.pane === 'difference' && (this.payloads.left?.sample || this.payloads.right?.sample) ?
        ` · left ${this.payloads.left!.operand.resultId} ${sampleCaption(this.payloads.left!.sample)} · right ${this.payloads.right!.operand.resultId} ${sampleCaption(this.payloads.right!.sample)}` : payload.sample ? ` · ${sampleCaption(payload.sample)}` : '';
      const title = `${input.title ? `${input.title} · ` : ''}${payload.pane} · ${payload.operand.resultId} · ${metadata.summary.stale ? 'stale' : 'current'}${metadata.error ? ' · unavailable' : ''}${samples}`;
      return viewer.screenshot(burn, { ...input, width, title });
    });
  }
  private frameHeight(): number {
    const bounds = unionBounds(this.displayedPayloads().map(p => p.surface.positions));
    const radius = Math.hypot(...bounds.max.map((v, i) => v - bounds.min[i]!)) * 0.7;
    return Math.max(radius / this.frameAspect(), 1e-6);
  }
  private frameAspect(): number {
    const viewers = this.store.state.resultComparison.configuration.mode === 'sideBySide' ? [this.viewers.left.current, this.viewers.right.current] : [this.viewers.left.current];
    return Math.min(1, ...viewers.flatMap(viewer => viewer ? [viewer.viewportAspect()] : []));
  }
  private draw(): void {
    if (!this.active || this.disposed) return;
    const configuration = this.store.state.resultComparison.configuration;
    const names: ComparisonPaneName[] = configuration.mode === 'difference' ? ['difference'] : ['left', 'right'];
    const height = this.frameHeight();
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
    this.syncCamera('left');
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
