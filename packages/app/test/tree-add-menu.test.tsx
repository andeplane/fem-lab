import type { ModelSummary } from '@femlab/registry';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { Store, initialState } from '../src/store';
import { ModelTree } from '../src/ui/Tree';

const model = { name: 'menu', revision: 1, bodies: [], materials: [], sets: [], constraints: [], loads: [], steps: [], meshSettings: null, warnings: [] } as unknown as ModelSummary;

describe('Geometry add menu keyboard behavior', () => {
  afterEach(async () => {
    await act(async () => {
      for (const root of [...document.body.children]) render(null, root);
    });
    document.body.replaceChildren();
  });

  it('closes on Escape, restores focus to the chip, and stops global Escape handling', async () => {
    const store = new Store({ ...initialState, model });
    const root = document.createElement('div');
    document.body.append(root);
    await act(async () => render(<ModelTree s={store.state} dispatch={async () => undefined} shapes={[{ kind: 'box', hint: 'a box' }]} />, root));
    const chip = root.querySelector<HTMLButtonElement>('.chip-add')!;
    await act(async () => chip.click());
    expect(root.querySelector('.add-menu')).not.toBeNull();
    let globalHandled = false;
    const globalHandler = (): void => {
      globalHandled = true;
    };
    window.addEventListener('keydown', globalHandler);
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    const item = root.querySelector<HTMLElement>('.add-menu [data-cmd]')!;
    await act(async () => {
      item.focus();
      item.dispatchEvent(event);
    });
    window.removeEventListener('keydown', globalHandler);
    expect(root.querySelector('.add-menu')).toBeNull();
    expect(document.activeElement).toBe(chip);
    expect(event.defaultPrevented).toBe(true);
    expect(globalHandled).toBe(false);
  });
});
