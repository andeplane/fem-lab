import { FemError, type ComparisonConfiguration, type ComparisonPlaybackPane, type ComparisonPlaybackSpec, type ComparisonPlaybackState, type EngineTransport, type FrameResult, type FramesResult, type FrameSample, type Valued } from '@femlab/registry';
import type { PlaybackClock } from './transient';

type Side = 'left' | 'right';
type Pair = Exclude<ComparisonConfiguration, { mode: 'single' }>;
interface Run {
  catalogue: FramesResult;
  frame: FrameResult;
  playing: boolean;
  speed: number;
  wall: number;
  anchor: number;
  playhead: number;
}
interface CommonClock { wall: number; anchor: number; playhead: number; speed: number; playing: boolean; sampling: 'exact' | 'nearest' }
/** Host gesture receipt, scoped to one controller. Scientific arrays remain immutable. */
export interface ComparisonPlaybackCheckpoint {
  sides: Side[];
  runs: Partial<Record<Side, Run>>;
  mode: 'independent' | 'synchronized';
  interval: { startSi: number; endSi: number } | null;
  common: CommonClock;
}
/** Only primary arrays cross this boundary. The comparison host prepares and atomically
 * publishes scientific fields, legends, deformation, difference and a final status receipt. */
export interface ComparisonPlaybackPresentation {
  configuration(): ComparisonConfiguration;
  commit(frames: Partial<Record<Side, FrameResult>>, catalogues: Partial<Record<Side, FramesResult>>, current: () => boolean): Promise<boolean>;
  changed(state: ComparisonPlaybackState | null): void;
  failed(error: unknown): void;
}

/** One nonoverlapping timer drives two independent clocks or one shared physical playhead.
 * Each pane caches only its current/next arrays; the engine resolves all explicit seeks. */
export class ComparisonPlayback {
  private epoch = 0;
  private requests = { left: 0, right: 0 };
  private runs: Partial<Record<Side, Run>> = {};
  private caches = { left: new Map<number, FrameResult>(), right: new Map<number, FrameResult>() };
  private prefetches: Partial<Record<Side, { index: number; promise: Promise<FrameResult> }>> = {};
  private mode: 'independent' | 'synchronized' = 'independent';
  private interval: { startSi: number; endSi: number } | null = null;
  private common: CommonClock = { wall: 0, anchor: 0, playhead: 0, speed: 1, playing: false, sampling: 'nearest' };
  private previewing = new Set<Side>();
  private timer: unknown;
  private ticking: { current(): boolean } | undefined;
  private selecting: Partial<Record<Side, { current(): boolean }>> = {};

  constructor(private readonly transport: Pick<EngineTransport, 'query'>, private readonly clock: PlaybackClock | undefined,
    private readonly presentation: ComparisonPlaybackPresentation) {}

