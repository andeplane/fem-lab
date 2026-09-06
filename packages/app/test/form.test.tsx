// The Properties form against the real schema and a fake registry: what a field edit dispatches,
// what the SI echo says, where a structured error lands, and that "will be recorded as" is
// literally the Command Apply sends — the design's promise that you see it before it happens.
import type { EngineSchema, JsonSchema, ModelSummary } from '@femlab/registry';
import { render } from 'preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from './wait-for';
import schema from '../../registry/src/generated/engine.schema.json';
import { Store } from '../src/store';
import { SchemaForm, errorFor } from '../src/ui/SchemaForm';
import { commandLine, type Defs } from '../src/ui/schema';

const doc = schema as unknown as EngineSchema;
const DEFS: Defs = { ...doc.commands.$defs, ...doc.queries.$defs };
const VARIANTS = new Map<string, JsonSchema>(doc.commands.oneOf.map((v) => [v.properties['cmd']!.const!, v as unknown as JsonSchema]));

const model = (): ModelSummary =>
  ({
    name: 'demo',
    revision: 2,
    hash: 'h',
    units: { length: 'mm', force: 'N', stress: 'MPa' },
    idealisation: 'solid3d',
    bodies: [{ name: 'beam', material: null, bbox: [], measure: { value: 0.01, unit: 'm^3' }, faces: ['beam.xmin', 'beam.xmax'] }],
    materials: [],
    sets: [],
    constraints: [],
    loads: [],
    steps: [],
    meshSettings: null,
    warnings: [],
  }) as unknown as ModelSummary;

/** A dispatch that behaves like the app's: `form.open` really re-opens the form. */
function mount(cmd: string, values: Record<string, unknown> = {}) {
  const store = new Store();
  store.set({ model: model(), ready: true });
  store.openForm(cmd, values);
  const sent: { cmd: string }[] = [];
  const dispatch = vi.fn(async (c: { cmd: string } & Record<string, unknown>) => {
    sent.push(c);
    if (c.cmd === 'form.open') store.openForm(c['command'] as string, (c['args'] as Record<string, unknown>) ?? {}, c['keepInitial'] === true);
    return undefined;
  });
  const query = vi.fn(async (q: { query: string } & Record<string, unknown>) => {
    expect(q.query).toBe('query.convert');
    return { value: 2_400_000, unit: 'Pa' };
  });
  const root = document.createElement('div');
  document.body.append(root);
  const draw = () => render(<SchemaForm s={store.state} store={store} dispatch={dispatch} query={query} defs={DEFS} variants={VARIANTS} />, root);
  store.subscribe(draw);
  draw();
  return { root, store, sent, dispatch, query };
}

const field = (root: HTMLElement, path: string) => root.querySelector<HTMLElement>(`[data-field="${path}"]`)!;
const type = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
/** Preact defers `useEffect` past paint, so the quantity echo arrives on its own clock. */
const echoOf = (root: HTMLElement, path: string, cls = '.echo') => waitFor(() => field(root, path).querySelector(cls)?.textContent || null, `the ${path} echo`);

