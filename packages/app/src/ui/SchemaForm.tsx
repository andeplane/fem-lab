// The Properties panel of docs/design/README.md, generated from `engine.schema.json`: one
// Command variant in, the design's fields out. Editing a field is itself a Command (`form.open`
// with the new arguments), so the AI can fill this form and ADR 0003 still holds for every
// control. Apply dispatches exactly one Command; Revert goes back to what the form opened with.
import type { JsonSchema } from '@femlab/registry';
import { useEffect, useState } from 'preact/hooks';
import type { LastError, Store, UiState } from '../store';
import { Cmd, type Dispatch } from './cmd';
import { PressurePreview } from './PressurePreview';
import { SketchEditor } from './SketchEditor';
import { applyLabel, commandLine, defaultFormValues, type Defs, type Field, fieldsOf, getAt, missingRequired, parseQuantity, setAt, siUnit, step } from './schema';

export type Query = (q: { query: string } & Record<string, unknown>) => Promise<unknown>;

export interface FormProps {
  s: UiState;
  store: Store;
  dispatch: Dispatch;
  query: Query;
  defs: Defs;
  variants: Map<string, JsonSchema>;
}

type FieldProps = FormProps & { field: Field; values: Record<string, unknown>; fields: Field[] };

/** Every control writes the whole argument object back through `form.open`; that is its Command. */
const editor = (s: UiState, dispatch: Dispatch, values: Record<string, unknown>, fields: Field[]) => (path: string[], value: unknown) =>
  void dispatch({ cmd: 'form.open', command: s.form?.cmd ?? '', args: defaultFormValues(setAt(values, path, value), fields), keepInitial: true }).catch(() => undefined);

/**
 * A multi-valued field's current value as a list. The form's values come from anywhere a
 * Command can — a tree row, a script, the AI, a half-finished edit — so a field that wants an
 * array will meet a string or an object, and drawing it must not throw. One value becomes a
 * list of one; anything else draws empty and Apply lets the engine say why.
 */
export function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return value === undefined || value === null || typeof value === 'object' ? [] : [String(value)];
}

/** What a running tutorial step expects in this input, shown as its `placeholder` (issue #46).
 * `undefined` — no tutorial, or nothing to say about this field — leaves the input bare. */
const hintFor = (s: UiState, path: string[]): string | undefined => s.formHints?.[path.join('.')];

/** The engine's `where` ("body 'beam'", "size.0") pointed at one field of this form. */
export function errorFor(err: LastError | null, path: string[]): string | null {
  if (!err?.where) return null;
  const key = path.join('.');
  const leaf = path[path.length - 1]!;
  return err.where === key || err.where.startsWith(`${key}.`) || err.where.includes(`'${leaf}'`) || err.where === leaf ? err.cause : null;
}

