import katex from 'katex';
import 'katex/dist/katex.min.css';
import { useEffect, useState } from 'preact/hooks';
import { readBenchmark, type ActiveBenchmark, type BenchmarkReading } from '../benchmark';
import { formatNumber } from '../fields';
import type { ResultSummary } from '@femlab/registry';
import type { Query } from './SchemaForm';

type ReadingState = { kind: 'loading' } | { kind: 'ready'; reading: BenchmarkReading } | { kind: 'error'; message: string };

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

export function Theory({ benchmark, result, currentRevision, query }: { benchmark: ActiveBenchmark; result: ResultSummary; currentRevision: number; query: Query }) {
  const comparison = benchmark.comparison;
  const modified = benchmark.modelRevision !== currentRevision;
  const stale = result.stale || modified;
  const [state, setState] = useState<ReadingState>({ kind: 'loading' });
  useEffect(() => {
    if (!comparison) return;
    let live = true;
    setState({ kind: 'loading' });
    void readBenchmark(comparison, result, query).then(
      (reading) => live && setState({ kind: 'ready', reading }),
      (error: unknown) => live && setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      live = false;
    };
  }, [benchmark.name, comparison, query, result.revision]);

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
          <span>
            {benchmark.name === 'nafems-le10-plate'
              ? 'Live comparison withheld: this model clamps the full outer face, unlike the published LE10 line support. Issue #183 tracks the matching variant.'
              : 'This reference needs a local probe or interpretation that is not represented by the current Result summary, so no live pass/fail is claimed.'}
          </span>
        </div>
      ) : state.kind === 'loading' ? (
        <div class="empty-note">Reading {comparison.reference.label} from this Result…</div>
      ) : state.kind === 'error' ? (
        <div class="surface warn">
          <span>!</span>
          <span>Comparison unavailable: {state.message}</span>
        </div>
      ) : (
        <>
          <div class="theory-values">
            <span>current FEM</span>
            <strong class="mono">{values(state.reading.actual, state.reading.unit)}</strong>
            <span>reference</span>
            <strong class="mono">{values(state.reading.reference, state.reading.unit)}</strong>
            <span>difference</span>
            <strong class="mono">{formatNumber(state.reading.percent)} %</strong>
          </div>
          <div class={state.reading.pass && !modified ? 'surface pass' : 'surface warn'}>
            <span>{state.reading.pass && !modified ? '✓' : '!'}</span>
            <span class="mono">
              {modified ? 'Model differs from the bundled benchmark · comparison is informative' : `${comparison.reference.label} · tolerance ${toleranceText(benchmark)}`}
            </span>
          </div>
        </>
      )}
      <div class="theory-reference">
        <span class="mono">reference</span>
        <span>{benchmark.expected.reference}</span>
      </div>
      {comparison ? <div class="theory-source">Source: {comparison.source}</div> : null}
    </section>
  );
}
