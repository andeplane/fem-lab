// The Results and Checks tabs of docs/design/README.md §Bottom panel. Results is what the
// solve produced — extremes, reactions with the balance check, a probe, a path plot and the
// convergence bars; Checks is what the Model is about to hand the solver, live and before any
// solve. Both are views of Queries, and every button on them is one Command.
import type { CostEstimate, Extreme, MeshSummary, PathResult, ProbeResult, ResultSummary, Valued } from '@femlab/registry';
import { useEffect, useState } from 'preact/hooks';
import { formatNumber } from '../fields';
import type { UiState } from '../store';
import type { Query } from './SchemaForm';
import { Cmd, type Dispatch } from './cmd';
import { blockers } from './schema';

const num = (v: Valued | undefined): string => (v ? formatNumber(v.value) : '—');
const at = (p: [Valued, Valued, Valued]): string => p.map((v) => formatNumber(v.value)).join(' ');

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
              {e.field}
              <span class="faint">{e.component}</span>
            </td>
            <td class="mono n">{num(e.min)}</td>
            <td class="mono n">{num(e.max)}</td>
            <td class="mono n faint">
              {at(e.maxAt)} {e.max.unit}
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
  );
}

function Reactions({ s }: { s: UiState }) {
  const r = s.result!;
  const sum = [0, 1, 2].map((c) => r.reactions.reduce((a, x) => a + x.total[c]!.value, 0));
  const unit = r.appliedTotal[0]!.unit;
  const balance = balanceLine(r);
  return (
    <>
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
    </>
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
  const field = s.result?.extremes[0]?.field ?? 'vonMises';
  const parse = (text: string): string[] => text.split(',').map((p) => p.trim());
  const run = (q: Record<string, unknown>, keep: (v: unknown) => void): void => {
    setError('');
    query({ query: q['query'] as string, ...q })
      .then(keep)
      .catch((e: { cause?: string }) => setError(e.cause ?? 'the sample failed'));
  };
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
        <Cmd dispatch={async () => undefined} cmd="query.probe" class="chip-add" onRun={() => run({ query: 'query.probe', field, at: parse(at) }, (v) => setProbe(v as ProbeResult))}>
          probe
        </Cmd>
        <Cmd dispatch={async () => undefined} cmd="query.path" class="chip-add" onRun={() => run({ query: 'query.path', field, from: parse(at), to: parse(to), n: 24 }, (v) => setPath(v as PathResult))}>
          path
        </Cmd>
      </div>
      {probe ? (
        <div class="mono probe-out">
          {field} {formatNumber(probe.value.value)} {probe.value.unit} · element {probe.element}
        </div>
      ) : null}
      {path ? <PathPlot path={path} /> : null}
      {error ? <div class="surface error mono">{error}</div> : null}
    </div>
  );
}

/** A 220 × 64 line plot; no chart library for one polyline. */
export function PathPlot({ path }: { path: PathResult }) {
  const points = path.values.map((v, i) => ({ v, i })).filter((p): p is { v: number; i: number } => p.v !== null);
  if (points.length < 2) return <div class="empty-note">The path left the mesh at every sample.</div>;
  const lo = Math.min(...points.map((p) => p.v));
  const hi = Math.max(...points.map((p) => p.v));
  const span = hi - lo || 1;
  const sMax = path.s[path.s.length - 1] || 1;
  const d = points.map((p) => `${(path.s[p.i]! / sMax) * 220},${60 - ((p.v - lo) / span) * 56}`).join(' ');
  return (
    <svg class="plot" viewBox="0 0 220 64" role="img" aria-label={`path plot in ${path.unit}`}>
      <polyline points={d} fill="none" stroke="#58b7d6" stroke-width="1.5" />
      <text x="0" y="10" class="mono">
        {formatNumber(hi)} {path.unit}
      </text>
      <text x="0" y="62" class="mono">
        {formatNumber(lo)}
      </text>
    </svg>
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
        <Sample s={s} query={query} />
      </div>
      <div class="rcol">
        <div class="section-label">Reactions</div>
        <Reactions s={s} />
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
