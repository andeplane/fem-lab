// The global keyboard routes in App stay Command-driven and stand down while a person types.
import type { ModelSummary } from '@femlab/registry';
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store';
import { App } from '../src/ui/App';
import { afterEffects } from './wait-for';

const model = {
  name: 'keys',
  revision: 1,
  hash: 'h',
  units: { length: 'mm', force: 'N', stress: 'MPa' },
  idealisation: 'solid',
  bodies: [],
  materials: [],
  sets: [],
  constraints: [],
  loads: [],
  steps: [],
  meshSettings: null,
  warnings: [],
} as unknown as ModelSummary;

let root: HTMLElement | null = null;

async function mount() {
  const store = new Store();
  store.set({ ready: true, model, revision: 1 });
  const dispatch = vi.fn(async (_command: { cmd: string } & Record<string, unknown>) => undefined);
  root = document.createElement('div');
  document.body.append(root);
  render(<App store={store} dispatch={dispatch} viewer={{ current: null }} />, root);
  await afterEffects();
  return { dispatch, root };
}

const press = (target: EventTarget, code: string, repeat = false): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code, shiftKey: true, repeat });
  target.dispatchEvent(event);
  return event;
};

afterEach(() => {
  if (root) render(null, root);
  root?.remove();
  root = null;
});

describe('camera keyboard shortcuts', () => {
  it('dispatches each toolbar camera Command once and ignores key repeat', async () => {
    const { dispatch, root } = await mount();
    for (const code of ['Digit1', 'Digit2', 'Digit3', 'Digit4']) expect(press(root, code).defaultPrevented).toBe(true);
    press(root, 'Digit1', true);
    expect(dispatch.mock.calls.map(([command]) => command)).toEqual([
      { cmd: 'view.preset', view: 'iso' },
      { cmd: 'view.preset', view: 'front' },
      { cmd: 'view.preset', view: 'top' },
      { cmd: 'view.fit' },
    ]);
  });

  it('leaves form, script and chat editing targets alone', async () => {
    const { dispatch, root } = await mount();
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const select = document.createElement('select');
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    root.append(input, textarea, select, editable);
    for (const target of [input, textarea, select, editable]) expect(press(target, 'Digit2').defaultPrevented).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('puts the shortcuts in the camera buttons accessible titles', async () => {
    const { root } = await mount();
    expect([...root.querySelectorAll('.viewer-toolbar [title]')].map((button) => button.getAttribute('title')).filter((title) => title?.includes('⇧'))).toEqual([
      'iso view · ⇧1',
      'front view · ⇧2',
      'top view · ⇧3',
      'fit view · ⇧4',
    ]);
  });
});
