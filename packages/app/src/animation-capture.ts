import { FemError } from '@femlab/registry';

export interface CaptureRecorder {
  start(): void;
  stop(): void;
}

export interface CaptureCallbacks {
  stopped(bytes: Uint8Array): void;
  failed(cause: string): void;
}

/** Browser operations used by animation capture. Tests provide a recorder and a controllable clock. */
export interface AnimationCaptureEnvironment {
  now(): number;
  requestFrame(cb: (now: number) => void): number;
  cancelFrame(id: number): void;
  recorder(canvas: HTMLCanvasElement, fps: number, callbacks: CaptureCallbacks): CaptureRecorder;
}

export interface CaptureOptions {
  fps: number;
  duration: number;
}

export type RecordAnimation = (canvas: HTMLCanvasElement, options: CaptureOptions, drawPhase: (turns: number) => void) => Promise<Uint8Array | null>;

/**
 * One active recording, driven with explicit deformation phases. MediaRecorder only encodes the
 * canvas; the phase sweep stays the same viewer operation used by the scrubber and play button.
 */
export class AnimationCapture {
  private active: { cancel: (() => void) | null } | null = null;

  constructor(private readonly env: AnimationCaptureEnvironment) {}

  async run<T>(task: (record: RecordAnimation) => Promise<T>): Promise<T> {
    if (this.active) {
      throw new FemError('in-use', 'an animation recording is already in progress', 'file.export', 'cancel it with file.cancelAnimationCapture before starting another');
    }
    const slot = { cancel: null as (() => void) | null };
    this.active = slot;
    try {
      return await task((canvas, options, drawPhase) => this.record(slot, canvas, options, drawPhase));
    } finally {
      if (this.active === slot) this.active = null;
    }
  }

  private record(slot: { cancel: (() => void) | null }, canvas: HTMLCanvasElement, options: CaptureOptions, drawPhase: (turns: number) => void): Promise<Uint8Array | null> {
    return new Promise((resolve, reject) => {
      let frame = 0;
      let cancelled = false;
      let settled = false;
      let stopping = false;
      let recorder: CaptureRecorder | null = null;
      const finish = (result: Uint8Array | null, error?: FemError): void => {
        if (settled) return;
        settled = true;
        this.env.cancelFrame(frame);
        slot.cancel = null;
        if (error) reject(error);
        else resolve(result);
      };
      const fail = (error: FemError): void => {
        finish(null, error);
        if (!stopping && recorder) {
          stopping = true;
          try {
            recorder.stop();
          } catch {
            // The original structured error is the useful one; a recorder may already be dead.
          }
        }
      };
      try {
        drawPhase(0);
        recorder = this.env.recorder(canvas, options.fps, {
          stopped: (bytes) => {
            if (cancelled) finish(null);
            else if (bytes.length === 0) finish(null, new FemError('export.unavailable', 'Chromium returned an empty WebM recording', 'file.export', 'record again, or export a PNG if the browser cannot encode canvas video'));
            else finish(bytes);
          },
          failed: (cause) => fail(new FemError('export.unavailable', `Chromium could not encode the WebM recording: ${cause}`, 'file.export', 'export a PNG, or retry in a current Chromium browser')),
        });
        slot.cancel = () => {
          cancelled = true;
          if (!stopping) {
            stopping = true;
            this.env.cancelFrame(frame);
            try {
              recorder?.stop();
            } catch {
              // Cancellation has already discarded the recording. A dead encoder must not
              // leave the caller, viewer restoration and the active slot waiting forever.
              finish(null);
            }
          }
        };
        const start = this.env.now();
        recorder.start();
        const draw = (now: number): void => {
          try {
            const elapsed = Math.max(0, now - start);
            drawPhase(Math.min(elapsed / (options.duration * 1000), 1));
            if (elapsed >= options.duration * 1000) {
              stopping = true;
              recorder?.stop();
            } else frame = this.env.requestFrame(draw);
          } catch (error) {
            fail(new FemError('export.unavailable', `WebM recording stopped while drawing a frame: ${(error as Error).message}`, 'file.export', 'restore the Result view and record again'));
          }
        };
        frame = this.env.requestFrame(draw);
      } catch (error) {
        const known = error instanceof FemError ? error : new FemError('export.unavailable', `WebM recording could not start: ${(error as Error).message}`, 'file.export', 'export a PNG, or retry in a current Chromium browser');
        fail(known);
      }
    });
  }

  cancel(): boolean {
    if (!this.active?.cancel) return false;
    this.active.cancel();
    return true;
  }
}

interface MediaRecorderHost {
  MediaRecorder?: typeof MediaRecorder;
  requestAnimationFrame(cb: FrameRequestCallback): number;
  cancelAnimationFrame(id: number): void;
  performance: Pick<Performance, 'now'>;
}

/** The real Chromium boundary. Constructing it is harmless; browser APIs are read on record. */
export function browserAnimationCaptureEnvironment(host: MediaRecorderHost = globalThis): AnimationCaptureEnvironment {
  return {
    now: () => host.performance.now(),
    requestFrame: (cb) => host.requestAnimationFrame(cb),
    cancelFrame: (id) => host.cancelAnimationFrame(id),
    recorder: (canvas, fps, callbacks) => {
      const Recorder = host.MediaRecorder;
      if (!Recorder || typeof canvas.captureStream !== 'function') {
        throw new FemError('unsupported', 'this browser cannot record a canvas as WebM', 'file.export', 'open the app in a current Chromium browser, or export a PNG');
      }
      const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((mime) => Recorder.isTypeSupported(mime));
      if (!mimeType) throw new FemError('unsupported', 'this browser has no WebM encoder', 'file.export', 'open the app in a current Chromium browser, or export a PNG');
      const stream = canvas.captureStream(fps);
      let media: MediaRecorder;
      try {
        media = new Recorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });
      } catch (error) {
        for (const track of stream.getTracks()) track.stop();
        throw error;
      }
      const chunks: Blob[] = [];
      media.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      media.onerror = (event) => {
        for (const track of stream.getTracks()) track.stop();
        callbacks.failed((event as Event & { error?: DOMException }).error?.message ?? 'recorder error');
      };
      media.onstop = () => {
        for (const track of stream.getTracks()) track.stop();
        void new Blob(chunks, { type: 'video/webm' }).arrayBuffer().then((buffer) => callbacks.stopped(new Uint8Array(buffer)), (error: Error) => callbacks.failed(error.message));
      };
      return {
        start: () => {
          try {
            media.start();
          } catch (error) {
            for (const track of stream.getTracks()) track.stop();
            throw error;
          }
        },
        stop: () => media.stop(),
      };
    },
  };
}
