// The Model tree of docs/design/README.md: groups in workflow order with a badge each, item rows
// with a glyph, a mono name and a one-line summary in display units, the `@` reference button and
// a context menu. Clicking a row opens the Command that made the object in the Properties form —
// re-issuing a create Command is how an edit works (brief §2.1), so there is no second code path.
import { useEffect, useState } from 'preact/hooks';
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
  /** What `+ add …` opens; `null` for read-only groups. A `menu` makes the chip open a choice
   *  first — Geometry's ten shapes — instead of going straight to one Command. */
  add: { what: string; cmd: string; menu?: AddChoice[] } | null;
  items: TreeItem[];
}
export interface AddChoice {
  label: string;
  glyph: string;
  cmd: string;
  args: Record<string, unknown>;
  hint: string;
}

/** A glyph per shape kind, with `◇` for a kind the engine gains after this was written. */
const SHAPE_GLYPH: Record<string, string> = {
  box: '▭',
  cylinder: '⬭',
  sphere: '◯',
  sheet: '▱',
  extrude: '⬒',
  revolve: '◑',
  union: '⬬',
  subtract: '⊖',
  intersect: '⊗',
  transform: '⇲',
};

/**
 * The Geometry chip's menu: every kind `ShapeSpec` declares, so a kind the engine gains appears
 * here without an edit. `box` keeps its own dedicated Command — the tutorials, the examples and
 * `build.spec.ts` all speak `geometry.addBox` — and everything else opens `geometry.add` with the
 * kind already picked. The cut is `geometry.subtract`, which is a different Command, not a shape.
 */
export function shapeMenu(shapes: { kind: string; hint: string }[]): AddChoice[] {
  return [
    ...shapes.map((s) => ({
      label: s.kind,
      glyph: SHAPE_GLYPH[s.kind] ?? '◇',
      hint: s.hint,
      ...(s.kind === 'box' ? { cmd: 'geometry.addBox', args: {} } : { cmd: 'geometry.add', args: { shape: { kind: s.kind } } }),
    })),
    { label: 'cut', glyph: '∖', cmd: 'geometry.subtract', args: {}, hint: 'Cut a shape out of an existing Body.' },
  ];
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

export function treeGroups(s: UiState, shapes: { kind: string; hint: string }[] = []): TreeGroup[] {
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
  const namedSets = m?.sets ?? [];
  return [
    group(
      'Geometry',
      'Boxes, cylinders and extruded polygons, joined with booleans. Every Model starts with one.',
      { what: 'body', cmd: 'geometry.addBox', ...(shapes.length > 0 ? { menu: shapeMenu(shapes) } : {}) },
      [
        ...(m?.bodies ?? []).map((b) => ({
          cmd: 'form.edit',
          args: { kind: 'body', name: b.name },
          run: true,
          kind: 'body',
          glyph: '◈',
          glyphClass: 'glyph low',
          name: b.name,
          summary: `${q(b.measure)} · ${b.faces.length} faces · ${b.material ?? 'no material'}`,
          select: { bodies: [b.name] },
          remove: 'geometry.remove',
        })),
        ...namedSets.map((f) => ({
          cmd: 'form.edit',
          args: { kind: 'set', name: f.name },
          run: true,
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
        cmd: 'form.edit',
        args: { kind: 'material', name: x.name },
        run: true,
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
        cmd: 'form.edit',
        args: { kind: 'constraint', name: x.name },
        run: true,
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
      'Connections',
      'Bonded contact between parts: the two faces behave as one, so an assembly solves like a single body.',
      { what: 'connection', cmd: 'contact.add' },
      (m?.connections ?? []).map((x) => ({
        cmd: 'form.edit',
        args: { kind: 'constraint', name: x.name },
        run: true,
        kind: 'constraint',
        glyph: '⋈',
        glyphClass: 'glyph cyan',
        name: x.name,
        summary: `${x.summary} · ${x.master} to ${x.slave}`,
        select: { sets: [x.master, x.slave] },
        remove: 'constraint.remove',
      })),
    ),
    group(
      'Loads',
      'Pressure, traction, total force, gravity or temperature on a named face — each with its total.',
      { what: 'load', cmd: 'load.pressure' },
      (m?.loads ?? []).map((x) => ({
        cmd: 'form.edit',
        args: { kind: 'load', name: x.name },
        run: true,
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
        cmd: 'form.edit',
        args: { kind: 'step', name: x.name },
        run: true,
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

export function ModelTree({ s, dispatch, shapes = [] }: { s: UiState; dispatch: Dispatch; shapes?: { kind: string; hint: string }[] }) {
  const openMenu = Object.keys(s.panels).find((panel) => panel.startsWith('tree.menu.') && s.panels[panel]);
  const menu = openMenu?.slice('tree.menu.'.length) ?? null;
  const [adding, setAdding] = useState<string | null>(null);
  const groups = treeGroups(s, shapes);
  const stepNames = (s.model?.steps ?? []).map((x) => x.name);
  const selected = s.form ? String(s.form.values['name'] ?? '') : '';
  useEffect(() => {
    if (adding === null) return undefined;
    const closeOnEscape = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setAdding(null);
      document.querySelector<HTMLButtonElement>('.add-row .chip-add')?.focus();
    };
    window.addEventListener('keydown', closeOnEscape, true);
    return () => window.removeEventListener('keydown', closeOnEscape, true);
  }, [adding]);
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
                    return (
                      <div
                        key={itemKey}
                        class={(item.active ?? selected === item.name) ? 'row selected' : 'row'}
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
                  {group.items.length === 0 ? <div class="empty-note">{group.note}</div> : null}
                  {/* Outside the empty branch: a group that already has one thing in it is exactly where
                      a person goes to add the second (issue #43). */}
                  {group.add ? (
                    <div
                      class="add-row"
                      onKeyDown={(e) => {
                        // A menu closes on Escape and hands focus back to what opened it (issue #211).
                        // One handler on the row: keydown bubbles from the chip and every item alike.
                        if (e.key !== 'Escape' || adding !== group.label) return;
                        e.stopPropagation();
                        setAdding(null);
                        (e.currentTarget as HTMLElement).querySelector<HTMLElement>('.chip-add')?.focus();
                      }}
                    >
                      <Cmd
                        dispatch={dispatch}
                        cmd="form.open"
                        class="chip-add"
                        args={{ command: group.add.cmd }}
                        pressed={adding === group.label}
                        title={group.add.menu ? `choose what to add to ${group.label}` : `fill in ${group.add.cmd}`}
                        {...(group.add.menu ? { onRun: () => setAdding(adding === group.label ? null : group.label) } : {})}
                      >
                        + add {group.add.what}
                        {group.add.menu ? ' …' : ''}
                      </Cmd>
                      {group.add.menu && adding === group.label ? (
                        <div class="menu add-menu">
                          {group.add.menu.map((choice) => (
                            <Cmd
                              key={choice.label}
                              dispatch={dispatch}
                              cmd="form.open"
                              class="menu-item"
                              args={{ command: choice.cmd, args: choice.args }}
                              title={choice.hint}
                              onRun={() => (setAdding(null), void dispatch({ cmd: 'form.open', command: choice.cmd, args: choice.args }).catch(() => undefined))}
                            >
                              <span class="mono glyph low">{choice.glyph}</span>
                              <span>{choice.label}</span>
                            </Cmd>
                          ))}
                        </div>
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
