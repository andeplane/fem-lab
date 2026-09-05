// The Model tree of docs/design/README.md: groups in workflow order with a badge each, item rows
// with a glyph, a mono name and a one-line summary in display units, the `@` reference button and
// a context menu. Clicking a row opens the Command that made the object in the Properties form —
// re-issuing a create Command is how an edit works (brief §2.1), so there is no second code path.
import type { ModelSummary } from '@femlab/registry';
import { useState } from 'preact/hooks';
import type { UiState } from '../store';
import { Cmd, type Dispatch } from './cmd';

export interface TreeItem {
  /** The Command a click puts in the Properties form, with the object read back as its arguments. */
  cmd: string;
  args: Record<string, unknown>;
  kind: string;
  glyph: string;
  glyphClass: string;
  name: string;
  summary: string;
  /** `selection.set` arguments for "select in viewer"; empty for objects the viewer cannot show. */
  select: Record<string, unknown>;
  /** The `*.remove` Command for this kind, if it has one. */
  remove: string | null;
}
export interface TreeGroup {
  label: string;
  badge: string;
  badgeClass: string;
  note: string;
  /** What `+ add …` opens; `null` for read-only groups. */
  add: { what: string; cmd: string } | null;
  items: TreeItem[];
}

/** Which group an engine warning belongs to, so the badges say where the problem is. */
const GROUP_OF: Record<string, string> = {
  'model.empty': 'Geometry',
  'model.ill-posed': 'Geometry',
  'model.no-material': 'Materials',
  'model.unconstrained': 'Constraints',
  'model.unloaded': 'Loads',
  'model.no-step': 'Steps',
  'load.no-density': 'Loads',
};

type Valued = { value: number; unit: string } | undefined;
const q = (v: Valued): string => (v ? `${Number(v.value.toPrecision(4))} ${v.unit}` : '');

/** `size` and `at` read back out of a Body's bounding box, in the Model's display units. */
function boxArgs(b: ModelSummary['bodies'][number]): Record<string, unknown> {
  const [x0, y0, z0, x1, y1, z1] = b.bbox as unknown as Valued[];
  const span = (a: Valued, c: Valued) => (a && c ? `${Number((c.value - a.value).toPrecision(6))} ${c.unit}` : '');
  return { name: b.name, size: [span(x0, x1), span(y0, y1), span(z0, z1)], at: [q(x0), q(y0), q(z0)] };
}

