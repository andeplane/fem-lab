import { describe, expect, it } from 'vitest';
import { AnimationCapture, browserAnimationCaptureEnvironment, type AnimationCaptureEnvironment, type CaptureCallbacks, type CaptureRecorder } from '../src/animation-capture';
import { makeHostContext } from '../src/host';
import { Store } from '../src/store';
import type { Viewer } from '../src/viewer/viewer';
import type { WorkerTransport } from '../src/worker-transport';

function controlled() {
  let callbacks: CaptureCallbacks | null = null;
  let nextFrame: ((now: number) => void) | null = null;
  let stopped = 0;
  const env: AnimationCaptureEnvironment = {
    now: () => 100,
    requestFrame: (cb) => {
      nextFrame = cb;
      return 7;
    },
    cancelFrame: () => undefined,
    recorder: (_canvas, _fps, cb): CaptureRecorder => {
      callbacks = cb;
      return { start: () => undefined, stop: () => stopped++ };
    },
  };
  return {
    env,
    frame: (now: number) => {
      const cb = nextFrame;
      if (!cb) throw new Error('no frame scheduled');
      nextFrame = null;
      cb(now);
    },
    complete: (bytes: number[]) => callbacks!.stopped(Uint8Array.from(bytes)),
    fail: (cause: string) => callbacks!.failed(cause),
    stops: () => stopped,
  };
}

