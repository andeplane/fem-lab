// The 2D sketch of `SketchSpec` as a list of segments with a live preview, instead of the raw
// JSON textarea `SchemaForm` fell back to (issue #43). It holds no state of its own: every edit is
// one `onChange`, which `SchemaForm` routes through `form.open` exactly like a text field, so the
// AI fills a sketch the same way a person does and ADR 0003 still holds for every button here.
//
// This is a list with a picture, not a canvas: dragging points, snapping and dimensions are their
// own plan. What it does own is the loop's wrap-around — segment 0 starts at the *last* segment's
// `to` — which is the part of `SketchSpec` a person cannot see from the JSON.
import { useState } from 'preact/hooks';
import { Cmd, type Dispatch } from './cmd';
import { parseQuantity } from './schema';

export interface Segment {
  kind: 'line' | 'arc';
  to?: unknown[];
  center?: unknown[];
  ccw?: boolean;
  tag?: string | null;
}
export interface Sketch {
  outer: Segment[];
  holes?: Segment[][];
}

const point = (q: unknown[] | undefined): [number, number] | null => {
  const x = parseQuantity(q?.[0]);
  const y = parseQuantity(q?.[1]);
  return x && y ? [x.value, y.value] : null;
};

/** A unit square in the Model's own length unit: one click, and the preview is never empty. */
export function unitRectangle(unit: string): Segment[] {
  const p = (x: number, y: number): Segment => ({ kind: 'line', to: [`${x} ${unit}`, `${y} ${unit}`] });
  return [p(1, 0), p(1, 1), p(0, 1), p(0, 0)];
}

/**
 * The loop as one SVG path, plus how many segments could not be read. The loop closes by wrapping,
 * so the pen starts at the last segment's `to`; an arc's radius is `|to − center|` and its sweep
 * follows `ccw`, with `largeArc` from the angle actually swept about the centre.
 */
export function loopPath(segments: Segment[]): { d: string; points: [number, number][]; skipped: number } {
  const points: [number, number][] = [];
  let skipped = 0;
  const start = point(segments[segments.length - 1]?.to);
  if (!start) return { d: '', points, skipped: segments.length };
  points.push(start);
  let d = `M ${start[0]} ${start[1]}`;
  let from = start;
  for (const seg of segments) {
    const to = point(seg.to);
    if (!to) {
      skipped++;
      continue;
    }
    if (seg.kind === 'arc') {
      const c = point(seg.center);
      if (!c) {
        skipped++;
        continue;
      }
      const r = Math.hypot(to[0] - c[0], to[1] - c[1]);
      const swept = Math.atan2(to[1] - c[1], to[0] - c[0]) - Math.atan2(from[1] - c[1], from[0] - c[0]);
      const ccw = seg.ccw !== false;
      const turn = ccw ? (swept + 2 * Math.PI) % (2 * Math.PI) : (2 * Math.PI - ((swept + 2 * Math.PI) % (2 * Math.PI))) % (2 * Math.PI);
      // SVG's sweep flag is clockwise in *its* coordinates, and the preview flips y, so `ccw` maps
      // straight through to sweep = 1.
      d += ` A ${r} ${r} 0 ${turn > Math.PI ? 1 : 0} ${ccw ? 1 : 0} ${to[0]} ${to[1]}`;
    } else {
      d += ` L ${to[0]} ${to[1]}`;
    }
    points.push(to);
    from = to;
  }
  return { d: `${d} Z`, points, skipped };
}

/** The box every loop fits in, padded by a twentieth, or a unit box when nothing parses. */
export function viewBox(points: [number, number][]): string {
  if (points.length === 0) return '0 0 1 1';
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const pad = Math.max(x1 - x0, y1 - y0, 1e-9) * 0.08;
  return `${x0 - pad} ${-(y1 + pad)} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}`;
}

/** Every distinct unit string a loop mentions: more than one and the preview is out of proportion. */
export function unitsUsed(sketch: Sketch): string[] {
  const all = [sketch.outer ?? [], ...(sketch.holes ?? [])].flat().flatMap((s) => [...(s.to ?? []), ...(s.center ?? [])]);
  return [...new Set(all.map((q) => parseQuantity(q)?.unit ?? '').filter((u) => u !== ''))];
}

