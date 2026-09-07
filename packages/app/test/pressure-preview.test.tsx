import { render } from 'preact';
import { beforeEach, expect, it, vi } from 'vitest';
import { PressurePreview } from '../src/ui/PressurePreview';
import type { Query } from '../src/ui/SchemaForm';
import { waitFor } from './wait-for';

beforeEach(() => {
  document.body.innerHTML = '';
});
const face = { kind: 'face', count: 1, measure: { value: 3.5, unit: 'm' }, pressureArea: { value: 0.105, unit: 'm^2' } };
const query: Query = async (q) => {
  if (q.query === 'query.set') return face;
  const input = q['quantity'] as string | { value: number; unit: string };
  const value = typeof input === 'string' ? 2_400_000 : input.value;
  return { value: q['to'] === 'kN' ? value / 1000 : q['to'] === 'mm^2' ? value * 1e6 : value, unit: q['to'] };
};
function setup(custom: Query = query) {
  const root = document.createElement('div');
  document.body.append(root);
  const draw = (context = 'first', on = 'top', forceUnit = 'kN', lengthUnit = 'mm', idealisation = 'planeStress') =>
    render(
      <PressurePreview pressure="2.4 MPa" on={on} context={context} forceUnit={forceUnit} lengthUnit={lengthUnit} idealisation={idealisation} query={custom} />,
      root,
    );
  draw();
  return { root, draw };
}
it('shows the independently known 252 kN pressure-area value and changes display units', async () => {
  const calls = vi.fn(query);
  const { root, draw } = setup(calls);
  await waitFor(() => root.textContent?.includes('252.0 kN'), 'the pressure-area value');
  expect(root.textContent).toContain('1.050e+5 mm^2');
  expect(root.textContent).toContain('(scalar)');
  draw('same model', 'top', 'N', 'm');
  await waitFor(() => root.textContent?.includes('2.520e+5 N'), 'the SI force');
  expect(root.textContent).toContain('0.1050 m^2');
  expect(calls.mock.calls.every(([q]) => q.query === 'query.set' || q.query === 'query.convert')).toBe(true);
});
it('rejects empty Sets and invalid pressure instead of displaying a fabricated total', async () => {
  const { root } = setup(async (q) => (q.query === 'query.set' ? { ...face, count: 0 } : query(q)));
  await waitFor(() => root.textContent?.includes('non-empty face Set'), 'the empty Set message');
  expect(root.querySelector('.bad')).not.toBeNull();
  const second = setup(async () => {
    throw new Error('pressure dimension mismatch');
  });
  await waitFor(() => second.root.textContent?.includes('pressure dimension mismatch'), 'the invalid pressure message');
});
it('ignores a delayed area response after the Set and Model context change', async () => {
  let finish!: (value: unknown) => void;
  const delayed = new Promise((resolve) => {
    finish = resolve;
  });
  const { root, draw } = setup(async (q) => (q.query === 'query.set' && q['name'] === 'top' ? delayed : query(q)));
  draw('remeshed', 'other');
  await waitFor(() => root.textContent?.includes('252.0 kN'), 'the replacement Set area');
  finish({ ...face, pressureArea: { value: 99, unit: 'm^2' } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(root.textContent).toContain('252.0 kN');
  expect(root.textContent).not.toContain('237600');
});

it('labels the plane-strain unit-depth convention and refuses absent loaded area', async () => {
  const { root, draw } = setup();
  draw('plane-strain', 'top', 'kN', 'mm', 'planeStrain');
  await waitFor(() => root.textContent?.includes('per 1 m out-of-plane depth'), 'the plane-strain convention');
  const unavailable = setup(async (q) => (q.query === 'query.set' ? { ...face, pressureArea: null } : query(q)));
  await waitFor(() => unavailable.root.textContent?.includes('Loaded face area is unavailable'), 'the unsupported area message');
});
