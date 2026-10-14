import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { initialState, Store } from '../src/store';
import { ImportAbaqus } from '../src/ui/ImportAbaqus';

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
  expect(dispatch).toHaveBeenLastCalledWith({ cmd: 'form.open', command: 'file.importAbaqus', args: { name: 'new', body: 'bar', picker: true, mode: 'static' }, keepInitial: true });
  edit('One source length unit', '1 mm'); draw(store, dispatch);
  expect(input('One source force unit').value).toBe('');
  expect(button('Choose .inp and import').disabled).toBe(true);
  edit('One source force unit', '1 N'); draw(store, dispatch);
  click('Choose .inp and import');
  expect(dispatch).toHaveBeenLastCalledWith({ cmd: 'file.importAbaqus', name: 'new', body: 'bar', picker: true, mode: 'static', unitLength: '1 mm', unitForce: '1 N' });
  click('Mesh and Sets'); draw(store, dispatch);
  expect(store.state.form!.values).not.toHaveProperty('unitForce');
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

it('renders only the requested import dialog and documents the first supported slice', () => {
  const dispatch = vi.fn(async () => undefined);
  act(() => render(<ImportAbaqus s={initialState} dispatch={dispatch} />, root));
  expect(root.innerHTML).toBe('');
  act(() => render(<ImportAbaqus s={{ ...initialState, panels: { abaqus: true }, form: { cmd: 'file.importAbaqus', values: {}, initial: {} } }} dispatch={dispatch} />, root));
  expect(root.textContent).toContain('C3D4 tetrahedra');
  expect(root.textContent).toContain('PART, ASSEMBLY, INSTANCE');
  expect(root.textContent).toContain('OUTPUT');
  expect(root.textContent).toContain('.odb or .cae');
});
