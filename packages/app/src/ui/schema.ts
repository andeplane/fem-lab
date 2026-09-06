// The Properties panel is generated from `engine.schema.json`, so this file is the reading of
// that schema: one Command variant in, a list of typed fields out (design §Properties, brief
// §5.3). Everything here is pure so `test/schema.test.ts` can walk every Command in the schema.
import type { JsonSchema } from '@femlab/registry';

export type Defs = Record<string, unknown>;

/** SI exponents [L, M, T, Θ] per `x-dimension`, from `crates/engine/src/units.rs`'s `dims!`. */
const DIMENSIONS: Record<string, { si: string; exp: [number, number, number, number] }> = {
  length: { si: 'm', exp: [1, 0, 0, 0] },
  mass: { si: 'kg', exp: [0, 1, 0, 0] },
  time: { si: 's', exp: [0, 0, 1, 0] },
  temperature: { si: 'K', exp: [0, 0, 0, 1] },
  force: { si: 'N', exp: [1, 1, -2, 0] },
  stress: { si: 'Pa', exp: [-1, 1, -2, 0] },
  density: { si: 'kg/m^3', exp: [-3, 1, 0, 0] },
  acceleration: { si: 'm/s^2', exp: [1, 0, -2, 0] },
  thermal_expansion: { si: '1/K', exp: [0, 0, 0, -1] },
  conductivity: { si: 'W/(m K)', exp: [1, 1, -3, -1] },
  specific_heat: { si: 'J/(kg K)', exp: [2, 0, -2, -1] },
  heat_transfer_coefficient: { si: 'W/(m^2 K)', exp: [0, 1, -3, -1] },
  heat_flux: { si: 'W/m^2', exp: [0, 1, -3, 0] },
  heat_source: { si: 'W/m^3', exp: [-1, 1, -3, 0] },
  frequency: { si: 'Hz', exp: [0, 0, -1, 0] },
  dimensionless: { si: '', exp: [0, 0, 0, 0] },
};

const SUPER = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];
const sup = (n: number): string => (n === 1 ? '' : (n < 0 ? '⁻' : '') + String(Math.abs(n)).split('').map((d) => SUPER[Number(d)]).join(''));

/** The design's right-aligned dimension tag: `stress · M L⁻¹ T⁻²`. */
export function dimensionTag(dimension: string): string {
  const d = DIMENSIONS[dimension];
  if (!d) return dimension;
  const parts = (['L', 'M', 'T', 'Θ'] as const).map((s, i) => (d.exp[i] === 0 ? '' : `${s}${sup(d.exp[i]!)}`)).filter(Boolean);
  // M first reads as mass·length·time, which is how the brief writes it.
  const order = [parts.find((p) => p.startsWith('M')), parts.find((p) => p.startsWith('L')), parts.find((p) => p.startsWith('T')), parts.find((p) => p.startsWith('Θ'))].filter(Boolean);
  return order.length === 0 ? `${dimension} · 1` : `${dimension} · ${order.join(' ')}`;
}

/** The SI unit `query.convert` normalises a dimension to, for the echo under a quantity field. */
export function siUnit(dimension: string): string {
  return DIMENSIONS[dimension]?.si ?? '';
}

/** Follow `$ref` chains, keeping the siblings the referring node added (`x-dimension`, docs). */
export function resolve(node: JsonSchema, defs: Defs): JsonSchema {
  let out = node;
  const seen = new Set<string>();
  while (typeof out['$ref'] === 'string') {
    const ref = out['$ref'];
    if (seen.has(ref)) return out;
    seen.add(ref);
    const { $ref: _drop, ...rest } = out;
    out = { ...(defs[ref.slice('#/$defs/'.length)] as JsonSchema), ...rest };
  }
  return out;
}

/**
 * `anyOf: [X, { type: 'null' }]` and `type: ['array', 'null']` mean "optional X". Where a real
 * choice remains (`LatticeSize` is a length *or* three counts, `Quantity` is text *or* parts)
 * the form offers the first branch, which is the one the doc string's example uses; the other
 * is still reachable from a script. `description` and `x-dimension` ride along, because the
 * dimension is what makes the branch a quantity field rather than a text box.
 */
function denull(node: JsonSchema, defs: Defs): JsonSchema {
  const any = node['anyOf'] as JsonSchema[] | undefined;
  if (any) {
    const live = any.filter((b) => b['type'] !== 'null');
    const keep = {
      ...(node['description'] === undefined ? {} : { description: node['description'] }),
      ...(node['x-dimension'] === undefined ? {} : { 'x-dimension': node['x-dimension'] }),
    };
    if (live[0]) return resolve({ ...live[0], ...keep }, defs);
  }
  const type = node['type'];
  if (Array.isArray(type)) return { ...node, type: type.filter((t) => t !== 'null')[0] };
  return node;
}

