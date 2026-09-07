import katex from 'katex';
import 'katex/dist/katex.min.css';
import { useEffect, useState } from 'preact/hooks';
import { BENCHMARK_UNMAPPED_REASONS, benchmarkChanged, readBenchmark, type ActiveBenchmark, type BenchmarkProvenance, type BenchmarkReading } from '../benchmark';
import { formatNumber } from '../fields';
import type { ResultSummary, StudyReport } from '@femlab/registry';
import type { Query } from './SchemaForm';

type ReadingState =
  | { kind: 'loading'; benchmark: string; result: ResultSummary; study: StudyReport | null; stale: boolean }
  | { kind: 'ready'; benchmark: string; result: ResultSummary; study: StudyReport | null; stale: boolean; reading: BenchmarkReading }
  | { kind: 'error'; benchmark: string; result: ResultSummary; study: StudyReport | null; stale: boolean; message: string };

/** Render only the inline TeX delimited by `$`; every other metadata byte stays text. */
export function TheoryText({ text }: { text: string }) {
  return (
    <p class="theory-copy">
      {text.split(/(\$[^$\n]+\$)/g).map((part, i) =>
        part.startsWith('$') && part.endsWith('$') ? <span key={i} dangerouslySetInnerHTML={{ __html: katex.renderToString(part.slice(1, -1), { throwOnError: false }) }} /> : part,
      )}
    </p>
  );
}

const values = (row: number[], unit: string): string => `${row.map(formatNumber).join(' · ')} ${unit}`;

export function toleranceText(benchmark: ActiveBenchmark): string {
  const tolerance = benchmark.comparison?.tolerance;
  if (!tolerance) return '';
  return tolerance.kind === 'percent' ? `≤ ${formatNumber(tolerance.value)} %` : `≤ ${formatNumber(tolerance.value)} ${tolerance.unit}`;
}

export function Theory({ benchmark, result, study = null, current, query }: { benchmark: ActiveBenchmark; result: ResultSummary; study?: StudyReport | null; current: BenchmarkProvenance; query: Query }) {
  const comparison = benchmark.comparison;
  const modified = benchmarkChanged(benchmark, current);
  const stale = result.stale || modified;
  const [state, setState] = useState<ReadingState>({ kind: 'loading', benchmark: benchmark.name, result, study, stale: result.stale });
  // Effects start after paint. Hide a reading from the previous Result immediately rather than
  // briefly presenting it as the value of a newly selected Step or replacement Result.
  const visible = state.benchmark === benchmark.name && state.result === result && state.study === study && state.stale === result.stale ? state : { kind: 'loading' as const };
  useEffect(() => {
    if (!comparison) return;
    let live = true;
    setState({ kind: 'loading', benchmark: benchmark.name, result, study, stale: result.stale });
    void readBenchmark(comparison, result, query, study).then(
      (reading) => live && setState({ kind: 'ready', benchmark: benchmark.name, result, study, stale: result.stale, reading }),
      (error: unknown) => live && setState({ kind: 'error', benchmark: benchmark.name, result, study, stale: result.stale, message: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      live = false;
    };
  }, [benchmark.name, comparison, query, result, result.step, result.revision, result.stale, study]);

  return (
    <section class={stale ? 'theory-panel stale' : 'theory-panel'} aria-label={`Theory for ${benchmark.title}`}>
      <div class="theory-head">
        <span class="section-label">Theory · {benchmark.tag}</span>
        {stale ? <span class="theory-stale mono">{result.stale ? 'stale Result' : 'modified example'}</span> : null}
      </div>
      <h3>{benchmark.title}</h3>
      <TheoryText text={benchmark.theory} />
      {comparison === null ? (
        <div class="surface info theory-unmapped">
          <span>i</span>
          <span>{BENCHMARK_UNMAPPED_REASONS[benchmark.name]}</span>
        </div>
      ) : visible.kind === 'loading' ? (
        <div class="empty-note">Reading {comparison.reference.label} from this Result…</div>
      ) : visible.kind === 'error' ? (
        <div class="surface warn">
          <span>!</span>
          <span>Comparison unavailable: {visible.message}</span>
        </div>
      ) : (
        <>
          <div class="theory-values">
            <span>current FEM</span>
            <strong class="mono">{values(visible.reading.actual, visible.reading.unit)}</strong>
            <span>reference</span>
            <strong class="mono">{values(visible.reading.reference, visible.reading.unit)}</strong>
            <span>difference</span>
            <strong class="mono">{formatNumber(visible.reading.percent)} %</strong>
          </div>
          <div class={visible.reading.pass === null && !stale ? 'surface info' : visible.reading.pass && !stale ? 'surface pass' : 'surface warn'}>
            <span>{visible.reading.pass === null && !stale ? 'i' : visible.reading.pass && !stale ? '✓' : '!'}</span>
            <span class="mono">
              {modified ? 'Model differs from the bundled benchmark · comparison is informative' : result.stale ? 'Result is stale · re-solve before claiming this comparison' : visible.reading.pass === null ? comparison.informative : `${comparison.reference.label} · tolerance ${toleranceText(benchmark)}`}
            </span>
          </div>
        </>
      )}
      <div class="theory-reference">
        <span class="mono">{comparison ? 'comparison' : 'reference'}</span>
        <span>{comparison ? `${comparison.reference.label} · ${values(comparison.reference.values, comparison.reference.unit)}` : benchmark.expected.reference}</span>
      </div>
      {comparison ? <div class="theory-source">Source: {comparison.source}</div> : null}
    </section>
  );
}
