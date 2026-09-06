// The Results and Checks tabs of docs/design/README.md §Bottom panel. Results is what the
// solve produced — extremes, reactions with the balance check, a probe, a path plot and the
// convergence bars; Checks is what the Model is about to hand the solver, live and before any
// solve. Both are views of Queries, and every button on them is one Command.
import type { CostEstimate, Extreme, MeshSummary, PathResult, ProbeResult, ResultSummary, Valued } from '@femlab/registry';
import { useEffect, useRef, useState } from 'preact/hooks';
import { FIELD_CHOICES, choiceOf, dimensionOf, formatNumber } from '../fields';
import type { UiState } from '../store';
import type { Query } from './SchemaForm';
import { Cmd, type Dispatch } from './cmd';
import { blockers } from './schema';

const num = (v: Valued | undefined): string => (v ? formatNumber(v.value) : '—');
const at = (p: [Valued, Valued, Valued]): string => p.map((v) => formatNumber(v.value)).join(' ');
const fieldUnit = (field: string, v: Valued): string => (dimensionOf(field) === 'dimensionless' && v.unit === 'SI' ? '(1)' : v.unit);

/** `balance` is a ratio of forces; the design writes it as a percentage with four decimals. */
export function balanceLine(r: ResultSummary): { pass: boolean; text: string } {
  const percent = r.balance * 100;
  return { pass: Math.abs(r.balance) < 1e-6, text: `Σ reactions = −Σ loads · ${percent.toFixed(4)} %` };
}

/** The extreme whose largest magnitude leads the table: the number the engineer reads first. */
export function peakOf(extremes: Extreme[]): Extreme | undefined {
  return [...extremes].sort((a, b) => Math.max(Math.abs(b.min.value), Math.abs(b.max.value)) - Math.max(Math.abs(a.min.value), Math.abs(a.max.value)))[0];
}

/** The Model's overall span in display units, for framing a camera on one point of it. */
export function modelSpan(s: UiState): number {
  const boxes = (s.model?.bodies ?? []).map((b) => b.bbox);
  if (boxes.length === 0) return 1;
  const lo = [0, 1, 2].map((k) => Math.min(...boxes.map((b) => b[k]!.value)));
  const hi = [0, 1, 2].map((k) => Math.max(...boxes.map((b) => b[k + 3]!.value)));
  return Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) || 1;
}

/** A point in display units as the SI metres the viewer's camera speaks. */
export function siPoint(p: [Valued, Valued, Valued], factor: number): [number, number, number] {
  return [p[0]!.value / factor, p[1]!.value / factor, p[2]!.value / factor];
}

