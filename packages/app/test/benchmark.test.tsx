import type { ResultSummary, Valued } from '@femlab/registry';
import { render } from 'preact';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BENCHMARK_COMPARISONS, attachComparison, clearsBenchmark, readBenchmark, type BenchmarkComparison, type ExampleEntry } from '../src/benchmark';
import { appHostCommands } from '../src/host';
import { Store, initialState } from '../src/store';
import { Theory } from '../src/ui/Theory';
import type { WorkerTransport } from '../src/worker-transport';
import { waitFor } from './wait-for';

const journals = path.resolve(import.meta.dirname, '../../../crates/engine/benches/journals');
const mm = (value: number): Valued => ({ value, unit: 'mm' });
const result = (extremes: ResultSummary['extremes'] = []): ResultSummary =>
  ({ step: 'static', revision: 9, stale: false, solver: 'cpu-direct', iterations: 1, residual: 0, timeMs: 1, extremes, reactions: [], appliedTotal: [mm(0), mm(0), mm(0)], balance: 0 }) as ResultSummary;
const example = (name = 'cantilever'): ExampleEntry => ({
  name,
  commands: 10,
  summary: 'A benchmark.',
  title: 'Cantilever beam',
  tag: 'P1 · verify',
  theory: 'Beam theory gives $\\delta = PL^3/(3EI)$.',
  expected: { quantity: 'tip deflection', value: -0.1901, unit: 'mm', reference: 'Timoshenko: 0.1919619 mm' },
});

describe('benchmark comparison registry', () => {
  it('makes an explicit comparison-or-null decision for every bundled example', () => {
    const names = readdirSync(journals)
      .filter((file) => file.endsWith('.json') && !file.endsWith('.meta.json'))
      .map((file) => path.basename(file, '.json'))
      .sort();
    expect(Object.keys(BENCHMARK_COMPARISONS).sort()).toEqual(names);
    expect(Object.values(BENCHMARK_COMPARISONS).filter(Boolean).length).toBeGreaterThanOrEqual(11);
    expect(BENCHMARK_COMPARISONS['nafems-le10-plate']).toBeNull();
  });

  it('reads an extreme by field/component and compares magnitudes', async () => {
    const comparison = BENCHMARK_COMPARISONS['cantilever']!;
    const reading = await readBenchmark(
      comparison,
      result([{ field: 'displacement', component: 2, min: mm(-0.19012475), minAt: [mm(0), mm(0), mm(0)], max: mm(0), maxAt: [mm(0), mm(0), mm(0)] }]),
      async () => undefined,
    );
    expect(reading.actual).toEqual([-0.19012475]);
    expect(reading.percent).toBeCloseTo(0.957, 2);
    expect(reading.pass).toBe(true);
  });

  it('uses query.probe for a local benchmark quantity and honours an absolute tolerance', async () => {
    const comparison = BENCHMARK_COMPARISONS['bar-transient-heat']!;
    const query = vi.fn(async () => ({ value: { value: 36.79, unit: 'K' }, element: 15, interpolated: true }));
    const reading = await readBenchmark(comparison, result(), query);
    expect(query).toHaveBeenCalledWith({ query: 'query.probe', field: 'temperature', component: 0, at: ['80 mm', '2.5 mm', '2.5 mm'] });
    expect(reading.delta).toBeCloseTo(0.19);
    expect(reading.pass).toBe(true);
  });

  it('compares every modal frequency and rejects incompatible Result shapes', async () => {
    const comparison = BENCHMARK_COMPARISONS['cantilever-modal']!;
    const modal = { ...result(), frequencies: [20.96, 41.91, 131.32, 262.66].map((value) => ({ value, unit: 'Hz' })) };
    expect((await readBenchmark(comparison, modal, async () => undefined)).percent).toBe(0);
    await expect(readBenchmark(comparison, result(), async () => undefined)).rejects.toThrow('expected 4 values');
    const wrongUnit: BenchmarkComparison = { ...comparison, reference: { ...comparison.reference, unit: 'kHz' } };
    await expect(readBenchmark(wrongUnit, modal, async () => ({ value: 0.02, unit: 'MHz' }))).rejects.toThrow('could not convert Hz to kHz');
  });

  it('uses the engine unit query before comparing unlike display units', async () => {
    const comparison = BENCHMARK_COMPARISONS['nafems-le1-membrane']!;
    const query = vi.fn(async (input: Record<string, unknown>) =>
      input['query'] === 'query.probe'
        ? { value: { value: 92_160_590, unit: 'Pa' }, element: 0, interpolated: true }
        : { value: 92.16059, unit: 'MPa' },
    );
    const reading = await readBenchmark(comparison, result(), query);
    expect(query).toHaveBeenLastCalledWith({ query: 'query.convert', quantity: { value: 92_160_590, unit: 'Pa' }, to: 'MPa' });
    expect(reading.actual).toEqual([92.16059]);
    expect(reading.pass).toBe(true);
  });

  it('clears provenance only when another Model is opened or created', () => {
    expect(['model.new', 'file.open', 'file.restore'].map((command) => clearsBenchmark(command, {}))).toEqual([true, true, true]);
    expect(clearsBenchmark('file.restore', null)).toBe(false);
    expect(clearsBenchmark('load.traction')).toBe(false);
    expect(clearsBenchmark('view.fit')).toBe(false);
  });

  it('rejects an example omitted from the explicit registry', () => {
    expect(() => attachComparison(example('surprise-example'))).toThrow("has no comparison decision");
  });
});