  invalidate(): void {
    this.epoch++; this.requests.left++; this.requests.right++; this.stop();
    this.runs = {}; this.caches.left.clear(); this.caches.right.clear(); this.prefetches = {}; this.previewing.clear();
    this.interval = null; this.common.playing = false; this.presentation.changed(null);
  }
  pause(): void {
    this.requests.left++; this.requests.right++; this.stop();
    if (this.mode === 'synchronized' && this.interval) this.common.playhead = Math.min(this.interval.endSi, this.commonTime());
    this.common.playing = false;
    for (const run of Object.values(this.runs)) { run.playhead = Math.min(run.catalogue.frames.at(-1)!.timeSi, this.time(run)); run.playing = false; }
    this.changed();
  }
  /** During a scrub retain its original/current pair, rather than prefetching a third array. */
  capturePreview(side: Side | 'synchronized'): ComparisonPlaybackCheckpoint {
    const sides: Side[] = side === 'synchronized' || this.mode === 'synchronized' ? ['left', 'right'] : [side];
    const common = { ...this.common, playhead: this.interval ? Math.min(this.interval.endSi, this.commonTime()) : this.common.playhead };
    const runs: Partial<Record<Side, Run>> = {};
    this.stop();
    for (const name of sides) {
      const run = this.runs[name];
      if (run) { runs[name] = { ...run, playhead: Math.min(run.catalogue.frames.at(-1)!.timeSi, this.time(run)) }; run.playhead = runs[name]!.playhead; run.playing = false; }
      this.requests[name]++; this.previewing.add(name); this.prefetches[name] = undefined;
      this.caches[name].clear(); if (run) this.caches[name].set(run.frame.sample.frame.index, run.frame);
    }
    if (sides.length === 2) { this.common.playhead = common.playhead; this.common.playing = false; }
    this.changed(); this.queue();
    return { sides, runs, mode: this.mode, interval: this.interval, common };
  }
  releasePreview(): void {
    this.previewing.clear();
    for (const side of ['left', 'right'] as const) this.prefetch(side);
    this.queue();
  }
  /** Called only after the controller has atomically restored its owned drawing receipt. */
  restorePreview(receipt: ComparisonPlaybackCheckpoint): void {
    const wall = this.clock?.now() ?? 0;
    this.stop();
    for (const side of receipt.sides) {
      this.requests[side]++; this.caches[side].clear(); this.prefetches[side] = undefined;
      const prior = receipt.runs[side];
      if (prior) { this.runs[side] = { ...prior, wall, anchor: prior.playhead }; this.caches[side].set(prior.frame.sample.frame.index, prior.frame); }
      else delete this.runs[side];
    }
    this.mode = receipt.mode; this.interval = receipt.interval;
    if (receipt.sides.length === 2) this.common = { ...receipt.common, wall, anchor: receipt.common.playhead };
    this.changed(); this.releasePreview();
  }
  private stop(): void { if (this.timer !== undefined) this.clock?.cancel(this.timer); this.timer = undefined; }
  private configuration(): Pair {
    const configuration = this.presentation.configuration();
    if (configuration.mode === 'single') throw new FemError('unsupported', 'two retained Results must be configured before playback', 'view.playComparison', 'view.compareResults');
    return configuration;
  }
  private speed(value: number): number {
    if (!Number.isFinite(value) || value <= 0) throw new FemError('schema', 'playback speed must be finite and positive', 'speed');
    return value;
  }
  private current(side: Side, epoch: number, request: number): boolean { return epoch === this.epoch && request === this.requests[side]; }
  private async catalogue(side: Side, id: string): Promise<FramesResult> {
    const configuration = this.configuration();
    if (configuration[side].resultId !== id) throw new FemError('result.stale', 'playback targets an obsolete comparison Result', 'resultId', 'query.resultComparison');
    const catalogue = await this.transport.query({ query: 'query.frames', resultId: id }) as FramesResult;
    if (catalogue.resultId !== id || !catalogue.frames.length) throw new FemError('result.stale', 'frame catalogue does not identify the requested retained Result', 'resultId');
    if (catalogue.field !== configuration[side].field) throw new FemError('unsupported', `this History retains only ${catalogue.field}`, 'field', 'view.compareResults with the retained primary field');
    return catalogue;
  }
  private async seek(catalogue: FramesResult, sample: FrameSample): Promise<FrameResult> {
    const frame = await this.transport.query({ query: 'query.frame', resultId: catalogue.resultId, field: catalogue.field, sample }) as FrameResult;
    if (frame.sample.resultId !== catalogue.resultId || frame.sample.step !== catalogue.step || frame.sample.modelHash !== catalogue.modelHash || frame.field !== catalogue.field || catalogue.frames[frame.sample.frame.index]?.timeSi !== frame.sample.frame.timeSi)
      throw new FemError('result.stale', 'frame does not match the requested retained catalogue', 'sample');
    return frame;
  }