export interface FieldBase {
  /** Where the value lives in the Command object, e.g. `['mesher', 'size']`. */
  path: string[];
  label: string;
  hint: string;
  required: boolean;
  /** The right-aligned tag the design puts opposite the label. */
  tag: string;
}
export type Field = FieldBase &
  (
    | { kind: 'quantity'; dimension: string; parts: number }
    | { kind: 'text' }
    | { kind: 'number'; integer: boolean }
    | { kind: 'boolean' }
    | { kind: 'enum'; options: string[]; multi: boolean }
    | { kind: 'ref'; refKind: string; multi: boolean }
    | { kind: 'union'; variants: { kind: string; fields: Field[] }[] }
    | { kind: 'object'; fields: Field[] }
    | { kind: 'json' }
  );

/**
 * Property names that name another object in the Model, so the form draws chips and a
 * "pick in viewer" button rather than a bare text box. The schema types them all as `string`,
 * which is what the engine wants on the wire; the kind is UI knowledge, so it lives here.
 */
const REFS: Record<string, string> = {
  on: 'set',
  of: 'body',
  from: 'body',
  bodies: 'body',
  material: 'material',
  constraints: 'constraint',
  loads: 'load',
  step: 'step',
  order: 'step',
};

/** `maxIterations` → `Max iterations`; `nu` and `E` are left as the physicist wrote them. */
export function humanise(name: string): string {
  if (name.length <= 2) return name;
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, (_, a: string, b: string) => `${a} ${b.toLowerCase()}`).replace(/_/g, ' ');
  return spaced[0]!.toUpperCase() + spaced.slice(1);
}

const enumOf = (node: JsonSchema): string[] | null => {
  if (Array.isArray(node['enum'])) return node['enum'] as string[];
  const one = node['oneOf'] as JsonSchema[] | undefined;
  if (one && one.every((v) => typeof v['const'] === 'string')) return one.map((v) => v['const'] as string);
  return null;
};

/** Every `oneOf` branch is an object with a `kind: { const }`: a tagged union (ShapeSpec, …). */
const taggedOf = (node: JsonSchema): JsonSchema[] | null => {
  const one = node['oneOf'] as JsonSchema[] | undefined;
  const tagged = one?.every((v) => typeof ((v['properties'] as Record<string, JsonSchema> | undefined)?.['kind']?.['const']) === 'string');
  return one && tagged ? one : null;
};

function field(name: string, raw: JsonSchema, defs: Defs, required: boolean, path: string[], depth: number): Field {
  const node = denull(resolve(raw, defs), defs);
  const base: FieldBase = { path, label: humanise(name), hint: String(node['description'] ?? '').split('\n').join(' '), required, tag: '' };
  const dimension = node['x-dimension'] as string | undefined;
  if (dimension) return { ...base, tag: dimensionTag(dimension), kind: 'quantity', dimension, parts: 1 };

  if (node['type'] === 'array') {
    const items = denull(resolve((node['items'] ?? {}) as JsonSchema, defs), defs);
    const dim = items['x-dimension'] as string | undefined;
    if (dim) {
      const parts = (node['maxItems'] as number | undefined) ?? 3;
      return { ...base, tag: `${dimensionTag(dim)}${parts > 1 ? ` · ${parts}` : ''}`, kind: 'quantity', dimension: dim, parts };
    }
    const options = enumOf(items);
    if (options) return { ...base, tag: 'enum · many', kind: 'enum', options, multi: true };
    if (REFS[name]) return { ...base, tag: `${REFS[name]} · many`, kind: 'ref', refKind: REFS[name]!, multi: true };
    if (items['type'] === 'string') return { ...base, tag: 'text · many', kind: 'ref', refKind: 'any', multi: true };
    return { ...base, tag: 'json', kind: 'json' };
  }

  const options = enumOf(node);
  if (options) return { ...base, tag: 'enum', kind: 'enum', options, multi: false };

  const tagged = taggedOf(node);
  if (tagged && depth > 0) {
    return {
      ...base,
      tag: 'kind',
      kind: 'union',
      variants: tagged.map((v) => ({
        kind: (v['properties'] as Record<string, JsonSchema>)['kind']!['const'] as string,
        fields: propertyFields(v, defs, [...path], depth - 1),
      })),
    };
  }
  if (node['type'] === 'object' && node['properties'] && depth > 0) {
    return { ...base, tag: 'group', kind: 'object', fields: propertyFields(node, defs, path, depth - 1) };
  }
  if (node['type'] === 'boolean') return { ...base, tag: 'yes / no', kind: 'boolean' };
  if (node['type'] === 'number' || node['type'] === 'integer') return { ...base, tag: node['type'] === 'integer' ? 'integer' : 'number', kind: 'number', integer: node['type'] === 'integer' };
  if (node['type'] === 'string') {
    if (REFS[name]) return { ...base, tag: REFS[name]!, kind: 'ref', refKind: REFS[name]!, multi: false };
    return { ...base, tag: 'text', kind: 'text' };
  }
  return { ...base, tag: 'json', kind: 'json' };
}