describe('animation capture', () => {
  it('draws one complete phase sweep and returns the recorder bytes', async () => {
    const c = controlled();
    const capture = new AnimationCapture(c.env);
    const phases: number[] = [];
    const recorded = capture.record(document.createElement('canvas'), { fps: 24, duration: 1 }, (phase) => phases.push(phase));
    c.frame(600);
    c.frame(1100);
    expect(c.stops()).toBe(1);
    c.complete([0x1a, 0x45, 0xdf, 0xa3]);
    await expect(recorded).resolves.toEqual(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]));
    expect(phases).toEqual([0, 0.5, 1]);
    expect(capture.cancel()).toBe(false);
  });

  it('cancels an active recording without returning a partial file', async () => {
    const c = controlled();
    const capture = new AnimationCapture(c.env);
    const recorded = capture.record(document.createElement('canvas'), { fps: 30, duration: 4 }, () => undefined);
    expect(capture.cancel()).toBe(true);
    expect(c.stops()).toBe(1);
    c.complete([1, 2, 3]);
    await expect(recorded).resolves.toBeNull();
  });

  it('rejects overlap, encoder errors and empty recordings with structured recovery', async () => {
    const c = controlled();
    const capture = new AnimationCapture(c.env);
    const first = capture.record(document.createElement('canvas'), { fps: 30, duration: 4 }, () => undefined);
    expect(() => capture.record(document.createElement('canvas'), { fps: 30, duration: 4 }, () => undefined)).toThrowError(expect.objectContaining({ code: 'in-use' }));
    c.fail('codec failed');
    await expect(first).rejects.toMatchObject({ code: 'export.unavailable', cause: expect.stringContaining('codec failed') });

    const empty = capture.record(document.createElement('canvas'), { fps: 30, duration: 4 }, () => undefined);
    c.complete([]);
    await expect(empty).rejects.toMatchObject({ code: 'export.unavailable', cause: expect.stringContaining('empty WebM') });
  });

  it('reports missing browser recording support instead of pretending export succeeded', () => {
    const host = {
      MediaRecorder: undefined,
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => undefined,
      performance: { now: () => 0 },
    };
    const env = browserAnimationCaptureEnvironment(host);
    expect(() => env.recorder(document.createElement('canvas'), 30, { stopped: () => undefined, failed: () => undefined })).toThrowError(expect.objectContaining({ code: 'unsupported' }));
  });

  it('restores the exact viewer and UI animation state after capture', async () => {
    const c = controlled();
    const store = new Store();
    store.set({ fieldKey: 'mode:2', result: { step: 'modes', history: [] } as never, playing: true, phase: 0.42 });
    const restored: unknown[] = [];
    const phases: number[] = [];
    const sizes: number[][] = [];
    const viewer = {
      animationState: () => ({ playing: true, phase: 0.37, speed: 1.5 }),
      setPhase: (phase: number) => phases.push(phase),
      restoreAnimation: (state: unknown) => restored.push(state),
      atCaptureSize: async (width: number, height: number, task: (canvas: HTMLCanvasElement) => Promise<unknown>) => {
        sizes.push([width, height]);
        return task(document.createElement('canvas'));
      },
    } as unknown as Viewer;
    const ctx = makeHostContext(store, {} as WorkerTransport, { current: viewer }, { webgpu: false, crossOriginIsolated: false, sharedArrayBuffer: false, threads: 1, chromium: true, userAgent: 'Chrome/140' }, undefined, undefined, c.env);
    const recording = ctx.view.captureAnimation({ width: 640, height: 360, fps: 24, duration: 1 });
    expect(store.state).toMatchObject({ capturingAnimation: true, playing: false });
    c.frame(1100);
    c.complete([1, 2]);
    await expect(recording).resolves.toEqual({ webm: Uint8Array.from([1, 2]) });
    expect(sizes).toEqual([[640, 360]]);
    expect(phases).toEqual([0, 0, 1]);
    expect(restored).toEqual([{ playing: true, phase: 0.37, speed: 1.5 }]);
    expect(store.state).toMatchObject({ capturingAnimation: false, playing: true, phase: 0.42 });
  });

  it('rejects a non-animated Result before touching the viewer', async () => {
    const c = controlled();
    const store = new Store();
    store.set({ fieldKey: 'vonMises', result: { step: 'static', history: [] } as never });
    const ctx = makeHostContext(store, {} as WorkerTransport, { current: null }, { webgpu: false, crossOriginIsolated: false, sharedArrayBuffer: false, threads: 1, chromium: true, userAgent: 'Chrome/140' }, undefined, undefined, c.env);
    await expect(ctx.view.captureAnimation({ width: 640, height: 360, fps: 24, duration: 1 })).rejects.toMatchObject({ code: 'export.unavailable', suggestion: expect.stringContaining('modal Step') });
  });

  it('restores a paused view after recorder failure and cancellation', async () => {
    const c = controlled();
    const store = new Store();
    store.set({ fieldKey: 'mode:1', result: { step: 'modes' } as never, playing: false, phase: 0.62 });
    const restored: unknown[] = [];
    const viewer = {
      animationState: () => ({ playing: false, phase: 0.62, speed: 1 }),
      setPhase: () => undefined,
      restoreAnimation: (state: unknown) => restored.push(state),
      atCaptureSize: (_width: number, _height: number, task: (canvas: HTMLCanvasElement) => Promise<unknown>) => task(document.createElement('canvas')),
    } as unknown as Viewer;
    const ctx = makeHostContext(store, {} as WorkerTransport, { current: viewer }, { webgpu: false, crossOriginIsolated: false, sharedArrayBuffer: false, threads: 1, chromium: true, userAgent: 'Chrome/140' }, undefined, undefined, c.env);

    const failed = ctx.view.captureAnimation({ width: 640, height: 360, fps: 24, duration: 1 });
    c.fail('encoder stopped');
    await expect(failed).rejects.toMatchObject({ code: 'export.unavailable' });
    expect(store.state).toMatchObject({ capturingAnimation: false, playing: false, phase: 0.62 });

    const cancelled = ctx.view.captureAnimation({ width: 640, height: 360, fps: 24, duration: 1 });
    expect(ctx.view.cancelAnimationCapture()).toBe(true);
    c.complete([1]);
    await expect(cancelled).resolves.toEqual({ webm: null });
    expect(restored).toEqual([
      { playing: false, phase: 0.62, speed: 1 },
      { playing: false, phase: 0.62, speed: 1 },
    ]);
  });
});