describe('SchemaForm', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders every Command in the schema without throwing', () => {
    for (const name of VARIANTS.keys()) {
      document.body.innerHTML = '';
      const { root } = mount(name);
      expect(root.querySelector('.panel-sub')!.textContent, name).toBe(name);
      expect(root.querySelectorAll('.field').length, name).toBeGreaterThan(0);
    }
  });

  it('says nothing is chosen when no Command is open', () => {
    const store = new Store();
    const root = document.createElement('div');
    render(<SchemaForm s={store.state} store={store} dispatch={async () => undefined} query={async () => ({})} defs={DEFS} variants={VARIANTS} />, root);
    expect(root.textContent).toContain('⌘K');
    // An unknown Command falls into the same empty state rather than crashing.
    store.openForm('nope.nope');
    render(<SchemaForm s={store.state} store={store} dispatch={async () => undefined} query={async () => ({})} defs={DEFS} variants={VARIANTS} />, root);
    expect(root.textContent).toContain('⌘K');
  });

  it('sends every field edit as one form.open Command, so the AI can fill the form too', () => {
    const { root, sent, store } = mount('load.pressure');
    type(field(root, 'name').querySelector('input')!, 'bearing');
    expect(sent.at(-1)).toEqual({ cmd: 'form.open', command: 'load.pressure', args: { name: 'bearing' }, keepInitial: true });
    expect(store.state.form!.values).toEqual({ name: 'bearing' });
    expect([...root.querySelectorAll('[data-cmd]')].every((el) => el.getAttribute('data-cmd'))).toBe(true);
  });

  it('echoes the normalised SI value under a quantity field, and steps it by ten per cent', async () => {
    const { root, query, sent } = mount('load.pressure', { name: 'p', value: '2.4 MPa' });
    expect(await echoOf(root, 'value')).toContain('2.400e+6 Pa');
    expect(query).toHaveBeenCalledWith({ query: 'query.convert', quantity: '2.4 MPa', to: 'Pa' });
    field(root, 'value').querySelector<HTMLButtonElement>('button[title="+10 %"]')!.click();
    expect((sent.at(-1) as unknown as { args: { value: string } }).args.value).toBe('2.64 MPa');
  });

  it('flags a quantity that is not a number with a unit before the engine ever sees it', async () => {
    const { root } = mount('load.pressure', { value: 'banana' });
    expect(await echoOf(root, 'value', '.echo.bad')).toContain('not a number with a unit');
  });

  it('puts the engine\'s structured error under the field its `where` names', () => {
    const { root, store } = mount('load.pressure', { name: 'p', on: 'beam.top', value: '2 MPa' });
    store.set({ formError: { code: 'not-found', cause: "no Set named 'beam.top'", where: "set 'on'", suggestion: 'pick a face' } });
    expect(field(root, 'on').querySelector('.surface.error')!.textContent).toContain("no Set named 'beam.top'");
    expect(field(root, 'value').querySelector('.surface.error')).toBeNull();
  });

  it('shows an error the fields cannot claim as a panel-level surface', () => {
    const { root, store } = mount('load.pressure');
    store.set({ formError: { code: 'internal', cause: 'the engine fell over', where: null, suggestion: 'reload' } });
    expect(root.querySelector('.props-body > .surface.error')!.textContent).toContain('the engine fell over');
  });

  it('maps a `where` onto a field only when it really names it', () => {
    expect(errorFor(null, ['on'])).toBeNull();
    expect(errorFor({ code: 'x', cause: 'c', where: null, suggestion: null }, ['on'])).toBeNull();
    expect(errorFor({ code: 'x', cause: 'c', where: 'mesher.size', suggestion: null }, ['mesher'])).toBe('c');
    expect(errorFor({ code: 'x', cause: 'c', where: 'name', suggestion: null }, ['on'])).toBeNull();
  });

  it('shows the Command it is about to dispatch, and dispatches exactly that', () => {
    const { root, sent } = mount('geometry.addBox', { name: 'beam', size: ['1 m', '100 mm', '100 mm'] });
    const recorded = root.querySelector('.recorded-cmd')!.textContent!;
    expect(recorded).toBe('await fem.geometry.addBox({ name: "beam", size: ["1 m", "100 mm", "100 mm"] });');
    root.querySelector<HTMLButtonElement>('.apply')!.click();
    const applied = sent.at(-1)!;
    expect(applied).toEqual({ cmd: 'geometry.addBox', name: 'beam', size: ['1 m', '100 mm', '100 mm'] });
    // The design's promise: the footer is the Command, not a description of it.
    expect(commandLine(applied as unknown as Record<string, unknown>)).toBe(recorded);
    expect(root.querySelector('.apply')!.textContent).toBe('Add body');
  });

  it('Revert goes back to the values the form opened with', () => {
    const { root, store, sent } = mount('load.pressure', { name: 'p', value: '2 MPa' });
    type(field(root, 'value').querySelector('input')!, '9 MPa');
    expect(store.state.form!.values['value']).toBe('9 MPa');
    root.querySelector<HTMLButtonElement>('[data-cmd="form.open"].outline')!.click();
    expect(sent.at(-1)).toEqual({ cmd: 'form.open', command: 'load.pressure', args: { name: 'p', value: '2 MPa' } });
    expect(store.state.form!.values['value']).toBe('2 MPa');
  });

  it('offers the Body\'s auto faces as chips, and "pick in viewer" arms the next selection', () => {
    const { root, store } = mount('constraint.fix', { name: 'root' });
    const on = field(root, 'on');
    expect([...on.querySelectorAll('.chip-cand')].map((c) => c.textContent)).toEqual(['beam.xmin', 'beam.xmax']);
    on.querySelector<HTMLButtonElement>('.chip-pick')!.click();
    expect(store.state.pickInto).toEqual(['on']);
    store.select({ faces: ['beam.xmax'] });
    expect(store.state.form!.values['on']).toBe('beam.xmax');
    expect(store.state.pickInto).toBeNull();
  });

  it('accumulates a multi picker and drops a chip again', () => {
    const { root, store } = mount('material.assign', { material: 'steel' });
    field(root, 'bodies').querySelector<HTMLButtonElement>('.chip-cand')!.click();
    expect(store.state.form!.values['bodies']).toEqual(['beam']);
    field(root, 'bodies').querySelector<HTMLButtonElement>('.chip-set button')!.click();
    expect(store.state.form!.values['bodies']).toBeUndefined();
  });

  it('dispatches the visually selected default kind when its tagged-union sub-form is edited', () => {
    const { root, store, sent } = mount('mesh.set');
    expect(root.querySelector('.recorded-cmd')!.textContent).toContain('mesher: { kind: "lattice" }');
    type(field(root, 'mesher.size').querySelector('input')!, '50 mm');
    expect(store.state.form!.values).toEqual({ mesher: { kind: 'lattice', size: '50 mm' } });
    root.querySelector<HTMLButtonElement>('.apply')!.click();
    expect(sent.at(-1)).toEqual({ cmd: 'mesh.set', mesher: { kind: 'lattice', size: '50 mm' } });
  });

  it('renders an enum as a segmented control and a boolean as yes / no', () => {
    const { root, store } = mount('study.converge');
    field(root, 'restore').querySelector<HTMLButtonElement>('button')!.click();
    expect(store.state.form!.values['restore']).toBe(true);
    field(root, 'quantity').querySelector<HTMLButtonElement>('button')!.click();
    expect(store.state.form!.values['quantity']).toEqual({ kind: 'max' });
  });

  it('takes a number as a number and a free-form object as JSON', () => {
    const { root, store } = mount('plugin.load');
    type(field(root, 'manifest').querySelector('textarea')! as unknown as HTMLInputElement, '{"a":1}');
    expect(store.state.form!.values['manifest']).toEqual({ a: 1 });
    type(field(root, 'manifest').querySelector('textarea')! as unknown as HTMLInputElement, '{"a":');
    expect(store.state.form!.values['manifest']).toEqual({ a: 1 });
    const { root: r2, store: s2 } = mount('material.add');
    type(field(r2, 'nu').querySelector('input')!, '0.3');
    expect(s2.state.form!.values['nu']).toBe(0.3);
    type(field(r2, 'nu').querySelector('input')!, '');
    expect(s2.state.form!.values['nu']).toBeUndefined();
  });
});
