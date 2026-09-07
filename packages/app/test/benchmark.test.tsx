import type { ResultSummary, StudyReport, Valued } from '@femlab/registry';
import { render } from 'preact';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  BENCHMARK_COMPARISONS,
  BENCHMARK_UNMAPPED_REASONS,
  attachComparison,
  benchmarkChanged,
  clearsBenchmark,
  completeJournalHash,
  readBenchmark,
  type BenchmarkComparison,
  type BenchmarkProvenance,
  type ExampleEntry,
} from '../src/benchmark';
import { appHostCommands, openExample } from '../src/host';
import { Store, initialState } from '../src/store';
import { Theory } from '../src/ui/Theory';
import type { WorkerTransport } from '../src/worker-transport';
import { waitFor } from './wait-for';

const journals = path.resolve(import.meta.dirname, '../../../crates/engine/benches/journals');
const mm = (value: number): Valued => ({ value, unit: 'mm' });
const result = (extremes: ResultSummary['extremes'] = []): ResultSummary =>
  ({ resultId: 'result-1', step: 'static', revision: 9, stale: false, solver: 'cpu-direct', iterations: 1, residual: 0, timeMs: 1, extremes, reactions: [], reactionQuantity: 'force', appliedTotal: [mm(0), mm(0), mm(0)], balance: 0 }) as ResultSummary;
const example = (name = 'cantilever'): ExampleEntry => ({
  name,
  commands: 10,
  summary: 'A benchmark.',
  title: 'Cantilever beam',
  tag: 'P1 · verify',
  tags: ['static', 'beam'],
  difficulty: 1,
  thumbnail: null,
  theory: 'Beam theory gives $\\delta = PL^3/(3EI)$.',
  expected: { quantity: 'tip deflection', value: -0.1901, unit: 'mm', reference: 'Timoshenko: 0.1919619 mm' },
});
const provenance = (patch: Partial<BenchmarkProvenance> = {}): BenchmarkProvenance => ({ modelName: 'cantilever', modelHash: 'model-a', modelRevision: 9, journalHash: 'journal-a', ...patch });

