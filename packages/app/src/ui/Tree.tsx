// The Model tree of docs/design/README.md: groups in workflow order with a badge each, item rows
// with a glyph, a mono name and a one-line summary in display units, the `@` reference button and
// a context menu. Clicking a row opens the Command that made the object in the Properties form —
// re-issuing a create Command is how an edit works (brief §2.1), so there is no second code path.
import type { ModelSummary } from '@femlab/registry';
import { useRef, useState } from 'preact/hooks';
import { fieldChoices, showFieldArgs } from '../fields';
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
  /** Rows that are not edited in a form (Results) say for themselves when they are current. */
  active?: boolean;
  /**
   * A row whose Command is run rather than put in the Properties form. Model objects are edited
   * by re-issuing the Command that made them (brief §2.1); a Result is not edited at all, so its
   * row performs `view.showField` — the same Command the legend's chips dispatch.
   */
  run?: boolean;
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

export type DropEdge = 'before' | 'after';

/** The final permutation for one completed pointer or keyboard gesture; `null` is a no-op. */
export function reorderSteps(order: string[], source: string, target: string, edge: DropEdge): string[] | null {
  if (source === target || !order.includes(source) || !order.includes(target)) return null;
  const next = order.filter((name) => name !== source);
  const targetIndex = next.indexOf(target);
  next.splice(targetIndex + (edge === 'after' ? 1 : 0), 0, source);
  return next.every((name, i) => name === order[i]) ? null : next;
}

/** `size` and `at` read back out of a Body's bounding box, in the Model's display units. */
function boxArgs(b: ModelSummary['bodies'][number]): Record<string, unknown> {
  const [x0, y0, z0, x1, y1, z1] = b.bbox as unknown as Valued[];
  const span = (a: Valued, c: Valued) => (a && c ? `${Number((c.value - a.value).toPrecision(6))} ${c.unit}` : '');
  return { name: b.name, size: [span(x0, x1), span(y0, y1), span(z0, z1)], at: [q(x0), q(y0), q(z0)] };
}

/**
 * The design's Results group: one row per scalar the Result can be contoured by — the fields
 * the Step computed, then its mode shapes, then the two derived checks once a Material names a
 * yield. Clicking a row is `view.showField`, which is exactly what the legend's chips do, so
 * the tree and the legend cannot disagree about what is on screen.
 */
