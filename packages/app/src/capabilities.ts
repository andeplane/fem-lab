// What the browser can do, and the sentences a person needs when it cannot do everything
// (plan B §7.11, ADR 0013 for isolation, ADR 0014 for Chromium).
import type { Capabilities } from '@femlab/registry';

export interface HostCaps {
  webgpu: boolean;
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  /** Requested CPU pool size: hardware count with isolation and shared memory, otherwise 1. */
  threads: number;
  chromium: boolean;
  userAgent: string;
}

/** Only the four facts we read, so a test can hand in a plain object. */
export interface CapabilityHost {
  navigator?: { userAgent?: string; hardwareConcurrency?: number; gpu?: unknown };
  crossOriginIsolated?: boolean;
  SharedArrayBuffer?: unknown;
}

export function readHostCaps(win: CapabilityHost = globalThis as CapabilityHost): HostCaps {
  const nav = win.navigator;
  const ua = nav?.userAgent ?? '';
  const isolated = win.crossOriginIsolated === true;
  const shared = typeof win.SharedArrayBuffer === 'function';
  return {
    webgpu: nav?.gpu !== undefined,
    crossOriginIsolated: isolated,
    sharedArrayBuffer: shared,
    threads: isolated && shared ? Math.max(1, Math.floor(nav?.hardwareConcurrency ?? 1)) : 1,
    chromium: /Chrome\/|Chromium\/|Edg\//.test(ua),
    userAgent: ua,
  };
}

/**
 * One line per thing the person would otherwise discover as a mystery: no GPU, no threads, an
 * unsupported browser. Empty when everything is available.
 */
export function capabilityNotes(host: HostCaps, engine: Capabilities | null): string[] {
  const notes: string[] = [];
  if (!host.webgpu) notes.push('Open in Chrome for GPU solving — this browser has no WebGPU, so solves run on the CPU.');
  else if (engine && !engine.gpu) notes.push('WebGPU is present but no adapter was granted; solving on the CPU.');
  if (!host.crossOriginIsolated || !host.sharedArrayBuffer) notes.push('Running single-threaded; open in Chrome and reload to enable threads.');
  else if (engine && engine.threads < host.threads) notes.push(`Running with ${engine.threads} CPU thread${engine.threads === 1 ? '' : 's'}; the requested worker pool is unavailable.`);
  if (!host.chromium) notes.push('Chromium is the supported browser; anything else is best effort (ADR 0014).');
  return notes;
}

/** The engine chip in the top bar: "local GPU · 8 threads". */
export function engineChip(host: HostCaps, engine: Capabilities | null): string {
  const where = engine?.gpu ? 'local GPU' : 'local CPU';
  const threads = engine?.threads ?? host.threads;
  return `${where} · ${threads} thread${threads === 1 ? '' : 's'}`;
}
