import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { initialState, Store } from '../src/store';
import { AbaqusImportReport, ImportAbaqus } from '../src/ui/ImportAbaqus';
import { ABAQUS_CONVERSION } from '../../registry/test/fakes';

const root = document.createElement('div');
afterEach(() => act(() => render(null, root)));
const button = (name: string) => [...root.querySelectorAll('button')].find(item => item.textContent?.trim() === name || item.title === name)!;
const input = (label: string) => root.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
const edit = (label: string, value: string) => act(() => {
  const element = input(label); element.value = value; element.dispatchEvent(new Event('input', { bubbles: true }));
});
const click = (name: string) => act(() => button(name).click());
const formDispatch = (store: Store) => vi.fn(async (command: { cmd: string } & Record<string, unknown>) => {
  if (command.cmd === 'form.open') store.openForm(String(command['command']), command['args'] as Record<string, unknown>, command['keepInitial'] === true);
});
const draw = (store: Store, dispatch: ReturnType<typeof formDispatch>) => act(() => render(<ImportAbaqus s={store.state} dispatch={dispatch} />, root));

it('requires source units and mode independently of display units, and routes each edit through form.open', () => {
  const store = new Store();
  store.set({ panels: { abaqus: true }, form: { cmd: 'file.importAbaqus', values: { name: 'new', body: 'bar', picker: true }, initial: {} } });
  const dispatch = formDispatch(store);
  draw(store, dispatch);
  expect(button('Choose .inp and import').disabled).toBe(true);
  expect(input('One source length unit').value).toBe('');
  click('Linear static analysis'); draw(store, dispatch);
  expect(dispatch).toHaveBeenLastCalledWith({ cmd: 'form.open', command: 'file.importAbaqus', args: { name: 'new', body: 'bar', picker: true, mode: 'static', unitTime: '1 s' }, keepInitial: true });
  expect(input('One source time unit').value).toBe('1 s');
  edit('One source length unit', '1 mm'); draw(store, dispatch);
  expect(input('One source force unit').value).toBe('');
  expect(button('Choose .inp and import').disabled).toBe(true);
  edit('One source force unit', '1 N'); draw(store, dispatch);
  click('Choose .inp and import');
  expect(dispatch).toHaveBeenLastCalledWith({ cmd: 'file.importAbaqus', name: 'new', body: 'bar', picker: true, mode: 'static', unitLength: '1 mm', unitForce: '1 N', unitTime: '1 s' });
  click('Mesh and Sets'); draw(store, dispatch);
  expect(store.state.form!.values).not.toHaveProperty('unitForce');
  expect(store.state.form!.values).not.toHaveProperty('unitTime');
  expect(input('One source force unit')).toBeNull();
  click('Choose .inp and import');
  expect(dispatch).toHaveBeenLastCalledWith({ cmd: 'file.importAbaqus', name: 'new', body: 'bar', picker: true, mode: 'mesh', unitLength: '1 mm' });
  click('Linear static analysis'); draw(store, dispatch);
  expect(input('One source force unit').value).toBe('');
  expect(button('Choose .inp and import').disabled).toBe(true);
});

it('changes source without retaining a hidden second input and dispatches the exact inline deck', () => {
  const store = new Store();
  store.set({ panels: { abaqus: true }, form: { cmd: 'file.importAbaqus', values: { name: 'new', body: 'bar', picker: true, mode: 'mesh', unitLength: '1 m' }, initial: {} } });
  const dispatch = formDispatch(store);
  draw(store, dispatch);
  click('Paste inline deck'); draw(store, dispatch);
  expect(store.state.form!.values).not.toHaveProperty('picker');
  expect(button('Import deck').disabled).toBe(true);
  edit('Abaqus input text', '*NODE\r\n1,0,0,0\r\n'); draw(store, dispatch);
  click('Import deck');
  expect(dispatch).toHaveBeenLastCalledWith({ cmd: 'file.importAbaqus', name: 'new', body: 'bar', mode: 'mesh', unitLength: '1 m', text: '*NODE\r\n1,0,0,0\r\n' });
  click('Close Abaqus import');
  expect(dispatch).toHaveBeenLastCalledWith({ cmd: 'panel.toggle', panel: 'abaqus', open: false });
  expect(root.querySelectorAll('button:not([data-cmd]),input:not([data-cmd]),textarea:not([data-cmd])')).toHaveLength(0);
});