  async select(input: ComparisonPlaybackSpec, admitted: () => boolean = () => true): Promise<void> {
    if (input.playing && !this.clock) throw new FemError('unsupported', 'this host has no playback clock', 'view.playComparison');
    this.stop();
    try {
      if (input.mode === 'independent') await this.independent(input, admitted);
      else await this.synchronized(input, admitted);
    } finally { this.queue(); }
  }
  private async independent(input: Extract<ComparisonPlaybackSpec, { mode: 'independent' }>, admitted: () => boolean): Promise<void> {
    const side = input.pane, epoch = this.epoch, request = ++this.requests[side];
    const current = () => admitted() && this.current(side, epoch, request);
    const selection = { current }; this.selecting[side] = selection; this.queue();
    try {
      const configuration = this.configuration(), prior = this.runs[side];
      const catalogue = await this.catalogue(side, input.resultId);
      const speed = this.speed(input.speed ?? prior?.speed ?? 1);
      const end = catalogue.frames.at(-1)!;
      const same = prior?.catalogue.resultId === input.resultId;
      const restarting = same && input.playing && prior.frame.sample.frame.index === end.index;
      const priorTime = same && !restarting ? Math.min(end.timeSi, this.time(prior!)) : null;
      const sample = input.sample ?? (priorTime !== null ? { kind: 'frame' as const, index: this.held(catalogue, priorTime) } : restarting ? { kind: 'frame' as const, index: 0 } : configuration[side].sample ?? { kind: 'frame' as const, index: 0 });
      const frame = await this.seek(catalogue, sample);
      if (!current() || !await this.presentation.commit({ [side]: frame }, { [side]: catalogue }, current) || !current()) return;
      if (this.mode === 'synchronized') { this.common.playing = false; for (const run of Object.values(this.runs)) run.playing = false; }
      this.mode = 'independent'; this.interval = null;
      const playhead = input.sample === undefined && priorTime !== null ? priorTime : frame.sample.frame.timeSi;
      this.runs[side] = { catalogue, frame, playing: input.playing, speed, wall: this.clock?.now() ?? 0, anchor: playhead, playhead };
      this.retain(side, frame); this.prefetch(side); this.changed();
    } catch (error) { if (current()) throw error; }
    finally { if (this.selecting[side] === selection) delete this.selecting[side]; }
  }
  private async synchronized(input: Extract<ComparisonPlaybackSpec, { mode: 'synchronized' }>, admitted: () => boolean): Promise<void> {
    const epoch = this.epoch, requests = { left: ++this.requests.left, right: ++this.requests.right };
    const current = () => admitted() && this.current('left', epoch, requests.left) && this.current('right', epoch, requests.right);
    const selection = { current }; this.selecting.left = selection; this.selecting.right = selection;
    try {
      const [left, right] = await Promise.all([this.catalogue('left', input.leftResultId), this.catalogue('right', input.rightResultId)]);
      const startSi = Math.max(left.frames[0]!.timeSi, right.frames[0]!.timeSi), endSi = Math.min(left.frames.at(-1)!.timeSi, right.frames.at(-1)!.timeSi);
      if (startSi > endSi) throw new FemError('unsupported', 'retained physical-time intervals do not overlap', 'time');
      const speed = this.speed(input.speed ?? (this.mode === 'synchronized' ? this.common.speed : 1));
      const same = this.mode === 'synchronized' && this.runs.left?.catalogue.resultId === input.leftResultId && this.runs.right?.catalogue.resultId === input.rightResultId;
      let time = same ? Math.min(endSi, this.commonTime()) : startSi;
      if (same && input.playing && time >= endSi) time = startSi;
      if (input.time !== undefined) time = (await this.transport.query({ query: 'query.convert', quantity: input.time, to: 's' }) as Valued).value;
      if (time < startSi || time > endSi) throw new FemError('not-found', 'playhead is outside the shared retained interval', 'time');
      const sample: FrameSample = { kind: 'time', time: { value: time, unit: 's' }, sampling: input.sampling };
      const [lf, rf] = await Promise.all([this.seek(left, sample), this.seek(right, sample)]);
      if (!current() || !await this.presentation.commit({ left: lf, right: rf }, { left, right }, current) || !current()) return;
      const wall = this.clock?.now() ?? 0;
      this.mode = 'synchronized'; this.interval = { startSi, endSi }; this.common = { wall, anchor: time, playhead: time, speed, playing: input.playing, sampling: input.sampling };
      this.runs.left = { catalogue: left, frame: lf, wall, anchor: time, playhead: time, speed, playing: input.playing };
      this.runs.right = { catalogue: right, frame: rf, wall, anchor: time, playhead: time, speed, playing: input.playing };
      this.retain('left', lf); this.retain('right', rf); this.prefetch('left'); this.prefetch('right'); this.changed();
    } catch (error) { if (current()) throw error; }
    finally { for (const side of ['left', 'right'] as const) if (this.selecting[side] === selection) delete this.selecting[side]; }
  }
  private time(run: Run): number { return run.playing && this.clock ? run.anchor + Math.max(0, this.clock.now() - run.wall) * 0.001 * run.speed : run.playhead; }
  private commonTime(): number { return this.common.playing && this.clock ? this.common.anchor + Math.max(0, this.clock.now() - this.common.wall) * 0.001 * this.common.speed : this.common.playhead; }
  private held(catalogue: FramesResult, time: number): number {
    let index = 0;
    while (index + 1 < catalogue.frames.length && catalogue.frames[index + 1]!.timeSi <= time) index++;
    return index;
  }
  private retain(side: Side, frame: FrameResult): void {
    const index = frame.sample.frame.index, cache = this.caches[side];
    for (const [i, prior] of cache) if ((i !== index && i !== index + 1) || prior.sample.resultId !== frame.sample.resultId) cache.delete(i);
    cache.set(index, frame);
    this.prefetches[side] = undefined;
  }
  private prefetch(side: Side): void {
    const run = this.runs[side];
    if (!run || this.previewing.has(side) || run.frame.sample.frame.index + 1 >= run.catalogue.frames.length) return;
    const index = run.frame.sample.frame.index + 1, epoch = this.epoch, request = this.requests[side];
    if (this.caches[side].has(index) || this.prefetches[side]?.index === index) return;
    const promise = this.seek(run.catalogue, { kind: 'frame', index }); this.prefetches[side] = { index, promise };
    void promise.then(frame => { if (this.current(side, epoch, request) && this.runs[side]?.frame.sample.frame.index === index - 1) this.caches[side].set(index, frame); }, () => undefined);
  }
  private required(side: Side, index: number): Promise<FrameResult> {
    const cached = this.caches[side].get(index); if (cached) return Promise.resolve(cached);
    const next = this.prefetches[side];
    return next?.index === index ? next.promise : this.seek(this.runs[side]!.catalogue, { kind: 'frame', index });
  }
  private queue(): void {
    if (!this.clock || this.timer !== undefined || this.ticking?.current() || !(['left', 'right'] as const).some(side => this.runs[side]?.playing && !this.selecting[side]?.current())) return;
    this.timer = this.clock.schedule(() => { this.timer = undefined; void this.tick(); }, 30);
  }
  private async tick(): Promise<void> {
    if (!this.clock || this.ticking?.current()) return;
    const epoch = this.epoch, requests = { ...this.requests };
    const sides = (['left', 'right'] as const).filter(side => this.runs[side]?.playing && !this.selecting[side]?.current());
    const current = () => epoch === this.epoch && sides.every(side => this.requests[side] === requests[side]);
    if (!sides.length) return;
    const tick = { current }; this.ticking = tick;
    let failedSide: Side | null = null;
    try {
      const updates: Partial<Record<Side, FrameResult>> = {}, catalogues: Partial<Record<Side, FramesResult>> = {}, times: Partial<Record<Side, number>> = {};
      const common = this.mode === 'synchronized' ? Math.min(this.interval!.endSi, this.commonTime()) : null;
      await Promise.all(sides.map(async side => {
        const run = this.runs[side]!, end = run.catalogue.frames.at(-1)!.timeSi;
        const time = common ?? Math.min(end, this.time(run)); times[side] = time;
        const index = this.held(run.catalogue, time);
        try { updates[side] = index === run.frame.sample.frame.index ? run.frame : await this.required(side, index); }
        catch (error) { failedSide = side; throw error; }
        catalogues[side] = run.catalogue;
      }));
      if (!current()) return;
      const changedFrame = sides.some(side => updates[side]!.sample.frame.index !== this.runs[side]!.frame.sample.frame.index);
      if (changedFrame && (!await this.presentation.commit(updates, catalogues, current) || !current())) return;
      for (const side of sides) {
        const run = this.runs[side]!, changed = run.frame.sample.frame.index !== updates[side]!.sample.frame.index;
        run.frame = updates[side]!; run.playhead = times[side]!;
        run.playing = run.playhead < (common === null ? run.catalogue.frames.at(-1)!.timeSi : this.interval!.endSi);
        if (changed) this.retain(side, run.frame);
        this.prefetch(side);
      }
      if (common !== null) { this.common.playhead = common; this.common.playing = common < this.interval!.endSi; }
      this.changed();
    } catch (error) {
      // The final publication receipt can identify one evicted operand after both
      // immutable frame reads succeeded. Keep the other independent clock alive.
      if (!failedSide && error instanceof FemError) failedSide = sides.find(side => error.where?.startsWith(`${side}.`)) ?? null;
      const affected = (failedSide ? [failedSide] : sides).filter(side => this.current(side, epoch, requests[side]));
      if (!affected.length) return;
      this.stop();
      if (this.mode === 'synchronized') {
        this.common.playhead = Math.min(this.interval!.endSi, this.commonTime()); this.common.playing = false;
        // Pause the old shared clock, but do not invalidate a newer pane selection that
        // is still preparing its own independent run.
        for (const run of Object.values(this.runs)) { run.playhead = Math.min(run.catalogue.frames.at(-1)!.timeSi, this.time(run)); run.playing = false; }
      }
      for (const side of affected) {
        this.requests[side]++;
        const run = this.runs[side];
        if (run) { run.playhead = Math.min(run.catalogue.frames.at(-1)!.timeSi, this.time(run)); run.playing = false; }
      }
      this.changed(); this.presentation.failed(error);
    } finally {
      // A retired read cannot clear a newer generation's in-flight ownership.
      if (this.ticking === tick) this.ticking = undefined;
      this.queue();
    }
  }
  private changed(): void {
    const pane = (side: Side): ComparisonPlaybackPane | null => { const run = this.runs[side]; return run ? { resultId: run.catalogue.resultId, sample: run.frame.sample, playing: run.playing, speed: run.speed, playheadSi: run.playhead } : null; };
    this.presentation.changed(Object.keys(this.runs).length ? { mode: this.mode, left: pane('left'), right: pane('right'), playheadSi: this.mode === 'synchronized' ? this.common.playhead : null, interval: this.interval, sampling: this.mode === 'synchronized' ? this.common.sampling : null } : null);
  }
}