/** Hide constant discriminators, preserving ordinary fields such as ObjectKind. */
function propertyFields(node: JsonSchema, defs: Defs, path: string[], depth: number): Field[] {
  const props = (node['properties'] ?? {}) as Record<string, JsonSchema>;
  const required = new Set((node['required'] as string[] | undefined) ?? []);
  return Object.entries(props)
    .filter(([name, prop]) => !(['cmd', 'query', 'kind'].includes(name) && resolve(prop, defs)['const'] !== undefined))
    .map(([name, prop]) => field(name, prop, defs, required.has(name), [...path, name], depth));
}

/** The form for one Command variant: its properties, in schema order, minus the discriminator. */
export function fieldsOf(variant: JsonSchema, defs: Defs, depth = 2): Field[] {
  return propertyFields(variant, defs, [], depth);
}

/** The design's rule that the primary button says what it will do, not "Apply". */
const APPLY: Record<string, string> = {
  'model.new': 'New model',
  'model.setUnits': 'Set units',
  'model.setIdealisation': 'Set idealisation',
  'geometry.addBox': 'Add body',
  'geometry.add': 'Add body',
  'geometry.subtractBox': 'Cut body',
  'geometry.subtract': 'Cut body',
  'geometry.nameFace': 'Name faces',
  'geometry.nameRegion': 'Name region',
  'material.add': 'Add material',
  'material.assign': 'Assign material',
  'mesh.set': 'Mesh',
  'constraint.fix': 'Add constraint',
  'constraint.prescribe': 'Add constraint',
  'constraint.symmetry': 'Add constraint',
  'step.add': 'Add step',
  'solve.run': 'Solve',
};

export function applyLabel(cmd: string): string {
  if (APPLY[cmd]) return APPLY[cmd];
  const verb = cmd.split('.')[1] ?? 'apply';
  if (cmd.startsWith('load.') && verb !== 'remove') return 'Add load';
  return humanise(verb);
}

export const getAt = (obj: unknown, path: string[]): unknown => path.reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);

/**
 * Materialise the first variant of a tagged union when the schema requires the union, or when
 * an optional union is already present. The form draws that first variant as selected, so the
 * values it previews and dispatches must carry the same discriminator. An untouched optional
 * union stays absent. Required multi-pickers start as empty lists, matching their empty UI.
 */
export function defaultFormValues(values: Record<string, unknown>, fields: Field[]): Record<string, unknown> {
  let out = values;
  for (const field of fields) {
    const value = getAt(out, field.path);
    const present = value !== undefined && value !== null;
    if (!present && field.required && (field.kind === 'ref' || field.kind === 'enum') && field.multi) {
      out = setAt(out, field.path, []);
    } else if (field.kind === 'union') {
      if (!present && !field.required) continue;
      if (present && (typeof value !== 'object' || Array.isArray(value))) continue;
      let kind = getAt(out, [...field.path, 'kind']);
      if (kind === undefined && field.variants[0]) {
        kind = field.variants[0].kind;
        out = setAt(out, [...field.path, 'kind'], kind);
      }
      const chosen = field.variants.find((variant) => variant.kind === kind);
      if (chosen) out = defaultFormValues(out, chosen.fields);
    } else if (field.kind === 'object' && (present || field.required)) {
      out = defaultFormValues(out, field.fields);
    }
  }
  return out;
}

/** Immutable set-by-path; empty collections are values, while empty text/undefined clears a key. */
export function setAt(obj: Record<string, unknown>, path: string[], value: unknown): Record<string, unknown> {
  const [head, ...rest] = path;
  if (head === undefined) return obj;
  const out = { ...obj };
  if (rest.length > 0) {
    out[head] = setAt((out[head] ?? {}) as Record<string, unknown>, rest, value);
    return out;
  }
  if (value === undefined || value === '') delete out[head];
  else out[head] = value;
  return out;
}

