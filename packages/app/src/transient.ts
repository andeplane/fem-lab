// A host clock chooses retained indices; Rust resolves physical-time selectors and owns
// every field value. Only the current/next payloads are cached, never a second History.
import { FemError, type EngineTransport, type FrameResult, type FramesResult, type FrameSample } from '@femlab/registry';

export interface PlaybackClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface TransientInput {
  step: string;
  playing: boolean;
  speed?: number;
  sample?: FrameSample;
}

export interface TransientState {
  generation: number;
  catalogue: FramesResult;
  frame: FrameResult['sample']['frame'];
  playing: boolean;
  speed: number;
}

export class TransientPlayback {
  private epoch = 0;
  private request = 0;
  private timer: unknown;
  private state: TransientState | null = null;
  private cache = new Map<number, FrameResult>();
  private next: { index: number; promise: Promise<FrameResult> } | undefined;
  private anchor = { wall: 0, time: 0 };
  private playhead = 0;

  constructor(
    private readonly transport: Pick<EngineTransport, 'query'>,
    private readonly clock: PlaybackClock | undefined,
    // Prepare all asynchronous unit conversions before committing the synchronized drawing.
    private readonly prepare: (frame: FrameResult, catalogue: FramesResult) => Promise<() => void>,
    private readonly changed: (state: TransientState | null) => void,
    private readonly failed: (error: unknown) => void,
  ) {}

  /** Model edits and every solve Ack invalidate replies even if the Model hash is identical. */
  invalidate(): void {
    this.epoch++;
    this.request++;
    this.stopTimer();
    this.cache.clear();
    this.next = undefined;
    this.state = null;
    this.changed(null);
  }

  private stopTimer(): void {
    if (this.timer !== undefined) this.clock?.cancel(this.timer);
    this.timer = undefined;
  }

  async select(input: TransientInput): Promise<void> {
    const request = ++this.request;
    const epoch = this.epoch;
    const previous = this.state;
    const playhead = previous?.playing && this.clock
      ? this.anchor.time + Math.max(0, this.clock.now() - this.anchor.wall) * 0.001 * previous.speed
      : this.playhead;
    this.stopTimer();
    try {
      if (input.playing && !this.clock) throw new FemError('unsupported', 'no playback clock is available', 'view.playTransient', 'use a host with a playback clock');
      const catalogue = await this.transport.query({ query: 'query.frames', step: input.step }) as FramesResult;
      if (catalogue.stale) throw new FemError('result.stale', 'the transient Result no longer matches the Model', 'view.playTransient', 'solve.run for this Step');
      if (!catalogue.frames.length) throw new FemError('not-found', 'the Step has no retained frames', 'view.playTransient', 'query.frames for a solved transient Step');
      const same = previous?.catalogue.step === catalogue.step && previous.catalogue.modelHash === catalogue.modelHash;
      const last = catalogue.frames.length - 1;
      const restarting = same && input.playing && previous.frame.index === last;
      let index = same && !restarting ? previous.frame.index : 0;
      if (same && !restarting && input.sample === undefined) {
        while (index < last && catalogue.frames[index + 1]!.timeSi <= playhead) index++;
      }
      const frame = await this.transport.query({ query: 'query.frame', step: input.step, ...(input.sample ? { sample: input.sample } : { index }) }) as FrameResult;
      const commit = await this.prepare(frame, catalogue);
      if (request !== this.request || epoch !== this.epoch) return;
      this.cache.clear();
      this.next = undefined;
      this.cache.set(frame.sample.frame.index, frame);
      const state = { generation: epoch, catalogue, frame: frame.sample.frame, playing: input.playing, speed: input.speed ?? previous?.speed ?? 1 };
      commit();
      this.state = state;
      this.changed(state);
      this.playhead = same && !restarting && input.sample === undefined ? Math.min(playhead, catalogue.frames[last]!.timeSi) : frame.sample.frame.timeSi;
      this.anchor = { wall: this.clock?.now() ?? 0, time: this.playhead };
      this.prefetch();
      this.queue();
    } catch (error) {
      if (request !== this.request || epoch !== this.epoch) return;
      // A rejected selection leaves the previously displayed frame and playing state intact.
      this.queue();
      throw error;
    }
  }

  private queue(): void {
    if (!this.state?.playing || !this.clock) return;
    const epoch = this.epoch;
    const request = this.request;
    this.timer = this.clock.schedule(() => {
      this.timer = undefined;
      void this.tick().catch((error: unknown) => {
        if (epoch !== this.epoch || request !== this.request) return;
        this.invalidate();
        this.failed(error);
      });
    }, 30);
  }

  private prefetch(): void {
    const state = this.state;
    if (!state || state.frame.index + 1 >= state.catalogue.frames.length) return;
    const index = state.frame.index + 1;
    const epoch = this.epoch;
    const request = this.request;
    const promise = this.transport.query({ query: 'query.frame', step: state.catalogue.step, index }) as Promise<FrameResult>;
    this.next = { index, promise };
    // Only the current/next pair is retained, even when old prefetches resolve out of order.
    void promise.then((frame) => {
      if (epoch === this.epoch && request === this.request && this.state?.frame.index === index - 1) this.cache.set(index, frame);
    }, () => undefined); // A required read propagates its error through tick/select.
  }

  private async tick(): Promise<void> {
    const state = this.state;
    if (!state?.playing || !this.clock) return;
    const epoch = this.epoch;
    const request = this.request;
    const frames = state.catalogue.frames;
    const last = frames[frames.length - 1]!;
    const time = this.anchor.time + Math.max(0, this.clock.now() - this.anchor.wall) * 0.001 * state.speed;
    this.playhead = Math.min(time, last.timeSi);
    // Hold each stored value until the next actual retained time. No interpolated field exists.
    let index = state.frame.index;
    while (index < last.index && frames[index + 1]!.timeSi <= time) index++;
    if (index !== state.frame.index) {
      const frame = this.cache.get(index) ?? await (this.next?.index === index ? this.next.promise : this.transport.query({ query: 'query.frame', step: state.catalogue.step, index })) as FrameResult;
      const commit = await this.prepare(frame, state.catalogue);
      if (epoch !== this.epoch || request !== this.request) return;
      this.cache.clear();
      this.cache.set(index, frame);
      commit();
      this.state = { ...state, frame: frame.sample.frame, playing: time < last.timeSi };
      this.changed(this.state);
      this.next = undefined;
      this.prefetch();
    } else if (time >= last.timeSi) {
      this.state = { ...state, playing: false };
      this.changed(this.state);
    }
    if (epoch !== this.epoch || request !== this.request) return;
    this.queue();
  }
}