describe('example provenance lifecycle', () => {
  it('attaches metadata only after the example replay and its Result refresh finish', async () => {
    const store = new Store({ ...initialState, panels: { ...initialState.panels, examples: true } });
    const journal = [{ cmd: { cmd: 'model.new', name: 'cantilever' } }, { cmd: { cmd: 'solve.run', step: 'static' } }];
    const fetch = vi.fn(async (url: string) =>
      url.endsWith('index.json')
        ? ({ ok: true, json: async () => ({ examples: [example()] }) } as Response)
        : ({ ok: true, text: async () => JSON.stringify(journal) } as Response),
    );
    vi.stubGlobal('fetch', fetch);
    const transport = { dispatch: vi.fn(async (cmd: { cmd: string }) => (cmd.cmd === 'solve.run' ? { output: { type: 'solve' } } : { output: { type: 'none' } })) } as unknown as WorkerTransport;
    const refresh = vi.fn(async () => expect(store.state.benchmark).toBeNull());
    const results = { onAck: vi.fn(async () => expect(store.state.benchmark).toBeNull()) };
    const command = appHostCommands(store, transport, { current: null }, refresh, results as never).find((item) => item.name === 'file.openExample')!;

    await command.run({ name: 'cantilever' }, {} as never);

    expect(transport.dispatch).toHaveBeenCalledTimes(2);
    expect(store.state.benchmark?.name).toBe('cantilever');
    expect(store.state.panels['examples']).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('Theory panel', () => {
  it('typesets theory and shows the actual/reference comparison with stale provenance', async () => {
    const benchmark = attachComparison(example());
    const solved = {
      ...result([{ field: 'displacement', component: 2, min: mm(-0.19012475), minAt: [mm(0), mm(0), mm(0)], max: mm(0), maxAt: [mm(0), mm(0), mm(0)] }]),
      stale: true,
    };
    const root = document.createElement('div');
    render(<Theory benchmark={benchmark} result={solved} currentRevision={0} query={async () => undefined} />, root);
    await waitFor(() => root.querySelector('.theory-values'), 'benchmark values');
    expect(root.querySelector('.katex')).not.toBeNull();
    expect(root.textContent).toContain('current FEM-0.1901 mm');
    expect(root.textContent).toContain('reference0.192 mm');
    expect(root.textContent).toContain('stale Result');
    expect(root.querySelector('.surface.pass')).not.toBeNull();
  });

  it('keeps provenance visible after a modified example is re-solved', async () => {
    const benchmark = attachComparison(example(), 9);
    const solved = result([{ field: 'displacement', component: 2, min: mm(-0.2), minAt: [mm(0), mm(0), mm(0)], max: mm(0), maxAt: [mm(0), mm(0), mm(0)] }]);
    const root = document.createElement('div');
    render(<Theory benchmark={benchmark} result={{ ...solved, revision: 10 }} currentRevision={10} query={async () => undefined} />, root);
    await waitFor(() => root.querySelector('.theory-values'), 'modified comparison');
    expect(root.textContent).toContain('modified example');
    expect(root.textContent).toContain('comparison is informative');
    expect(root.querySelector('.surface.pass')).toBeNull();
  });

  it('explains why LE10 makes no live verification claim', () => {
    const root = document.createElement('div');
    render(<Theory benchmark={attachComparison(example('nafems-le10-plate'))} result={result()} currentRevision={0} query={async () => undefined} />, root);
    expect(root.textContent).toContain('published LE10 line support');
    expect(root.textContent).toContain('Issue #183');
    expect(root.querySelector('.theory-values')).toBeNull();
  });
});