it('renders only the requested dialog and explains submission includes and explicit physical limits', () => {
  const dispatch = vi.fn(async () => undefined);
  act(() => render(<ImportAbaqus s={initialState} dispatch={dispatch} />, root));
  expect(root.innerHTML).toBe('');
  act(() => render(<ImportAbaqus s={{ ...initialState, panels: { abaqus: true }, form: { cmd: 'file.importAbaqus', values: {}, initial: {} } }} dispatch={dispatch} />, root));
  expect(root.textContent).toContain('transformed instances');
  expect(root.textContent).toContain('submission folder');
  expect(root.textContent).toContain('.odb');
  expect(root.textContent).toContain('.cae');
});

it('offers complete source unit presets and makes a changed time basis explicit before import', () => {
  const store = new Store();
  store.set({ panels: { abaqus: true }, form: { cmd: 'file.importAbaqus', values: { name: 'new', body: 'bar', picker: true }, initial: {} } });
  const dispatch = formDispatch(store); draw(store, dispatch);
  click('mm · N · s'); draw(store, dispatch);
  expect(store.state.form!.values).toMatchObject({ mode: 'static', unitLength: '1 mm', unitForce: '1 N', unitTime: '1 s' });
  edit('One source time unit', ''); draw(store, dispatch);
  expect(button('Choose .inp and import').disabled).toBe(true);
  edit('One source time unit', '1 ms'); draw(store, dispatch);
  click('Choose .inp and import');
  expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ cmd: 'file.importAbaqus', unitTime: '1 ms' }));
  click('Mesh and Sets'); draw(store, dispatch); click('m'); draw(store, dispatch);
  expect(store.state.form!.values).toMatchObject({ mode: 'mesh', unitLength: '1 m' });
  expect(store.state.form!.values).not.toHaveProperty('unitTime');
});

it('shows structured Quantity proposals and the exact published static report without a second approval', () => {
  const store = new Store();
  store.set({ panels: { abaqus: true }, form: { cmd: 'file.importAbaqus', values: { name: 'new', body: 'bar', picker: true, mode: 'static', unitLength: { value: 1, unit: 'mm' }, unitForce: { value: 1, unit: 'N' } }, initial: {} } });
  const dispatch = formDispatch(store);
  draw(store, dispatch);
  expect(input('One source length unit').value).toBe('1 mm');
  expect(input('One source force unit').value).toBe('1 N');
  store.set({ panels: { abaqusReport: true }, abaqusReport: { ...ABAQUS_CONVERSION.report, mode: 'static', sourceNodes: 5, sourceLabels: { nodes: [1, 2, 3, 4, 9999], elements: [1], unusedNodes: [9999] }, unitForce: { value: 1, unit: 'N' }, sets: [{ kind: 'node', source: 'ROOT', target: 'bar.nset_ROOT', count: 3 }], headings: ['independent fixture'], preprint: [{ echo: false }], analysisConfigured: true, analysis: { material: 'STEEL', sectionElset: 'bar.elset_SOLID', step: 'AXIAL', constraints: ['abaqus_boundary_1'], loads: ['abaqus_cload_1'], finalEquilibriumOnly: true } } });
  act(() => render(<AbaqusImportReport s={store.state} dispatch={dispatch} />, root));
  expect(root.textContent).toContain('0.001 m');
  expect(root.textContent).toContain('1 N');
  expect(root.textContent).toContain('STEEL');
  expect(root.textContent).toContain('AXIAL');
  expect(root.textContent).toContain('bar.nset_ROOT');
  expect(root.textContent).toContain('9999');
  expect(root.textContent).toContain('physically unanalysed');
  expect(root.textContent).toContain('echo=NO');
  expect(root.textContent).toContain('not solved');
  expect(root.textContent).toContain('increment history is not reproduced');
  expect(root.querySelectorAll('button')).toHaveLength(1);
  click('Close Abaqus import report');
  expect(dispatch).toHaveBeenLastCalledWith({ cmd: 'panel.toggle', panel: 'abaqusReport', open: false });
  act(() => render(<AbaqusImportReport s={initialState} dispatch={dispatch} />, root));
  expect(root.innerHTML).toBe('');
});