function Extremes({ s, dispatch }: { s: UiState; dispatch: Dispatch }) {
  const r = s.result!;
  const peak = peakOf(r.extremes);
  const span = modelSpan(s) / s.lengthFactor;
  const goTo = (target: [number, number, number]) => ({
    cmd: 'view.setCamera',
    position: [target[0] + span, target[1] - span * 1.35, target[2] + span * 0.9],
    target,
  });
  return (
    <div class="rtable-wrap">
      <table class="rtable">
        <thead>
          <tr>
            <th>field</th>
            <th>min</th>
            <th>max</th>
            <th>at (max)</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {r.extremes.map((e) => (
            <tr key={`${e.field}.${e.component}`} class={e === peak ? 'peak' : ''}>
              <td class="mono">
                {extremeLabel(e)}
                <span class="faint">{e.field}</span>
              </td>
              <td class="mono n">
                {num(e.min)} {fieldUnit(e.field, e.min)}
              </td>
              <td class="mono n">
                {num(e.max)} {fieldUnit(e.field, e.max)}
              </td>
              <td class="mono loc faint">
                {at(e.maxAt)} {e.maxAt[0].unit}
              </td>
              <td>
                <Cmd dispatch={dispatch} cmd="view.setCamera" class="chip-add" args={goTo(siPoint(e.maxAt, s.lengthFactor))} title="centre the camera on this extreme">
                  go to
                </Cmd>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** `displacement 2` is not what an engineer calls it: the field picker's own name is. */
export function extremeLabel(e: { field: string; component: number }): string {
  return FIELD_CHOICES.find((c) => c.field === e.field && c.component === e.component)?.label ?? `${e.field} ${e.component}`;
}

function Reactions({ s }: { s: UiState }) {
  const r = s.result!;
  const sum = [0, 1, 2].map((c) => r.reactions.reduce((a, x) => a + x.total[c]!.value, 0));
  const unit = r.appliedTotal[0]!.unit;
  const balance = balanceLine(r);
  return (
    <div class="rtable-wrap">
      <table class="rtable">
        <thead>
          <tr>
            <th>constraint</th>
            <th>Fx</th>
            <th>Fy</th>
            <th>Fz {unit}</th>
          </tr>
        </thead>
        <tbody>
          {r.reactions.map((x) => (
            <tr key={x.constraint}>
              <td class="mono">{x.constraint}</td>
              {x.total.map((v, i) => (
                <td key={i} class="mono n">
                  {num(v)}
                </td>
              ))}
            </tr>
          ))}
          <tr class="total">
            <td>Σ reactions</td>
            {sum.map((v, i) => (
              <td key={i} class="mono n">
                {formatNumber(v)}
              </td>
            ))}
          </tr>
          <tr class="total">
            <td>Σ applied</td>
            {r.appliedTotal.map((v, i) => (
              <td key={i} class="mono n">
                {num(v)}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      <div class={balance.pass ? 'surface pass' : 'surface warn'} data-balance={r.balance}>
        <span>{balance.pass ? '✓' : '!'}</span>
        <span class="mono">{balance.text}</span>
      </div>
    </div>
  );
}

/** The convergence study's mini bars: one per mesh size, the finest one green. */
function Convergence({ s }: { s: UiState }) {
  const study = s.study;
  if (!study) return null;
  const peak = Math.max(...study.rows.map((r) => Math.abs(r.value)), 1e-30);
  const last = study.rows[study.rows.length - 1];
  return (
    <>
      <div class="section-label">Mesh convergence</div>
      <div class="bars">
        {study.rows.map((row, i) => (
          <div key={i} class="bar-row">
            <span class="mono faint">{formatNumber(row.size.value)}</span>
            <span class="bar-track">
              <span class={i === study.rows.length - 1 ? 'bar-fill last' : 'bar-fill'} style={`width:${(Math.abs(row.value) / peak) * 100}%`} />
            </span>
            <span class="mono n">{formatNumber(row.value)}</span>
          </div>
        ))}
      </div>
      <LineChart
        x={study.rows.map((r) => r.size.value)}
        y={study.rows.map((r) => r.value)}
        xUnit={study.rows[0]?.size.unit ?? ''}
        yUnit={study.unit}
        xLabel="h"
        yLabel="value"
        mark={last?.value ?? null}
      />
      <div class="rule-note mono">
        → {formatNumber(last?.value ?? 0)} {study.unit}
        {study.observedRate === null || study.observedRate === undefined ? '' : ` · rate ${formatNumber(study.observedRate)}`}
      </div>
    </>
  );
}

const P0 = ['0 mm', '0 mm', '0 mm'];

/** The probe and the path, side by side: one point, and a line of them as an inline plot. */
function Sample({ s, query }: { s: UiState; query: Query }) {
  const [at, setAt] = useState(P0.join(', '));
  const [to, setTo] = useState(P0.join(', '));
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [path, setPath] = useState<PathResult | null>(null);
  const [error, setError] = useState('');
  const field = s.transient?.catalogue.field ?? s.result?.extremes[0]?.field ?? 'vonMises';
  const choice = choiceOf(s.fieldKey);
  const requested = useRef<{ probe: string[] | null; path: { from: string[]; to: string[] } | null }>({ probe: null, path: null });
  const generation = useRef(0);
  const sampledIdentity = useRef({ probe: '', path: '' });
  const identity = `${s.result?.step}:${s.transient?.generation}:${s.transient?.frame.index}:${s.fieldKey}`;
  const currentIdentity = useRef(identity);
  if (currentIdentity.current !== identity) { currentIdentity.current = identity; generation.current++; }
  const context = {
    step: s.result?.step, field,
    ...(s.transient ? { sample: { kind: 'frame', index: s.transient.frame.index }, ...(choice.component === null ? {} : { component: choice.component }) } : {}),
  };
  const parse = (text: string): string[] => text.split(',').map((p) => p.trim());
  const run = (q: Record<string, unknown>, keep: (v: unknown) => void): void => {
    const ticket = generation.current;
    setError('');
    query({ query: q['query'] as string, ...q })
      .then((value) => { if (ticket === generation.current) keep(value); })
      .catch((e: { cause?: string }) => { if (ticket === generation.current) setError(e.cause ?? 'the sample failed'); });
  };
  const keepProbe = (value: unknown): void => { sampledIdentity.current.probe = identity; setProbe(value as ProbeResult); };
  const keepPath = (value: unknown): void => { sampledIdentity.current.path = identity; setPath(value as PathResult); };
  useEffect(() => {
    setProbe(null); setPath(null);
    if (requested.current.probe) run({ query: 'query.probe', ...context, at: requested.current.probe }, keepProbe);
    if (requested.current.path) run({ query: 'query.path', ...context, ...requested.current.path, n: 24 }, keepPath);
    return () => { generation.current++; };
  }, [identity]);
  return (
    <div class="sample">
      <div class="section-label">Probe · path</div>
      <label>
        <span>from</span>
        <input class="mono" data-field="probe.at" value={at} onInput={(e) => setAt((e.target as HTMLInputElement).value)} />
      </label>
      <label>
        <span>to</span>
        <input class="mono" data-field="path.to" value={to} onInput={(e) => setTo((e.target as HTMLInputElement).value)} />
      </label>
      <div class="row">
        <Cmd dispatch={async () => undefined} cmd="query.probe" class="chip-add" onRun={() => {
          requested.current.probe = parse(at);
          run({ query: 'query.probe', ...context, at: requested.current.probe }, keepProbe);
        }}>
          probe
        </Cmd>
        <Cmd dispatch={async () => undefined} cmd="query.path" class="chip-add" onRun={() => {
          requested.current.path = { from: parse(at), to: parse(to) };
          run({ query: 'query.path', ...context, ...requested.current.path, n: 24 }, keepPath);
        }}>
          path
        </Cmd>
      </div>
      {probe && sampledIdentity.current.probe === identity ? (
        <div class="mono probe-out">
          {field} {formatNumber(probe.value.value)} {probe.value.unit} · element {probe.element}
          {probe.sample ? ` · ${formatNumber(probe.sample.frame.time.value)} ${probe.sample.frame.time.unit}` : ''}
        </div>
      ) : null}
      {path && sampledIdentity.current.path === identity ? <PathPlot path={path} /> : null}
      {error ? <div class="surface error mono">{error}</div> : null}
    </div>
  );
}

// ── the one line chart ────────────────────────────────────────────────────────────────────
// Every plot in the app is this component: the transient history, the convergence study and
// the sampled path. Inline SVG, no chart library — a polyline, five ticks a side with the
// unit written once, and a hover readout that names the point under the pointer.

const PLOT = { w: 260, h: 108, l: 46, r: 8, t: 10, b: 20 };

/** `n` round ticks spanning `lo…hi`, and where each sits as a fraction of the axis. */
export function axisTicks(lo: number, hi: number, n = 5): { at: number; text: string }[] {
  return Array.from({ length: n }, (_, i) => ({ at: i / (n - 1), text: formatNumber(lo + ((hi - lo) * i) / (n - 1)) }));
}

export interface ChartProps {
  x: number[];
  y: (number | null)[];
  xUnit: string;
  yUnit: string;
  xLabel: string;
  yLabel: string;
  /** Draw a horizontal reference line at this y (the utilisation limit, a reference value). */
  mark?: number | null;
}

/**
 * A line chart with axis ticks in the Model's units and a readout under the pointer. The
 * readout is the point of it: an engineer reads a history off the numbers, not the shape.
 */
export function LineChart({ x, y, xUnit, yUnit, xLabel, yLabel, mark = null }: ChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const points = y.map((v, i) => ({ v, i })).filter((p): p is { v: number; i: number } => p.v !== null && Number.isFinite(p.v));
  if (points.length < 2) return <div class="empty-note">Not enough points to plot: {points.length} of {y.length} samples had a value.</div>;
  const xs = points.map((p) => x[p.i] ?? p.i);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...points.map((p) => p.v), ...(mark === null ? [] : [mark]));
  const y1 = Math.max(...points.map((p) => p.v), ...(mark === null ? [] : [mark]));
  const px = (v: number) => PLOT.l + ((v - x0) / (x1 - x0 || 1)) * (PLOT.w - PLOT.l - PLOT.r);
  const py = (v: number) => PLOT.h - PLOT.b - ((v - y0) / (y1 - y0 || 1)) * (PLOT.h - PLOT.t - PLOT.b);
  const at = hover === null ? null : points[Math.max(0, Math.min(points.length - 1, hover))];
  return (
    <div class="chart">
      <svg
        class="plot"
        viewBox={`0 0 ${PLOT.w} ${PLOT.h}`}
        role="img"
        aria-label={`${yLabel} against ${xLabel}, ${points.length} points`}
        onMouseMove={(e) => {
          const box = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const frac = ((e.clientX - box.left) / box.width) * PLOT.w;
          setHover(Math.round(((frac - PLOT.l) / (PLOT.w - PLOT.l - PLOT.r)) * (points.length - 1)));
        }}
        onMouseLeave={() => setHover(null)}
      >
        <line x1={PLOT.l} y1={PLOT.t} x2={PLOT.l} y2={PLOT.h - PLOT.b} stroke="#262a33" />
        <line x1={PLOT.l} y1={PLOT.h - PLOT.b} x2={PLOT.w - PLOT.r} y2={PLOT.h - PLOT.b} stroke="#262a33" />
        {axisTicks(y0, y1).map((t) => (
          <text key={`y${t.at}`} class="mono" x={PLOT.l - 4} y={PLOT.h - PLOT.b - t.at * (PLOT.h - PLOT.t - PLOT.b) + 3} text-anchor="end">
            {t.text}
          </text>
        ))}
        {axisTicks(x0, x1, 3).map((t) => (
          <text key={`x${t.at}`} class="mono" x={PLOT.l + t.at * (PLOT.w - PLOT.l - PLOT.r)} y={PLOT.h - 6} text-anchor={t.at === 0 ? 'start' : t.at === 1 ? 'end' : 'middle'}>
            {t.text}
          </text>
        ))}
        {mark === null ? null : <line x1={PLOT.l} y1={py(mark)} x2={PLOT.w - PLOT.r} y2={py(mark)} stroke="#d9a441" stroke-dasharray="3 3" />}
        <polyline points={points.map((p) => `${px(x[p.i] ?? p.i)},${py(p.v)}`).join(' ')} fill="none" stroke="#58b7d6" stroke-width="1.5" />
        {at ? <circle cx={px(x[at.i] ?? at.i)} cy={py(at.v)} r="2.5" fill="#e2703a" /> : null}
      </svg>
      <div class="mono chart-readout">
        {at
          ? `${xLabel} ${formatNumber(x[at.i] ?? at.i)} ${xUnit} · ${yLabel} ${formatNumber(at.v)} ${yUnit}`
          : `${yLabel} ${yUnit === '' ? '' : `(${yUnit}) `}against ${xLabel}${xUnit === '' ? '' : ` (${xUnit})`} · hover to read a point`}
      </div>
    </div>
  );
}

/** The sampled path, through the one chart. */
export function PathPlot({ path }: { path: PathResult }) {
  return <LineChart x={path.s} y={path.values} xUnit="m" yUnit={path.unit} xLabel="s" yLabel="value" />;
}

/**
 * The transient history: what the field's extremes did over time. `query.result.history` is
 * one row per output time, so this is a real plot of the Result and not of the animation.
 */
export function History({ s }: { s: UiState }) {
  const rows = s.result?.history ?? [];
  if (rows.length === 0) return null;
  const unit = rows[0]!.max.unit;
  return (
    <>
      <div class="section-label">History · {s.result!.step}</div>
      <LineChart x={rows.map((r) => r.time.value)} y={rows.map((r) => r.max.value)} xUnit={rows[0]!.time.unit} yUnit={unit} xLabel="t" yLabel="max" />
      <LineChart x={rows.map((r) => r.time.value)} y={rows.map((r) => r.min.value)} xUnit={rows[0]!.time.unit} yUnit={unit} xLabel="t" yLabel="min" />
    </>
  );
}

/**
 * A modal Step's natural frequencies, with the Command that puts each mode shape on screen.
 * Mode `k`'s shape is the Result field `mode:k` (crates/engine/src/solve_run.rs).
 */
export function Frequencies({ s, dispatch }: { s: UiState; dispatch: Dispatch }) {
  const f = s.result?.frequencies ?? [];
  if (f.length === 0) return null;
  return (
    <>
      <div class="section-label">Natural frequencies</div>
      <div class="rtable-wrap">
        <table class="rtable">
          <thead>
            <tr>
              <th>mode</th>
              <th>frequency</th>
              <th>period</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {f.map((hz, i) => (
              <tr key={i} class={s.fieldKey === `mode:${i + 1}` ? 'peak' : ''}>
                <td class="mono">{i + 1}</td>
                <td class="mono n">
                  {formatNumber(hz.value)} {hz.unit}
                </td>
                <td class="mono n faint">{hz.value > 0 ? `${formatNumber(1 / hz.value)} s` : '—'}</td>
                <td>
                  <Cmd dispatch={dispatch} cmd="view.showField" class="chip-add" args={{ field: `mode:${i + 1}` }} pressed={s.fieldKey === `mode:${i + 1}`} title={`view.showField mode:${i + 1}`}>
                    show
                  </Cmd>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div class="rule-note">A mode shape has no amplitude of its own: ▶ on the deformation bar sweeps it.</div>
    </>
  );
}

export function Results({ s, dispatch, query }: { s: UiState; dispatch: Dispatch; query: Query }) {
  const next = blockers(s.model?.warnings ?? [], Boolean(s.model?.meshSettings), (s.model?.bodies.length ?? 0) > 0)[0];
  if (!s.result) {
    return (
      <div class="checks">
        <div class="empty-note">No Result yet. Extremes, reactions with the balance check and the convergence study appear here the moment a Step finishes.</div>
        {next?.fixCmd ? (
          <Cmd dispatch={dispatch} cmd="form.open" class="chip-add" args={{ command: next.fixCmd }}>
            {next.fixLabel}
          </Cmd>
        ) : (
          <Cmd dispatch={dispatch} cmd="solve.run" class="chip-add" args={{ step: s.model?.steps[0]?.name ?? '' }}>
            solve.run
          </Cmd>
        )}
      </div>
    );
  }
  return (
    <div class="results">
      <div class="rcol">
        <div class="section-label">
          Extremes · {s.result.step} · {s.result.solver} · {Math.round(s.result.timeMs)} ms
        </div>
        <Extremes s={s} dispatch={dispatch} />
        <Frequencies s={s} dispatch={dispatch} />
        <Sample s={s} query={query} />
      </div>
      <div class="rcol">
        <div class="section-label">Reactions</div>
        <Reactions s={s} />
        <History s={s} />
        <Convergence s={s} />
      </div>
    </div>
  );
}

const bytes = (n: number): string => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(0)} MB` : `${(n / 1e3).toFixed(0)} kB`);

export function Checks({ s, dispatch, query }: { s: UiState; dispatch: Dispatch; query: Query }) {
  const list = blockers(s.model?.warnings ?? [], Boolean(s.model?.meshSettings), (s.model?.bodies.length ?? 0) > 0);
  const [mesh, setMesh] = useState<MeshSummary | null>(null);
  const [cost, setCost] = useState<CostEstimate | null>(null);
  const step = s.model?.steps[0]?.name ?? '';
  useEffect(() => {
    // Both Queries build the Mesh, so they only run once the Model has one to build.
    if (!s.model?.meshSettings) return void (setMesh(null), setCost(null));
    query({ query: 'query.mesh' })
      .then((m) => setMesh(m as MeshSummary))
      .catch(() => setMesh(null));
    if (step === '') return void setCost(null);
    query({ query: 'query.cost', step })
      .then((c) => setCost(c as CostEstimate))
      .catch(() => setCost(null));
  }, [query, s.revision, s.model?.meshSettings, step]);

  const q = mesh?.quality ?? null;
  return (
    <div class="checks">
      <div class="section-label">Well-posedness</div>
      {list.length === 0 ? (
        <div class="surface pass">
          <span>✓</span>
          <span>Nothing blocks a solve: every Body has a Material, the Model is held, loaded and has a Step.</span>
        </div>
      ) : null}
      {list.map((b) => (
        <div key={b.code} class="check-row">
          <span class="mono code">{b.code}</span>
          <span class="check-text">{b.text}</span>
          {b.fixCmd ? (
            <Cmd dispatch={dispatch} cmd="form.open" class="chip-add" args={{ command: b.fixCmd }}>
              {b.fixLabel}
            </Cmd>
          ) : null}
        </div>
      ))}

      <div class="section-label">Mesh quality</div>
      {q ? (
        <>
          <div class="kv mono">
            <span>min scaled Jacobian</span>
            <span class={q.minDetJRatio <= 0 ? 'bad' : 'n'}>{formatNumber(q.minDetJRatio)}</span>
            <span>max aspect ratio</span>
            <span class="n">{formatNumber(q.maxAspect)}</span>
            <span>min corner angle</span>
            <span class="n">{formatNumber(q.minAngleDeg)}°</span>
            <span>nodes · elements</span>
            <span class="n">
              {mesh!.nodes} · {mesh!.elements} {mesh!.elementKind}
            </span>
          </div>
          {q.worst.length > 0 ? (
            <div class="worst">
              <span class="faint">worst elements</span>
              {q.worst.slice(0, 6).map((w) => (
                <Cmd key={w.element} dispatch={dispatch} cmd="selection.set" class="chip-add" args={{ sets: [`element:${w.element}`] }} title={`element ${w.element}, ${formatNumber(w.value)}`}>
                  {w.element}
                </Cmd>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <div class="empty-note">Element quality appears once the Model has a Mesh (mesh.set).</div>
      )}

      <div class="section-label">Cost estimate</div>
      {cost ? (
        <div class="kv mono">
          <span>degrees of freedom</span>
          <span class="n">{cost.dofs}</span>
          <span>matrix non-zeros</span>
          <span class="n">{cost.nnz}</span>
          <span>memory</span>
          <span class="n">{bytes(cost.bytes)}</span>
          <span>feasible here</span>
          <span class={cost.feasible ? 'n' : 'bad'}>{cost.feasible ? 'yes' : 'no'}</span>
          <span>note</span>
          <span>{cost.note}</span>
        </div>
      ) : (
        <div class="empty-note">The DOF and memory estimate appears once a Mesh and a Step exist.</div>
      )}

      <div class="section-label">Assumption log</div>
      {s.assumptions.length === 0 ? (
        <div class="empty-note">Every default the solver fell back on is listed here after a solve. The last one made none.</div>
      ) : (
        s.assumptions.map((w, i) => (
          <div key={i} class="check-row">
            <span class="mono code">{w.code}</span>
            <span class="check-text">{w.text}</span>
            {w.where ? <span class="mono faint">{w.where}</span> : null}
          </div>
        ))
      )}
    </div>
  );
}
