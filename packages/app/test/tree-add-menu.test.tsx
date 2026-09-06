import type { ModelSummary } from '@femlab/registry';
import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { Store, initialState } from '../src/store';
import { ModelTree } from '../src/ui/Tree';

const model = { name: 'menu', revision: 1, bodies: [], materials: [], sets: [], constraints: [], loads: [], steps: [], meshSettings: null, warnings: [] } as unknown as ModelSummary;

describe('Geometry add menu keyboard behavior', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('closes on Escape, restores focus to the chip, and stops global Escape handling', async () => {
    const store = new Store({ ...initialState, model });
    const root = document.createElement('div');
    document.body.append(root);
    render(<ModelTree s={store.state} dispatch={async () => undefined} shapes={[{ kind: 'box', hint: 'a box' }]} />, root);
    const chip = root.querySelector<HTMLButtonElement>('.chip-add')!;
    chip.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(root.querySelector('.add-menu')).not.toBeNull();
    let globalHandled = false;
    const globalHandler = (): void => {
      globalHandled = true;
    };
    window.addEventListener('keydown', globalHandler);
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    chip.dispatchEvent(event);
    window.removeEventListener('keydown', globalHandler);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(root.querySelector('.add-menu')).toBeNull();
    expect(document.activeElement).toBe(chip);
    expect(event.defaultPrevented).toBe(true);
    expect(globalHandled).toBe(false);
  });
});