function Row({ field, children, error }: { field: Field; children: preact.ComponentChildren; error: string | null }) {
  return (
    <div class="field" data-field={field.path.join('.')}>
      <div class="field-head">
        <span class="field-label">
          {field.label}
          {field.required ? '' : ' (optional)'}
        </span>
        <span class="mono field-dim">{field.tag}</span>
      </div>
      {children}
      {error ? (
        <div class="surface error">
          <span>✕</span>
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}

/** The design's quantity field: value with unit, − / + steppers, and the SI echo underneath. */
function Quantity({ value, dimension, onChange, query, keyField, placeholder, hint }: { value: unknown; dimension: string; onChange(v: unknown): void; query: Query; keyField: boolean; placeholder?: string; hint?: string }) {
  const [echo, setEcho] = useState<{ text: string; bad: boolean }>({ text: '', bad: false });
  const parsed = parseQuantity(value);
  const text = typeof value === 'string' || value === undefined || value === null ? String(value ?? '') : parsed ? `${parsed.value} ${parsed.unit}` : JSON.stringify(value);
  useEffect(() => {
    let live = true;
    if (parseQuantity(text) === null) {
      setEcho({ text: text === '' ? '' : 'not a number with a unit', bad: text !== '' });
      return;
    }
    void query({ query: 'query.convert', quantity: text, to: siUnit(dimension) })
      .then((c) => live && setEcho({ text: `= ${(c as { value: number }).value.toPrecision(4)} ${(c as { unit: string }).unit}`, bad: false }))
      .catch((e: { cause?: string }) => live && setEcho({ text: e.cause ?? 'unknown unit', bad: true }));
    return () => {
      live = false;
    };
  }, [text, dimension, query]);
  return (
    <>
      <div class={keyField ? 'qty key' : 'qty'}>
        <input class="mono" value={text} data-cmd="form.open" data-hint={hint} placeholder={hint ?? placeholder} onInput={(e) => onChange((e.target as HTMLInputElement).value)} />
        <button type="button" data-cmd="form.open" title="−10 %" onClick={() => onChange(step(text, -1))}>
          −
        </button>
        <button type="button" data-cmd="form.open" title="+10 %" onClick={() => onChange(step(text, 1))}>
          +
        </button>
      </div>
      <div class={echo.bad ? 'mono echo bad' : 'mono echo'}>{echo.text}</div>
    </>
  );
}

/** Chips for the Sets, Bodies or Steps a Command points at, with the design's "pick in viewer". */
function Picker({ field, value, candidates, onChange, command, dispatch, armed }: { field: Field & { kind: 'ref' }; value: unknown; candidates: { name: string; summary: string }[]; onChange(v: unknown): void; command: string; dispatch: Dispatch; armed: boolean }) {
  const chosen = field.multi ? asList(value) : asList(value).slice(0, 1);
  const add = (name: string) => onChange(field.multi ? [...new Set([...chosen, name])] : name);
  const drop = (name: string) => onChange(field.multi ? chosen.filter((c) => c !== name) : undefined);
  return (
    <>
      <div class="chips">
        {chosen.map((name) => (
          <span key={name} class="chip-set mono">
            {name}
            <button type="button" data-cmd="form.open" title="remove" onClick={() => drop(name)}>
              ×
            </button>
          </span>
        ))}
        {field.refKind === 'set' ? (
          <Cmd
            dispatch={dispatch}
            cmd="form.pick"
            class={armed ? 'chip-pick armed' : 'chip-pick'}
            args={{ command, field: field.path }}
            title="pick in viewer"
          >
            {armed ? 'click a face…' : 'pick in viewer'}
          </Cmd>
        ) : null}
      </div>
      {candidates.length > 0 ? (
        <div class="chips candidates">
          {candidates
            .filter((c) => !chosen.includes(c.name))
            .slice(0, 24)
            .map((c) => (
              <button key={c.name} type="button" class="chip-cand mono" data-cmd="form.open" title={c.summary} onClick={() => add(c.name)}>
                {c.name}
              </button>
            ))}
        </div>
      ) : null}
      <div class="rule-note">Stored as a rule on the Set's name, not as element ids, so it survives remeshing.</div>
    </>
  );
}

function Segmented({ options, active, onPick }: { options: string[]; active: (o: string) => boolean; onPick(o: string): void }) {
  return (
    <div class="segmented wide" role="group">
      {options.map((o) => (
        <button key={o} type="button" data-cmd="form.open" aria-pressed={active(o)} onClick={() => onPick(o)}>
          {o}
        </button>
      ))}
    </div>
  );
}

function FieldView(props: FieldProps) {
  const { field, fields, values, s, dispatch, query, defs, variants } = props;
  const set = editor(s, dispatch, values, fields);
  const value = getAt(values, field.path);
  const error = errorFor(s.formError, field.path);
  const onChange = (v: unknown) => set(field.path, v);

  if (field.kind === 'quantity') {
    const parts = field.parts;
    const list = Array.isArray(value) ? (value as unknown[]) : [];
    // The issue's "the placeholder should show the units": the Model's own length unit, or the
    // dimension's SI one, so an empty box says what a number in it has to carry.
    const placeholder = `0 ${field.dimension === 'length' ? (s.model?.units.length ?? 'm') : siUnit(field.dimension)}`.trim();
    return (
      <Row field={field} error={error}>
        {parts === 1 ? (
          <Quantity value={value} dimension={field.dimension} onChange={onChange} query={query} keyField={field.required} placeholder={placeholder} hint={hintFor(s, field.path)} />
        ) : (
          Array.from({ length: parts }, (_, i) => (
            <Quantity
              key={i}
              value={list[i]}
              dimension={field.dimension}
              query={query}
              keyField={field.required}
              placeholder={placeholder}
              hint={hintFor(s, [...field.path, String(i)])}
              onChange={(v) => onChange(Array.from({ length: parts }, (_, j) => (j === i ? v : (list[j] ?? ''))))}
            />
          ))
        )}
        {s.form?.cmd === 'load.pressure' && field.path.join('.') === 'value' ? (
          <PressurePreview pressure={value} on={values['on']} context={`${s.model?.hash}:${s.revision}`} forceUnit={s.model?.units.force ?? 'N'} lengthUnit={s.model?.units.length ?? 'm'} idealisation={s.model?.idealisation ?? 'solid3d'} query={query} />
        ) : null}
      </Row>
    );
  }
  if (field.kind === 'sketch') {
    return (
      <Row field={field} error={error}>
        <SketchEditor value={value} unit={s.model?.units.length ?? 'm'} onChange={onChange} dispatch={dispatch} />
      </Row>
    );
  }
  if (field.kind === 'enum') {
    const many = asList(value);
    return (
      <Row field={field} error={error}>
        <Segmented
          options={field.options}
          active={(o) => (field.multi ? many.includes(o) : value === o)}
          onPick={(o) => onChange(field.multi ? (many.includes(o) ? many.filter((m) => m !== o) : [...many, o]) : o)}
        />
      </Row>
    );
  }
  if (field.kind === 'boolean') {
    return (
      <Row field={field} error={error}>
        <Segmented options={['yes', 'no']} active={(o) => (o === 'yes') === (value === true)} onPick={(o) => onChange(o === 'yes')} />
      </Row>
    );
  }
  if (field.kind === 'ref') {
    const sets = [...(s.model?.bodies ?? []).flatMap((b) => b.faces.map((f) => ({ name: f, summary: `auto face of ${b.name}` }))), ...s.objects.filter((o) => o.kind === 'set').map((o) => ({ name: o.name, summary: o.summary }))];
    const byKind: Record<string, { name: string; summary: string }[]> = {
      set: sets,
      body: (s.model?.bodies ?? []).map((b) => ({ name: b.name, summary: `${b.measure.value.toPrecision(3)} ${b.measure.unit}` })),
      material: (s.model?.materials ?? []).map((m) => { const e = m.E ?? m.orthotropic?.E1; return { name: m.name, summary: e ? `E ${e.value} ${e.unit}` : 'no stiffness' }; }),
      constraint: (s.model?.constraints ?? []).map((c) => ({ name: c.name, summary: c.summary })),
      load: (s.model?.loads ?? []).map((l) => ({ name: l.name, summary: l.summary })),
      step: (s.model?.steps ?? []).map((st) => ({ name: st.name, summary: st.procedure })),
      any: [],
    };
    return (
      <Row field={field} error={error}>
        <Picker field={field} value={value} candidates={byKind[field.refKind] ?? []} onChange={onChange} command={s.form!.cmd} dispatch={dispatch} armed={s.pickInto?.join('.') === field.path.join('.')} />
      </Row>
    );
  }
  if (field.kind === 'union') {
    const kind = (getAt(values, [...field.path, 'kind']) as string | undefined) ?? field.variants[0]?.kind;
    const chosen = field.variants.find((v) => v.kind === kind);
    return (
      <Row field={field} error={error}>
        <Segmented options={field.variants.map((v) => v.kind)} active={(o) => o === kind} onPick={(o) => set([...field.path, 'kind'], o)} />
        <div class="sub">
          {(chosen?.fields ?? []).map((f) => (
            <FieldView key={f.path.join('.')} {...props} field={f} />
          ))}
        </div>
      </Row>
    );
  }
  if (field.kind === 'object') {
    return (
      <Row field={field} error={error}>
        <div class="sub">
          {field.fields.map((f) => (
            <FieldView key={f.path.join('.')} {...props} field={f} />
          ))}
        </div>
      </Row>
    );
  }
  if (field.kind === 'number') {
    const mesher = getAt(values, ['mesher', 'kind']);
    // Only describe elements that this engine can actually produce. Order defaults to one.
    const linear = value === undefined || value === null || value === 1;
    const bendingWarning = s.form?.cmd === 'mesh.set' && field.path.join('.') === 'order' && linear
      ? values['simplices'] === true || mesher === 'tet'
        ? 'Linear tetrahedra and triangles have constant strain and can be too stiff in bending. Use quadratic elements and check mesh convergence.'
        : mesher === 'free'
        ? 'Linear triangles have constant strain and can be too stiff in bending. Use quadratic elements and check mesh convergence.'
        : ['lattice', 'mapped', 'sweep'].includes(String(mesher)) && values['formulation'] === 'full'
          ? 'Fully integrated linear quadrilaterals and hexahedra can lock in bending. Use quadratic elements and check mesh convergence.'
          : null
      : null;
    return (
      <Row field={field} error={error}>
        <input class="mono input" type="number" data-cmd="form.open" data-hint={hintFor(s, field.path)} placeholder={hintFor(s, field.path)} value={value === undefined ? '' : String(value)} onInput={(e) => onChange((e.target as HTMLInputElement).value === '' ? undefined : Number((e.target as HTMLInputElement).value))} />
        {bendingWarning ? (
          <div class="surface warn" role="status">
            <span aria-hidden="true">△</span>
            <span>
              {bendingWarning}{' '}
              <Cmd dispatch={dispatch} cmd="form.open" class="link" args={{ command: 'mesh.set', args: { ...values, order: 2 }, keepInitial: true }}>
                Switch to quadratic
              </Cmd>
            </span>
          </div>
        ) : null}
      </Row>
    );
  }
  if (field.kind === 'json') {
    return (
      <Row field={field} error={error}>
        <textarea
          class="mono input json"
          data-cmd="form.open"
          value={value === undefined ? '' : JSON.stringify(value)}
          onInput={(e) => {
            const raw = (e.target as HTMLTextAreaElement).value;
            try {
              onChange(raw === '' ? undefined : (JSON.parse(raw) as unknown));
            } catch {
              /* keep the last valid value while the person is mid-edit */
            }
          }}
        />
      </Row>
    );
  }
  void defs;
  void variants;
  return (
    <Row field={field} error={error}>
      <input class="mono input" data-cmd="form.open" data-hint={hintFor(s, field.path)} placeholder={hintFor(s, field.path)} value={value === undefined ? '' : String(value)} onInput={(e) => onChange((e.target as HTMLInputElement).value)} />
    </Row>
  );
}

/** The whole panel: header, name, hint, fields, "will be recorded as", Apply and Revert. */
export function SchemaForm(props: FormProps) {
  const { s, store, dispatch, variants, defs } = props;
  const form = s.form;
  const variant = form ? variants.get(form.cmd) : undefined;
  if (!form || !variant) {
    return (
      <aside class="panel props">
        <div class="panel-head">
          <span class="section-label">Properties</span>
        </div>
        <div class="empty-note">Select something in the tree, or press ⌘K and pick a Command to fill in.</div>
      </aside>
    );
  }
  const fields = fieldsOf(variant, defs);
  const values = defaultFormValues(form.values, fields);
  const cmd = { cmd: form.cmd, ...values };
  const name = String(values['name'] ?? '—');
  const label = applyLabel(form.cmd);
  const missing = missingRequired(fields, values);
  const apply = (): void => {
    // The panel is a real `<form>`, so ↵ in any field lands here whatever the button says: the
    // rule lives in `apply`, and `disabled` below is only its visible half (issue #43).
    if (missing.length > 0) return store.set({ formError: { code: 'incomplete', cause: `fill in ${missing.join(', ')}`, where: null, suggestion: null } });
    store.set({ formError: null });
    void dispatch(cmd as { cmd: string }).catch(() => store.set({ formError: store.state.lastError }));
  };
  return (
    <aside class="panel props">
      <div class="panel-head">
        <span class="section-label">Properties</span>
        <span class="mono panel-sub">{form.cmd}</span>
      </div>
      {/* A real form, so ↵ in any field is Apply — the design's "one Apply = one Command". */}
      <form class="props-body" onSubmit={(e) => (e.preventDefault(), apply())}>
        <div class="prop-name">
          <span class="mono">{name}</span>
          <Cmd dispatch={dispatch} cmd="clipboard.copy" class="link" args={{ what: { kind: 'mention', ref: `${form.cmd.split('.')[0]}:${name}` } }}>
            @ reference in chat
          </Cmd>
        </div>
        <div class="prop-hint">{String(variant['description'] ?? '').split('\n').join(' ')}</div>
        {fields.map((f) => (
          <FieldView key={f.path.join('.')} {...props} field={f} values={values} fields={fields} />
        ))}
        {s.formError && !fields.some((f) => errorFor(s.formError, f.path)) ? (
          <div class="surface error">
            <span>✕</span>
            <span>
              {s.formError.code}: {s.formError.cause}
              {s.formError.suggestion ? ` — ${s.formError.suggestion}` : ''}
            </span>
          </div>
        ) : null}
        <div class="recorded">
          <div class="section-label">Will be recorded as</div>
          <div class="mono recorded-cmd">{commandLine(cmd)}</div>
          <div class="apply-row">
            <Cmd
              dispatch={dispatch}
              cmd={form.cmd}
              class="apply"
              args={values}
              disabled={missing.length > 0}
              title={missing.length > 0 ? `fill in ${missing.join(', ')}` : form.cmd}
              onRun={apply}
            >
              {label}
            </Cmd>
            <Cmd dispatch={dispatch} cmd="form.open" class="tbutton outline" args={{ command: form.cmd, args: form.initial }} title="Revert to the values this form opened with">
              Revert
            </Cmd>
          </div>
        </div>
      </form>
    </aside>
  );
}