export function treeGroups(s: UiState): TreeGroup[] {
  const m = s.model;
  const counts = new Map<string, number>();
  for (const w of m?.warnings ?? []) {
    const g = GROUP_OF[w.code];
    if (g) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  const group = (label: string, note: string, add: TreeGroup['add'], items: TreeItem[], badge?: string): TreeGroup => {
    const n = counts.get(label) ?? 0;
    return {
      label,
      note,
      add,
      items,
      badge: badge ?? (n > 0 ? `${n} warning${n === 1 ? '' : 's'}` : items.length > 0 ? 'ok' : '—'),
      badgeClass: n > 0 ? 'badge warn' : items.length > 0 ? 'badge ok' : 'badge',
    };
  };
  const faces = (m?.sets ?? []).filter((x) => x.kind === 'face');
  return [
    group(
      'Geometry',
      'Boxes, cylinders and extruded polygons, joined with booleans. Every Model starts with one.',
      { what: 'body', cmd: 'geometry.addBox' },
      [
        ...(m?.bodies ?? []).map((b) => ({
          cmd: 'geometry.addBox',
          args: boxArgs(b),
          kind: 'body',
          glyph: '◈',
          glyphClass: 'glyph low',
          name: b.name,
          summary: `${q(b.measure)} · ${b.faces.length} faces · ${b.material ?? 'no material'}`,
          select: { bodies: [b.name] },
          remove: 'geometry.remove',
        })),
        ...faces.map((f) => ({
          cmd: 'geometry.nameFace',
          args: { name: f.name },
          kind: 'set',
          glyph: '▣',
          glyphClass: 'glyph cyan',
          name: f.name,
          summary: f.summary,
          select: { sets: [f.name] },
          remove: 'geometry.remove',
        })),
      ],
    ),
    group(
      'Materials',
      'Nothing carries stiffness yet. Every Body needs a Material before a Step can start.',
      { what: 'material', cmd: 'material.add' },
      (m?.materials ?? []).map((x) => ({
        cmd: 'material.add',
        args: { name: x.name, E: q(x.E), nu: x.nu, ...(x.rho ? { rho: q(x.rho) } : {}) },
        kind: 'material',
        glyph: '●',
        glyphClass: 'glyph mat',
        name: x.name,
        summary: `E ${q(x.E)} · ν ${x.nu}${x.rho ? ` · ρ ${q(x.rho)}` : ''} · on ${x.assignedTo.join(', ') || 'nothing'}`,
        select: { bodies: x.assignedTo },
        remove: 'material.remove',
      })),
    ),
    group(
      'Mesh',
      'One global size and an element order. Counts and cost are known before you solve.',
      { what: 'mesh', cmd: 'mesh.set' },
      m?.meshSettings
        ? [
            {
              cmd: 'mesh.set',
              args: { mesher: m.meshSettings.mesher, order: m.meshSettings.order, formulation: m.meshSettings.formulation },
              kind: 'mesh',
              glyph: '▦',
              glyphClass: 'glyph low',
              name: 'mesh',
              summary: `${m.meshSettings.mesher.kind} · order ${m.meshSettings.order} · ${m.meshSettings.formulation}`,
              select: {},
              remove: null,
            },
          ]
        : [],
      m?.meshSettings ? undefined : (m?.bodies.length ?? 0) > 0 ? '1 warning' : '—',
    ),
    group(
      'Constraints',
      'Fix, symmetry or a prescribed displacement on a named face. Without one the body floats.',
      { what: 'constraint', cmd: 'constraint.fix' },
      (m?.constraints ?? []).map((x) => ({
        cmd: 'constraint.fix',
        args: { name: x.name, on: x.on },
        kind: 'constraint',
        glyph: '△',
        glyphClass: 'glyph cyan',
        name: x.name,
        summary: `${x.summary} on ${x.on}`,
        select: { sets: [x.on] },
        remove: 'constraint.remove',
      })),
    ),
    group(
      'Loads',
      'Pressure, traction, total force, gravity or temperature on a named face — each with its total.',
      { what: 'load', cmd: 'load.pressure' },
      (m?.loads ?? []).map((x) => ({
        cmd: `load.${x.kind}`,
        args: { name: x.name, ...(x.on ? { on: x.on } : {}) },
        kind: 'load',
        glyph: x.kind === 'gravity' ? '→' : '↓',
        glyphClass: 'glyph load',
        name: x.name,
        summary: `${x.summary}${x.on ? ` on ${x.on}` : ''}`,
        select: x.on ? { sets: [x.on] } : {},
        remove: 'load.remove',
      })),
    ),
    group(
      'Steps',
      'Static now, modal and transient later. A Step says which Constraints and Loads are active.',
      { what: 'step', cmd: 'step.add' },
      (m?.steps ?? []).map((x) => ({
        cmd: 'step.add',
        args: { name: x.name, procedure: x.procedure, constraints: x.constraints, loads: x.loads },
        kind: 'step',
        glyph: '▶',
        glyphClass: x.solved ? 'glyph green' : 'glyph low',
        name: x.name,
        summary: `${x.procedure} · ${x.constraints.length} constraints · ${x.loads.length} loads${x.solved ? ' · solved' : ''}`,
        select: {},
        remove: 'step.remove',
      })),
    ),
    group('Results', 'A Result appears when a Step finishes, tied to the revision it came from.', null, [], (m?.steps ?? []).some((x) => x.solved) ? 'ok' : '—'),
    group('Plugins', 'Material laws, elements, meshers and checks, loaded by Command and recorded by hash.', null, [], '—'),
  ];
}

function Menu({ item, dispatch, close }: { item: TreeItem; dispatch: Dispatch; close(): void }) {
  const ask = (what: string, fallback: string): string | null => (typeof prompt === 'function' ? prompt(what, fallback) : fallback);
  return (
    <div class="menu" onMouseLeave={close}>
      <Cmd
        dispatch={dispatch}
        cmd="model.rename"
        class="menu-item"
        onRun={() => {
          const to = ask(`Rename ${item.name} to`, item.name);
          close();
          if (to && to !== item.name) void dispatch({ cmd: 'model.rename', kind: item.kind, name: item.name, to }).catch(() => undefined);
        }}
      >
        Rename…
      </Cmd>
      <Cmd
        dispatch={dispatch}
        cmd="model.duplicate"
        class="menu-item"
        onRun={() => {
          const as = ask(`Duplicate ${item.name} as`, `${item.name}_copy`);
          close();
          if (as) void dispatch({ cmd: 'model.duplicate', kind: item.kind, name: item.name, as }).catch(() => undefined);
        }}
      >
        Duplicate…
      </Cmd>
      {item.remove ? (
        <Cmd dispatch={dispatch} cmd={item.remove} class="menu-item danger" args={{ name: item.name }} onRun={() => (close(), void dispatch({ cmd: item.remove!, name: item.name }).catch(() => undefined))}>
          Delete
        </Cmd>
      ) : null}
      <Cmd dispatch={dispatch} cmd="selection.set" class="menu-item" args={item.select} onRun={() => (close(), void dispatch({ cmd: 'selection.set', ...item.select }).catch(() => undefined))}>
        Select in viewer
      </Cmd>
      <Cmd dispatch={dispatch} cmd="clipboard.copy" class="menu-item" args={{ what: { kind: 'script' } }} onRun={() => (close(), void dispatch({ cmd: 'clipboard.copy', what: { kind: 'script' } }).catch(() => undefined))}>
        Copy as script
      </Cmd>
    </div>
  );
}

export function ModelTree({ s, dispatch }: { s: UiState; dispatch: Dispatch }) {
  const [menu, setMenu] = useState<string | null>(null);
  const groups = treeGroups(s);
  const stepNames = (s.model?.steps ?? []).map((x) => x.name);
  const selected = s.form ? String(s.form.values['name'] ?? '') : '';
  return (
    <aside class="panel tree">
      <div class="panel-head">
        <span class="section-label">Model</span>
        <span class="mono panel-sub">rev {s.revision}</span>
      </div>
      <div class="tree-body">
        {groups.map((group) => (
          <div key={group.label} class="tree-group">
            <div class="group-head">
              <span class="mono caret">▾</span>
              <span class="group-label">{group.label}</span>
              <span class={`mono ${group.badgeClass}`}>{group.badge}</span>
            </div>
            {group.items.map((item, i) => (
              <div key={`${item.kind}:${item.name}`} class={selected === item.name ? 'row selected' : 'row'} onContextMenu={(e) => (e.preventDefault(), setMenu(`${item.kind}:${item.name}`))}>
                <Cmd dispatch={dispatch} cmd="form.open" class="row-main" args={{ command: item.cmd, args: item.args }} title={`${item.cmd} — ${item.name}`}>
                  <span class={item.glyphClass}>{item.glyph}</span>
                  <span class="row-text">
                    <span class="mono name">{item.name}</span>
                    <span class="summary">{item.summary}</span>
                  </span>
                </Cmd>
                {group.label === 'Steps' && stepNames.length > 1 ? (
                  <Cmd
                    dispatch={dispatch}
                    cmd="step.reorder"
                    class="at"
                    title="move this Step earlier"
                    disabled={i === 0}
                    args={{ order: stepNames }}
                    onRun={() => {
                      const order = [...stepNames];
                      order.splice(i - 1, 0, ...order.splice(i, 1));
                      void dispatch({ cmd: 'step.reorder', order }).catch(() => undefined);
                    }}
                  >
                    ↑
                  </Cmd>
                ) : null}
                <Cmd
                  dispatch={dispatch}
                  cmd="chat.insertMention"
                  class="at"
                  title={`reference @${item.kind}:${item.name} in chat`}
                  onRun={() => {
                    const ref = `${item.kind}:${item.name}`;
                    void dispatch({ cmd: 'chat.insertMention', ref }).catch(() => dispatch({ cmd: 'clipboard.copy', what: { kind: 'mention', ref } }).catch(() => undefined));
                  }}
                >
                  @
                </Cmd>
                {menu === `${item.kind}:${item.name}` ? <Menu item={item} dispatch={dispatch} close={() => setMenu(null)} /> : null}
              </div>
            ))}
            {group.items.length === 0 ? (
              <div class="empty">
                <div class="empty-note">{group.note}</div>
                {group.add ? (
                  <Cmd dispatch={dispatch} cmd="form.open" class="chip-add" args={{ command: group.add.cmd }} title={`fill in ${group.add.cmd}`}>
                    + add {group.add.what}
                  </Cmd>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </aside>
  );
}
