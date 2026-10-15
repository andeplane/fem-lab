import type { ModelSummary, Progress } from '@femlab/registry';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/store';
import { App } from '../src/ui/App';
import type { Dispatch } from '../src/ui/cmd';

const model: ModelSummary = {
  name: 'progress', revision: 1, hash: 'progress', units: {}, idealisation: 'solid3d',
  bodies: [], materials: [], sets: [], constraints: [], connections: [], loads: [], steps: [],
  meshSettings: null, warnings: [],
};
const mounted: HTMLElement[] = [];
function mount(progress: { phase: string; fraction: number; message?: string }) {
  const store = new Store();
  store.set({ ready: true, model, revision: 1, solving: 'static', progress });
  const root = document.createElement('div'); document.body.append(root); mounted.push(root);
  const dispatch = vi.fn<Dispatch>(async () => undefined);
  act(() => render(<App store={store} dispatch={dispatch} viewer={{ current: null }} />, root));
  return { root, store, dispatch };
}
afterEach(() => { for (const root of mounted.splice(0)) { act(() => render(null, root)); root.remove(); } });

it('shows the supplied measured message and updates it at a fixed phase and percentage', () => {
  const first: Required<Progress> = { phase: 'solve', fraction: 0.5, message: 'refinement 2: relative residual 2.5e-6' };
  const { root, store, dispatch } = mount(first);
  expect(root.querySelector('.solving-card')?.textContent).toContain(first.message);
  const next: Required<Progress> = { ...first, message: 'refinement 3: relative residual 4.2e-10' };
  act(() => store.set({ progress: next }));
  expect(root.querySelector('.solving-card')?.textContent).toContain(next.message);
  expect(root.querySelector('.solving-card')?.textContent).not.toContain(first.message);
  root.querySelector<HTMLButtonElement>('[data-cmd="solve.cancel"]')!.click();
  expect(dispatch).toHaveBeenCalledWith({ cmd: 'solve.cancel' });
});

it('does not invent iteration, residual or ETA when only phase and fraction are supplied', () => {
  const { root } = mount({ phase: 'assemble', fraction: 0.1 });
  const card = root.querySelector('.solving-card')!;
  expect(card.textContent).toContain('assemble · 10 %');
  expect(card.textContent).not.toMatch(/residual|iteration|eta|remaining/i);
});