const EMPTY: Sketch = { outer: [] };

export function SketchEditor({ value, unit, onChange, dispatch }: { value: unknown; unit: string; onChange(v: Sketch): void; dispatch: Dispatch }) {
  // The only state here, and it is not the sketch: which loop the rows below are showing, the way
  // a tab is. Every edit to the *value* still leaves as one `form.open`.
  const [loop, onLoop] = useState(0);
  // The value comes from anywhere a Command can — a script, the AI, a half-finished edit — so
  // drawing it must not throw on a shape that is not a sketch yet.
  const raw = (value && typeof value === 'object' && !Array.isArray(value) ? value : EMPTY) as Partial<Sketch>;
  const sketch: Sketch = { outer: Array.isArray(raw.outer) ? raw.outer : [], ...(Array.isArray(raw.holes) ? { holes: raw.holes } : {}) };
  const loops = [sketch.outer, ...(sketch.holes ?? [])];
  const at = Math.max(0, Math.min(loop, loops.length - 1));
  const segments = loops[at] ?? [];

  const write = (next: Segment[]) => onChange(at === 0 ? { ...sketch, outer: next } : { ...sketch, holes: (sketch.holes ?? []).map((h, i) => (i === at - 1 ? next : h)) });
  const edit = (i: number, patch: Partial<Segment>) => write(segments.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, by: number) => {
    const next = [...segments];
    const [taken] = next.splice(i, 1);
    next.splice(Math.max(0, Math.min(next.length, i + by)), 0, taken!);
    write(next);
  };
  const add = (kind: 'line' | 'arc') => {
    const last = point(segments[segments.length - 1]?.to) ?? [0, 0];
    write([...segments, kind === 'line' ? { kind, to: [`${last[0]} ${unit}`, `${last[1]} ${unit}`] } : { kind, to: [`${last[0]} ${unit}`, `${last[1]} ${unit}`], center: [`${last[0]} ${unit}`, `${last[1]} ${unit}`], ccw: true }]);
  };

  const paths = loops.map((l) => loopPath(l));
  const all = paths.flatMap((p) => p.points);
  // The SVG is in the sketch's own units, so the stroke and the vertex dots have to be too.
  const extent = all.length === 0 ? 1 : Math.max(Math.max(...all.map((p) => p[0])) - Math.min(...all.map((p) => p[0])), Math.max(...all.map((p) => p[1])) - Math.min(...all.map((p) => p[1])), 1e-9);
  const units = unitsUsed(sketch);
  const skipped = paths.reduce((n, p) => n + p.skipped, 0);

  return (
    <div class="sketch">
      <div class="sketch-loops">
        {loops.map((_, i) => (
          <Cmd key={i} dispatch={dispatch} cmd="form.open" class="chip-add" pressed={i === at} args={{}} title={i === 0 ? 'the outer loop' : `hole ${i}`} onRun={() => onLoop(i)}>
            {i === 0 ? 'outer' : `hole ${i}`}
          </Cmd>
        ))}
        <Cmd dispatch={dispatch} cmd="form.open" class="chip-add" args={{}} title="add a hole loop" onRun={() => (onChange({ ...sketch, holes: [...(sketch.holes ?? []), unitRectangle(unit)] }), onLoop(loops.length))}>
          + hole
        </Cmd>
        {at > 0 ? (
          <Cmd dispatch={dispatch} cmd="form.open" class="chip-add danger" args={{}} title="remove this hole" onRun={() => (onChange({ ...sketch, holes: (sketch.holes ?? []).filter((_, i) => i !== at - 1) }), onLoop(0))}>
            × hole
          </Cmd>
        ) : null}
      </div>

      <svg class="sketch-view" viewBox={viewBox(all)} preserveAspectRatio="xMidYMid meet" aria-label="sketch preview">
        <g transform="scale(1,-1)">
          <path d={paths.map((p) => p.d).join(' ')} fill-rule="evenodd" stroke-width={extent * 0.006} />
          {paths[at]?.points.map((p, i) => (
            <circle key={i} cx={p[0]} cy={p[1]} r={extent * 0.014} />
          ))}
        </g>
      </svg>
      {units.length > 1 ? <div class="sketch-note">mixed units ({units.join(', ')}) — the Command is right, the picture is not to scale</div> : null}
      {skipped > 0 ? <div class="sketch-note">{skipped} segment{skipped === 1 ? '' : 's'} not drawn: a point is missing its number or its unit</div> : null}

      {segments.map((seg, i) => (
        <div key={i} class="sketch-seg">
          <div class="sketch-seg-head">
            <span class="mono faint">{i}</span>
            <Cmd dispatch={dispatch} cmd="form.open" class="seg" pressed={seg.kind === 'line'} args={{}} title="a straight edge" onRun={() => edit(i, { kind: 'line' })}>
              line
            </Cmd>
            <Cmd dispatch={dispatch} cmd="form.open" class="seg" pressed={seg.kind === 'arc'} args={{}} title="a circular arc" onRun={() => edit(i, { kind: 'arc', center: seg.center ?? seg.to, ccw: seg.ccw ?? true })}>
              arc
            </Cmd>
            <input class="mono input tag" placeholder="tag (names the face)" data-cmd="form.open" value={seg.tag ?? ''} onInput={(e) => edit(i, { tag: (e.target as HTMLInputElement).value || null })} />
            <span class="grow" />
            <Cmd dispatch={dispatch} cmd="form.open" class="seg" args={{}} title="move earlier" onRun={() => move(i, -1)}>
              ↑
            </Cmd>
            <Cmd dispatch={dispatch} cmd="form.open" class="seg" args={{}} title="move later" onRun={() => move(i, 1)}>
              ↓
            </Cmd>
            <Cmd dispatch={dispatch} cmd="form.open" class="seg danger" args={{}} title="remove this segment" onRun={() => write(segments.filter((_, j) => j !== i))}>
              ×
            </Cmd>
          </div>
          <div class="sketch-seg-body">
            <label>
              <span class="faint">to x</span>
              <input class="mono input" placeholder={`0 ${unit}`} data-cmd="form.open" value={String(seg.to?.[0] ?? '')} onInput={(e) => edit(i, { to: [(e.target as HTMLInputElement).value, seg.to?.[1] ?? ''] })} />
            </label>
            <label>
              <span class="faint">to y</span>
              <input class="mono input" placeholder={`0 ${unit}`} data-cmd="form.open" value={String(seg.to?.[1] ?? '')} onInput={(e) => edit(i, { to: [seg.to?.[0] ?? '', (e.target as HTMLInputElement).value] })} />
            </label>
            {seg.kind === 'arc' ? (
              <>
                <label>
                  <span class="faint">centre x</span>
                  <input class="mono input" placeholder={`0 ${unit}`} data-cmd="form.open" value={String(seg.center?.[0] ?? '')} onInput={(e) => edit(i, { center: [(e.target as HTMLInputElement).value, seg.center?.[1] ?? ''] })} />
                </label>
                <label>
                  <span class="faint">centre y</span>
                  <input class="mono input" placeholder={`0 ${unit}`} data-cmd="form.open" value={String(seg.center?.[1] ?? '')} onInput={(e) => edit(i, { center: [seg.center?.[0] ?? '', (e.target as HTMLInputElement).value] })} />
                </label>
                <Cmd dispatch={dispatch} cmd="form.open" class="seg" pressed={seg.ccw !== false} args={{}} title="counter-clockwise" onRun={() => edit(i, { ccw: seg.ccw === false })}>
                  ccw
                </Cmd>
              </>
            ) : null}
          </div>
        </div>
      ))}

      <div class="sketch-add">
        <Cmd dispatch={dispatch} cmd="form.open" class="chip-add" args={{}} title="append a straight edge" onRun={() => add('line')}>
          + line
        </Cmd>
        <Cmd dispatch={dispatch} cmd="form.open" class="chip-add" args={{}} title="append a circular arc" onRun={() => add('arc')}>
          + arc
        </Cmd>
        {segments.length === 0 ? (
          <Cmd dispatch={dispatch} cmd="form.open" class="chip-add" args={{}} title={`a 1 × 1 ${unit} square to edit`} onRun={() => write(unitRectangle(unit))}>
            + rectangle
          </Cmd>
        ) : null}
      </div>
    </div>
  );
}