it('shows original material and load-case identities, mixed elements and located output notes', () => {
  const dispatch = vi.fn(async () => undefined);
  const first = {
    material: 'abaqus_material_1', sectionElset: 'bracket.elset_STEEL',
    sourceStep: 'Bolt preload', step: 'abaqus_step_1', constraints: ['root'], loads: ['preload'],
    finalEquilibriumOnly: true,
    sections: [
      { sectionElset: 'bracket.elset_STEEL', sourceMaterial: 'Steel, annealed', material: 'abaqus_material_1', body: 'bracket_region_1', elements: 12 },
      { sectionElset: 'bracket.elset_ALUMINIUM', sourceMaterial: 'Aluminium', material: 'ALUMINIUM', body: 'bracket_region_2', elements: 8 },
    ],
  };
  const second = { ...first, sourceStep: 'Service pressure', step: 'abaqus_step_2', loads: ['preload', 'pressure'] };
  const store = new Store();
  store.set({ panels: { abaqusReport: true }, abaqusReport: {
    ...ABAQUS_CONVERSION.report, mode: 'static', elementKinds: ['tet10', 'hex20'],
    unitTime: { value: 0.001, unit: 's' }, analysisConfigured: true, analysis: first, analyses: [first, second],
    notes: [{ source: 'output/requests.inp', line: 17, keyword: 'NODE OUTPUT', cause: 'Authored output request retained: U, RF.' }],
  } });
  act(() => render(<AbaqusImportReport s={store.state} dispatch={dispatch} />, root));
  expect(root.textContent).toContain('tet10, hex20');
  expect(root.textContent).toContain('0.001 s');
  expect(root.textContent).toContain('Steel, annealed');
  expect(root.textContent).toContain('bracket_region_1');
  expect(root.textContent).toContain('Aluminium');
  expect(root.textContent).toContain('Bolt preload');
  expect(root.textContent).toContain('Service pressure');
  expect(root.textContent).toContain('abaqus_step_2');
  expect(root.textContent).toContain('output/requests.inp:17 · *NODE OUTPUT');
  expect(root.textContent).toContain('Authored output request retained: U, RF.');
  const loadCases = [...root.querySelectorAll('table')].find(table => table.textContent?.includes('Source Step'))!;
  expect([...loadCases.querySelectorAll('tbody tr')].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent)))
    .toEqual([['Bolt preload', 'abaqus_step_1', '1', '1'], ['Service pressure', 'abaqus_step_2', '1', '2']]);
});


it('keeps a single quoted source Step visible beside its callable Step name', () => {
  const analysis = { material: 'STEEL', sectionElset: 'SOLID', sourceStep: 'Bolt preload', step: 'abaqus_step_1', constraints: [], loads: [], finalEquilibriumOnly: true };
  const store = new Store();
  store.set({ panels: { abaqusReport: true }, abaqusReport: { ...ABAQUS_CONVERSION.report, analysis, analyses: [analysis] } });
  act(() => render(<AbaqusImportReport s={store.state} dispatch={vi.fn(async () => undefined)} />, root));
  const mapping = [...root.querySelectorAll('table')].find(table => table.textContent?.includes('Source Step'))!;
  expect(mapping.textContent).toContain('Bolt preload');
  expect(mapping.textContent).toContain('abaqus_step_1');
});