export function resultItems(s: UiState): TreeItem[] {
  const r = s.result;
  if (!r) return [];
  // Only an exact component: `|u|` is a magnitude and has no extreme of its own, and borrowing
  // ux's would put the wrong numbers under its name.
  const extreme = (c: { field: string; component: number | null }) => r.extremes.find((e) => e.field === c.field && e.component === c.component);
  return fieldChoices(
    r.extremes.map((e) => e.field),
    r.frequencies?.length ?? 0,
    s.yieldStress !== null,
  ).map((c) => {
    const e = extreme(c);
    const hz = c.mode === undefined ? undefined : r.frequencies?.[c.mode - 1];
    return {
      cmd: 'view.showField',
      args: showFieldArgs(c) as Record<string, unknown>,
      run: true,
      kind: 'result',
      glyph: '◧',
      glyphClass: s.fieldKey === c.key ? 'glyph green' : 'glyph low',
      name: c.label,
      summary: hz ? `${q(hz)} · mode shape` : c.derived ? `from σ_vM and the Material's yield` : e ? `${q(e.min)} … ${q(e.max)} on ${r.step}` : `on ${r.step}`,
      select: {},
      remove: null,
      active: s.fieldKey === c.key,
    };
  });
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
    group('Results', 'A Result appears when a Step finishes, tied to the revision it came from.', null, resultItems(s), s.result ? (s.result.stale ? 'stale' : 'ok') : '—'),
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
  const dragSource = useRef<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ target: string; edge: DropEdge } | null>(null);
  const openMenu = Object.keys(s.panels).find((panel) => panel.startsWith('tree.menu.') && s.panels[panel]);
  const menu = openMenu?.slice('tree.menu.'.length) ?? null;
  const groups = treeGroups(s);
  const stepNames = (s.model?.steps ?? []).map((x) => x.name);
  const selected = s.form ? String(s.form.values['name'] ?? '') : '';
  const clearDrag = () => {
    dragSource.current = null;
    setDragging(null);
    setDrop(null);
  };
  const commitOrder = (order: string[] | null) => {
    clearDrag();
    if (order) void dispatch({ cmd: 'step.reorder', order }).catch(() => undefined);
  };
  return (
    <aside class="panel tree">
      <div class="panel-head">
        <span class="section-label">Model</span>
        <span class="mono panel-sub">rev {s.revision}</span>
      </div>
      <div class="tree-body">
        {groups.map((group) => {
          const slug = group.label.toLowerCase();
          const panel = `tree.${slug}`;
          const bodyId = `tree-${slug}-items`;
          const open = s.panels[panel] !== false;
          return (
            <div key={group.label} class="tree-group">
              <Cmd dispatch={dispatch} cmd="panel.toggle" class="group-head" args={{ panel, open: !open }} expanded={open} controls={bodyId} title={`${open ? 'collapse' : 'expand'} ${group.label}`}>
                <span class="mono caret">{open ? '▾' : '▸'}</span>
                <span class="group-label">{group.label}</span>
                <span class={`mono ${group.badgeClass}`}>{group.badge}</span>
              </Cmd>
              {open ? (
                <div id={bodyId} class="tree-group-body">
                  {group.items.map((item, i) => {
                    const itemKey = `${item.kind}:${item.name}`;
                    const menuPanel = `tree.menu.${itemKey}`;
                    const visible = !s.hiddenBodies.includes(item.name);
                    const isStep = group.label === 'Steps';
                    const dropEdge = drop?.target === item.name ? drop.edge : null;
                    const classes = [
                      'row',
                      (item.active ?? selected === item.name) ? 'selected' : '',
                      isStep ? 'step-row' : '',
                      dragging === item.name ? 'dragging' : '',
                      dropEdge ? `drop-${dropEdge}` : '',
                    ].filter(Boolean).join(' ');
                    return (
                      <div
                        key={itemKey}
                        class={classes}
                        draggable={isStep}
                        data-cmd={isStep ? 'step.reorder' : undefined}
                        data-step={isStep ? item.name : undefined}
                        title={isStep ? `Drag ${item.name} to change the Step run order` : undefined}
                        onDragStart={isStep ? (e) => {
                          if (!e.dataTransfer) return;
                          dragSource.current = item.name;
                          setDragging(item.name);
                          e.dataTransfer.effectAllowed = 'move';
                          e.dataTransfer.setData('text/plain', item.name);
                        } : undefined}
                        onDragOver={isStep ? (e) => {
                          if (!e.dataTransfer || !dragSource.current || dragSource.current === item.name) return;
                          e.preventDefault();
                          e.dataTransfer.dropEffect = 'move';
                          const box = e.currentTarget.getBoundingClientRect();
                          setDrop({ target: item.name, edge: e.clientY < box.top + box.height / 2 ? 'before' : 'after' });
                        } : undefined}
                        onDrop={isStep ? (e) => {
                          if (!e.dataTransfer) return;
                          e.preventDefault();
                          const source = dragSource.current ?? e.dataTransfer.getData('text/plain');
                          const edge = drop?.target === item.name ? drop.edge : 'before';
                          commitOrder(reorderSteps(stepNames, source, item.name, edge));
                        } : undefined}
                        onDragEnd={isStep ? clearDrag : undefined}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          void dispatch({ cmd: 'panel.toggle', panel: menuPanel, open: true }).catch(() => undefined);
                        }}
                      >
                        <Cmd
                          dispatch={dispatch}
                          cmd={item.run ? item.cmd : 'form.open'}
                          class="row-main"
                          args={item.run ? item.args : { command: item.cmd, args: item.args }}
                          title={`${item.cmd} — ${item.name}`}
                        >
                          <span class={item.glyphClass}>{item.glyph}</span>
                          <span class="row-text">
                            <span class="mono name">{item.name}</span>
                            <span class="summary">{item.summary}</span>
                          </span>
                        </Cmd>
                        {isStep && stepNames.length > 1 ? (
                          <span class="step-moves">
                            <Cmd
                              dispatch={dispatch}
                              cmd="step.reorder"
                              class="step-move"
                              label={`Move ${item.name} earlier`}
                              title="move this Step earlier"
                              disabled={i === 0}
                              args={{ order: stepNames }}
                              onRun={() => commitOrder(reorderSteps(stepNames, item.name, stepNames[i - 1] ?? item.name, 'before'))}
                            >
                              ↑
                            </Cmd>
                            <Cmd
                              dispatch={dispatch}
                              cmd="step.reorder"
                              class="step-move"
                              label={`Move ${item.name} later`}
                              title="move this Step later"
                              disabled={i === stepNames.length - 1}
                              args={{ order: stepNames }}
                              onRun={() => commitOrder(reorderSteps(stepNames, item.name, stepNames[i + 1] ?? item.name, 'after'))}
                            >
                              ↓
                            </Cmd>
                          </span>
                        ) : null}
                        {item.kind === 'body' ? (
                          <Cmd
                            dispatch={dispatch}
                            cmd="view.setVisible"
                            class={visible ? 'tree-action visibility' : 'tree-action visibility off'}
                            args={{ bodies: [item.name], on: !visible }}
                            pressed={visible}
                            label={`${visible ? 'Hide' : 'Show'} ${item.name} in viewer`}
                            title={`${visible ? 'hide' : 'show'} ${item.name} in viewer`}
                          >
                            <span class="eye" aria-hidden="true" />
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
                        <Cmd
                          dispatch={dispatch}
                          cmd="panel.toggle"
                          class="tree-action menu-trigger"
                          args={{ panel: menuPanel, open: menu !== itemKey }}
                          pressed={menu === itemKey}
                          label={`Actions for ${item.name}`}
                          title={`actions for ${item.name}`}
                        >
                          ⋯
                        </Cmd>
                        {menu === itemKey ? (
                          <Menu item={item} dispatch={dispatch} close={() => void dispatch({ cmd: 'panel.toggle', panel: menuPanel, open: false }).catch(() => undefined)} />
                        ) : null}
                      </div>
                    );
                  })}
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
              ) : null}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
