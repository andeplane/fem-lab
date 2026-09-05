import type { Capabilities } from '@femlab/registry';
import { describe, expect, it } from 'vitest';
import { capabilityNotes, engineChip, readHostCaps } from '../src/capabilities';

const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const engine = (over: Partial<Capabilities> = {}): Capabilities => ({ gpu: true, adapter: 'swiftshader', threads: 8, engineVersion: '0.1.0', schemaVersion: '1', ...over });

describe('readHostCaps', () => {
  it('reads the four facts and asks for one thread when not isolated', () => {
    const caps = readHostCaps({ navigator: { userAgent: CHROME, hardwareConcurrency: 8, gpu: {} }, crossOriginIsolated: false, SharedArrayBuffer: undefined });
    expect(caps).toMatchObject({ webgpu: true, crossOriginIsolated: false, sharedArrayBuffer: false, threads: 1, chromium: true });
  });

  it('asks for the hardware thread count once isolation is real', () => {
    expect(readHostCaps({ navigator: { userAgent: CHROME, hardwareConcurrency: 12 }, crossOriginIsolated: true }).threads).toBe(12);
  });

  it('survives a host with nothing on it', () => {
    expect(readHostCaps({})).toEqual({ webgpu: false, crossOriginIsolated: false, sharedArrayBuffer: false, threads: 1, chromium: false, userAgent: '' });
  });
});

describe('capabilityNotes', () => {
  const full = readHostCaps({ navigator: { userAgent: CHROME, hardwareConcurrency: 8, gpu: {} }, crossOriginIsolated: true });

  it('says nothing when everything is available', () => {
    expect(capabilityNotes(full, engine())).toEqual([]);
  });

  it('names Chrome when there is no WebGPU', () => {
    const caps = readHostCaps({ navigator: { userAgent: CHROME, hardwareConcurrency: 8 }, crossOriginIsolated: true });
    expect(capabilityNotes(caps, engine({ gpu: false }))[0]).toContain('Open in Chrome for GPU solving');
  });

  it('distinguishes "no WebGPU" from "WebGPU but no adapter"', () => {
    expect(capabilityNotes(full, engine({ gpu: false }))[0]).toContain('no adapter was granted');
  });

  it('says how to get threads back when the page is not isolated', () => {
    const caps = readHostCaps({ navigator: { userAgent: CHROME, gpu: {} } });
    expect(capabilityNotes(caps, engine())).toContain('Running single-threaded; reload to enable threads.');
  });

  it('warns once outside Chromium (ADR 0014)', () => {
    const caps = readHostCaps({ navigator: { userAgent: 'Mozilla/5.0 Firefox/140.0', gpu: {} }, crossOriginIsolated: true });
    expect(capabilityNotes(caps, engine()).join(' ')).toContain('Chromium is the supported browser');
  });
});

describe('engineChip', () => {
  const host = readHostCaps({ navigator: { userAgent: CHROME, hardwareConcurrency: 8, gpu: {} }, crossOriginIsolated: true });

  it('reads like the design: where it runs and how many threads', () => {
    expect(engineChip(host, engine())).toBe('local GPU · 8 threads');
    expect(engineChip(host, engine({ gpu: false, threads: 1 }))).toBe('local CPU · 1 thread');
  });

  it('falls back to the host thread count before the engine has answered', () => {
    expect(engineChip(host, null)).toBe('local CPU · 8 threads');
  });
});