describe('benchmark comparison registry', () => {
  it('makes an explicit comparison-or-null decision for every bundled example', () => {
    const names = readdirSync(journals)
      .filter((file) => file.endsWith('.json') && !file.endsWith('.meta.json'))
      .map((file) => path.basename(file, '.json'))
      .sort();
    expect(Object.keys(BENCHMARK_COMPARISONS).sort()).toEqual(names);
    expect(Object.values(BENCHMARK_COMPARISONS).filter(Boolean).length).toBeGreaterThanOrEqual(11);
    expect(BENCHMARK_COMPARISONS['nafems-le10-plate']).toMatchObject({
      locator: { kind: 'probe', field: 'stress', component: 1, at: ['2 m', '0 m', '0.6 m'] },
      reference: { values: [-5.25], unit: 'MPa' },
    });
    expect(BENCHMARK_COMPARISONS['heated-fin']).toMatchObject({ reference: { values: [0.1656], unit: 'mm' } });
    const unmapped = Object.entries(BENCHMARK_COMPARISONS).filter(([, comparison]) => comparison === null).map(([name]) => name).sort();
    expect(Object.keys(BENCHMARK_UNMAPPED_REASONS).sort()).toEqual(unmapped);
    for (const reason of Object.values(BENCHMARK_UNMAPPED_REASONS)) expect(reason.length).toBeGreaterThan(80);
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

  it('compares the heated fin tip expansion with the free thermal-strain solution', async () => {
    const comparison = BENCHMARK_COMPARISONS['heated-fin']!;
    const reading = await readBenchmark(
      comparison,
      result([{ field: 'displacement', component: 0, min: mm(0), minAt: [mm(0), mm(0), mm(0)], max: mm(0.168386), maxAt: [mm(120), mm(20), mm(0)] }]),
      async () => undefined,
    );
    expect(reading.reference).toEqual([0.1656]);
    expect(reading.percent).toBeCloseTo(1.682, 2);
    expect(reading.pass).toBe(true);
  });

  it('uses query.probe for a local benchmark quantity and honours an absolute tolerance', async () => {
    const comparison = BENCHMARK_COMPARISONS['bar-transient-heat']!;
    const query = vi.fn(async () => ({ value: { value: 36.79, unit: 'K' }, element: 15, interpolated: true }));
    const reading = await readBenchmark(comparison, result(), query);
    expect(query).toHaveBeenCalledWith({ query: 'query.probe', step: 'static', field: 'temperature', component: 0, at: ['80 mm', '2.5 mm', '2.5 mm'] });
    expect(reading.delta).toBeCloseTo(0.19);
    expect(reading.pass).toBe(true);
  });

  it('samples hoop stress away from the tube base with the thin-wall approximation caveat', async () => {
    const comparison = BENCHMARK_COMPARISONS['tube-under-pressure']!;
    const query = vi.fn(async () => ({ value: { value: 71.1645, unit: 'MPa' }, element: 28, interpolated: true }));
    const reading = await readBenchmark(comparison, result(), query);
    expect(query).toHaveBeenCalledWith({ query: 'query.probe', step: 'static', field: 'stress', component: 1, at: ['47.5 mm', '0 mm', '100 mm'] });
    expect(reading.percent).toBeCloseTo(6.3625, 3);
    expect(reading.pass).toBeNull();
  });

  it('compares a three-mesh Richardson limit with the analytical beam limit', async () => {
    const comparison = BENCHMARK_COMPARISONS['mesh-convergence-cantilever']!;
    const study = { rows: [{ value: -0.1894 }, { value: -0.1901 }, { value: -0.19044 }], unit: 'mm', observedRate: 1.112, extrapolated: -0.19073000145 } as StudyReport;
    const reading = await readBenchmark(comparison, result(), async () => undefined, study);
    expect(reading.actual).toEqual([-0.19073000145]);
    expect(reading.percent).toBeCloseTo(0.13325, 4);
    expect(reading.pass).toBe(true);
    await expect(readBenchmark(comparison, result(), async () => undefined)).rejects.toThrow('no three-mesh convergence-study extrapolation');
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

  it('checks the corrected LE10 full-face variant at upper-surface point D', async () => {
    const comparison = BENCHMARK_COMPARISONS['nafems-le10-plate']!;
    const query = vi.fn(async () => ({ value: { value: -5.234137, unit: 'MPa' }, element: 0, interpolated: true }));
    const reading = await readBenchmark(comparison, result(), query);
    expect(query).toHaveBeenCalledWith({ query: 'query.probe', step: 'static', field: 'stress', component: 1, at: ['2 m', '0 m', '0.6 m'] });
    expect(reading.percent).toBeCloseTo(0.30215, 4);
    expect(reading.pass).toBe(true);
  });

  it('clears provenance only when another Model is opened or created', () => {
    expect(['model.new', 'file.open', 'file.restore', 'project.open', 'project.new'].map((command) => clearsBenchmark(command, {}))).toEqual([true, true, true, true, true]);
    expect(clearsBenchmark('file.restore', null)).toBe(false);
    expect(clearsBenchmark('load.traction')).toBe(false);
    expect(clearsBenchmark('view.fit')).toBe(false);
    expect(clearsBenchmark('example.open')).toBe(false);
    expect(clearsBenchmark('file.openExample')).toBe(false);
  });

  it('rejects an example omitted from the explicit registry', () => {
    expect(() => attachComparison(example('surprise-example'))).toThrow("has no comparison decision");
  });

  it('detects a replacement Journal at the same model revision', () => {
    const journalA = { entries: [{ seq: 0, cmd: { cmd: 'model.new', name: 'a' }, hashAfter: 'same-model' }], revision: 1, canUndo: true, canRedo: false } as never;
    const journalB = { entries: [{ seq: 0, cmd: { cmd: 'model.new', name: 'b' }, hashAfter: 'same-model' }], revision: 1, canUndo: true, canRedo: false } as never;
    expect(completeJournalHash(journalA)).not.toBe(completeJournalHash(journalB));
    const original = provenance({ journalHash: completeJournalHash(journalA) });
    const replacement = provenance({ journalHash: completeJournalHash(journalB) });
    expect(benchmarkChanged(original, replacement)).toBe(true);
    expect(benchmarkChanged(original, original)).toBe(false);
  });
});

describe('example provenance lifecycle', () => {
  it('attaches metadata only after the example replay and its Result refresh finish', async () => {
    const store = new Store({ ...initialState, panels: { ...initialState.panels, examples: true } });
    const journal = [{ cmd: { cmd: 'model.new', name: 'cantilever' } }, { cmd: { cmd: 'study.converge', step: 'static' } }, { cmd: { cmd: 'solve.run', step: 'static' } }];
    const fetch = vi.fn(async (url: string) =>
      url.endsWith('index.json')
        ? ({ ok: true, json: async () => ({ examples: [example()] }) } as Response)
        : ({ ok: true, text: async () => JSON.stringify(journal) } as Response),
    );
    vi.stubGlobal('fetch', fetch);
    const transport = { exportFile: vi.fn(async () => ({ journal: { entries: journal } })), dispatch: vi.fn(async (cmd: { cmd: string }) => (cmd.cmd === 'solve.run' ? { output: { type: 'solve' } } : cmd.cmd === 'study.converge' ? { output: { type: 'study', report: { rows: [] } } } : { output: { type: 'none' } })) } as unknown as WorkerTransport;
    const refresh = vi.fn(async () => {
      expect(store.state.benchmark).toBeNull();
      store.set({
        model: { name: 'cantilever', hash: 'model-a' } as never,
        journal: { entries: [{ seq: 0, cmd: journal[0]!.cmd, hashAfter: 'model-a' }], revision: 2, canUndo: true, canRedo: false } as never,
        revision: 2,
      });
    });
    const results = { onAck: vi.fn(async (_ack: unknown) => expect(store.state.benchmark).toBeNull()) };
    const command = appHostCommands(store, transport, { current: null }, refresh, results as never).find((item) => item.name === 'file.openExample')!;

    await command.run({ name: 'cantilever' }, { examples: { open: (name: string) => openExample(name, store, transport, refresh, results as never) } } as never);

    expect(transport.dispatch).toHaveBeenCalledTimes(3);
    expect(results.onAck.mock.calls.map(([ack]) => (ack as { output: { type: string } }).output.type)).toEqual(['study', 'solve']);
    expect(store.state.benchmark?.name).toBe('cantilever');
    expect(store.state.benchmark).toMatchObject({ modelName: 'cantilever', modelHash: 'model-a', modelRevision: 2 });
    expect(store.state.benchmark?.journalHash).toBe(completeJournalHash(store.state.journal));
    expect(store.state.panels['examples']).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('Theory panel', () => {
  it('typesets theory and shows the actual/reference comparison with stale provenance', async () => {
    const benchmark = attachComparison(example(), provenance());
    const solved = {
      ...result([{ field: 'displacement', component: 2, min: mm(-0.19012475), minAt: [mm(0), mm(0), mm(0)], max: mm(0), maxAt: [mm(0), mm(0), mm(0)] }]),
      stale: true,
    };
    const root = document.createElement('div');
    render(<Theory benchmark={benchmark} result={solved} current={provenance()} query={async () => undefined} />, root);
    await waitFor(() => root.querySelector('.theory-values'), 'benchmark values');
    expect(root.querySelector('.katex')).not.toBeNull();
    expect(root.textContent).toContain('current FEM-0.1901 mm');
    expect(root.textContent).toContain('reference0.192 mm');
    expect(root.textContent).toContain('stale Result');
    expect(root.textContent).toContain('re-solve before claiming');
    expect(root.querySelector('.surface.pass')).toBeNull();
  });

  it('keeps provenance visible after a modified example is re-solved', async () => {
    const benchmark = attachComparison(example(), provenance());
    const solved = result([{ field: 'displacement', component: 2, min: mm(-0.2), minAt: [mm(0), mm(0), mm(0)], max: mm(0), maxAt: [mm(0), mm(0), mm(0)] }]);
    const root = document.createElement('div');
    render(<Theory benchmark={benchmark} result={{ ...solved, revision: 10 }} current={provenance({ modelRevision: 10, modelHash: 'model-b', journalHash: 'journal-b' })} query={async () => undefined} />, root);
    await waitFor(() => root.querySelector('.theory-values'), 'modified comparison');
    expect(root.textContent).toContain('modified example');
    expect(root.textContent).toContain('comparison is informative');
    expect(root.querySelector('.surface.pass')).toBeNull();
  });

  it('labels a mapped observable with its own reference instead of unrelated expected metadata', async () => {
    const entry = { ...example('heated-fin'), expected: { quantity: 'peak von Mises', value: 160.2, unit: 'MPa', reference: 'no closed form; restraint dependent' } };
    const benchmark = attachComparison(entry, provenance());
    const solved = result([{ field: 'displacement', component: 0, min: mm(0), minAt: [mm(0), mm(0), mm(0)], max: mm(0.168386), maxAt: [mm(120), mm(20), mm(0)] }]);
    const root = document.createElement('div');
    render(<Theory benchmark={benchmark} result={solved} current={provenance()} query={async () => undefined} />, root);
    await waitFor(() => root.querySelector('.theory-values'), 'thermal expansion comparison');
    expect(root.querySelector('.theory-reference')?.textContent).toContain('uˣ at the free tip · 0.1656 mm');
    expect(root.querySelector('.theory-reference')?.textContent).not.toContain('no closed form');
  });

  it('shows the tube membrane estimate as informative without a green validation claim', async () => {
    const benchmark = attachComparison(example('tube-under-pressure'), provenance());
    const root = document.createElement('div');
    render(<Theory benchmark={benchmark} result={result()} current={provenance()} query={async () => ({ value: { value: 71.1645, unit: 'MPa' } })} />, root);
    await waitFor(() => root.querySelector('.theory-values'), 'tube estimate');
    expect(root.textContent).toContain('no sourced pass/fail tolerance');
    expect(root.querySelector('.surface.info')).not.toBeNull();
    expect(root.querySelector('.surface.pass')).toBeNull();
  });

  it('shows the corrected ESRD LE10 live reference', async () => {
    const root = document.createElement('div');
    render(<Theory benchmark={attachComparison(example('nafems-le10-plate'), provenance())} result={result()} current={provenance()} query={async () => ({ value: { value: -5.234137, unit: 'MPa' } })} />, root);
    await waitFor(() => root.querySelector('.theory-values'), 'LE10 comparison');
    expect(root.textContent).toContain('σᵧᵧ at upper-surface point D');
    expect(root.querySelector('.surface.pass')).not.toBeNull();
  });

  it('hides an old reading while a different Result at the same revision is being queried', async () => {
    const benchmark = attachComparison(example('bar-transient-heat'), provenance());
    const pending: Array<(value: unknown) => void> = [];
    const query = vi.fn(() => new Promise<unknown>((resolve) => pending.push(resolve)));
    const first = result();
    const root = document.createElement('div');
    render(<Theory benchmark={benchmark} result={first} current={provenance()} query={query} />, root);
    await waitFor(() => pending.length === 1, 'first probe');
    expect(query).toHaveBeenLastCalledWith({ query: 'query.probe', step: 'static', field: 'temperature', component: 0, at: ['80 mm', '2.5 mm', '2.5 mm'] });
    pending.shift()!({ value: { value: 36.6, unit: 'K' } });
    await waitFor(() => root.querySelector('.theory-values'), 'first reading');
    expect(root.textContent).toContain('36.6 K');

    const second = { ...first, step: 'thermal-later' };
    render(<Theory benchmark={benchmark} result={second} current={provenance()} query={query} />, root);
    expect(root.textContent).toContain('Reading T at x = 80 mm, t = 32 s');
    expect(root.querySelector('.theory-values')).toBeNull();
    await waitFor(() => pending.length === 1, 'second probe');
    expect(query).toHaveBeenLastCalledWith({ query: 'query.probe', step: 'thermal-later', field: 'temperature', component: 0, at: ['80 mm', '2.5 mm', '2.5 mm'] });
    pending.shift()!({ value: { value: 36.8, unit: 'K' } });
    await waitFor(() => root.textContent?.includes('36.8 K'), 'replacement reading');
  });
});