/** `"2.4 MPa"` → `{ value: 2.4, unit: 'MPa' }`; `{ value, unit }` passes through. */
export function parseQuantity(q: unknown): { value: number; unit: string } | null {
  if (q && typeof q === 'object' && 'value' in q) {
    const o = q as { value: unknown; unit?: unknown };
    return typeof o.value === 'number' ? { value: o.value, unit: String(o.unit ?? '') } : null;
  }
  const m = /^\s*(-?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*(.*?)\s*$/.exec(String(q ?? ''));
  return m ? { value: Number(m[1]), unit: m[2]! } : null;
}

/** The −/+ steppers: 10 % of the value, rounded so the text stays readable. */
export function step(text: unknown, direction: 1 | -1): string {
  const q = parseQuantity(text);
  if (!q) return String(text ?? '');
  const delta = (Math.abs(q.value) || 1) * 0.1 * direction;
  const next = Number((q.value + delta).toPrecision(6));
  return q.unit ? `${next} ${q.unit}` : String(next);
}

const isIdentifier = (k: string): boolean => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k);

/** JSON as a TypeScript object literal, byte-identical to `crates/engine/src/journal.rs::ts_value`. */
export function tsValue(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(tsValue).join(', ')}]`;
  if (v && typeof v === 'object') {
    const parts = Object.entries(v as Record<string, unknown>).map(([k, val]) => `${isIdentifier(k) ? k : JSON.stringify(k)}: ${tsValue(val)}`);
    return `{ ${parts.join(', ')} }`;
  }
  return JSON.stringify(v) ?? '';
}

/** `await fem.geometry.addBox({ name: "beam" });` — what the Journal will show, before Apply. */
export function commandLine(cmd: Record<string, unknown>): string {
  const { cmd: name, ...args } = cmd;
  const [ns = '?', verb = ''] = String(name ?? '?').split('.');
  return `await fem.${ns}.${verb}(${Object.keys(args).length === 0 ? '' : tsValue(args)});`;
}

/**
 * The engine's warning codes are names (`model.no-material`); the design's banner speaks in
 * W-codes with a plain-language cause and one mono fix Command. This is that table: code, the
 * sentence, and the Command the fix link fills the Properties form with.
 */
export interface Blocker {
  code: string;
  text: string;
  fixLabel: string;
  fixCmd: string;
  where: string | null;
}

const WCODES: Record<string, { code: string; text: string; fix: string }> = {
  'model.empty': { code: 'W-1000', text: 'Nothing to analyse yet. Add the first body.', fix: 'geometry.addBox' },
  'model.ill-posed': { code: 'W-1002', text: 'A Body and the idealisation disagree on dimension.', fix: 'model.setIdealisation' },
  'model.no-material': { code: 'W-1101', text: 'A Body has no material — nothing carries stiffness.', fix: 'material.assign' },
  'model.unconstrained': { code: 'W-1300', text: 'Nothing holds the body — six rigid body modes.', fix: 'constraint.fix' },
  'model.unloaded': { code: 'W-1400', text: 'No load. A solve would return zeros.', fix: 'load.pressure' },
  'model.no-step': { code: 'W-1500', text: 'No Step. A Step says what to solve.', fix: 'step.add' },
  'load.no-density': { code: 'W-2210', text: 'Gravity skips a body whose material has no density.', fix: 'material.add' },
};
const MESH: Blocker = { code: 'W-1200', text: 'No mesh. Pick a size and element; counts and cost show before you solve.', fixLabel: 'mesh.set', fixCmd: 'mesh.set', where: null };

/**
 * Engine warnings → the design's blockers, in W-code order so the banner always names the next
 * missing thing. An engine warning with no mapping keeps its own code rather than disappearing.
 */
export function blockers(warnings: { code: string; text: string; where?: string | null }[], hasMesh: boolean, hasBodies: boolean): Blocker[] {
  const mapped = warnings.map((w) => {
    const m = WCODES[w.code];
    return m
      ? { code: m.code, text: m.text, fixLabel: m.fix, fixCmd: m.fix, where: w.where ?? null }
      : { code: w.code, text: w.text, fixLabel: '', fixCmd: '', where: w.where ?? null };
  });
  if (hasBodies && !hasMesh) mapped.push(MESH);
  return mapped.sort((a, b) => a.code.localeCompare(b.code));
}
