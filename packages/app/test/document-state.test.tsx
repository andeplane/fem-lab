import { render } from 'preact';
import { beforeEach, expect, it, vi } from 'vitest';
import { Store, journalIdentity, unsaved } from '../src/store';
import { ModelName } from '../src/ui/ModelName';

beforeEach(() => {
  document.body.innerHTML = '';
});
const entries = [{ seq: 0, cmd: { cmd: 'model.new' as const, name: 'beam' }, hashAfter: 'h' }];
it('tracks complete Journal content, ignores view changes, and clears when undo returns to the saved content', () => {
  const store = new Store();
  store.set({ journal: { entries, revision: 1, hash: 'history', canUndo: true, canRedo: false } });
  expect(unsaved(store.state)).toBe(true);
  store.markSaved({ entries });
  expect(unsaved(store.state)).toBe(false);
  store.togglePanel('assistant', true);
  expect(unsaved(store.state)).toBe(false);
  const edited = [{ ...entries[0]!, cmd: { cmd: 'model.new' as const, name: 'changed at same revision' } }];
  store.set({ journal: { ...store.state.journal!, entries: edited } });
  expect(unsaved(store.state)).toBe(true);
  store.set({ journal: { ...store.state.journal!, entries } });
  expect(unsaved(store.state)).toBe(false);
  const reordered = JSON.parse('[{"hashAfter":"h","cmd":{"name":"beam","cmd":"model.new"},"seq":0}]');
  expect(journalIdentity(reordered)).toBe(journalIdentity(entries));
  // A save that finishes after another edit records its captured payload, never the later edit.
  store.set({ journal: { ...store.state.journal!, entries: edited } });
  store.markSaved({ entries });
  expect(unsaved(store.state)).toBe(true);
});

it('commits the name exactly once on Enter or blur, cancels Escape, and rejects blank drafts', async () => {
  const dispatch = vi.fn(async () => undefined);
  const root = document.createElement('div');
  document.body.append(root);
  render(<ModelName name="beam" dirty dispatch={dispatch} />, root);
  const input = root.querySelector('input')!;
  const edit = async (value: string, key?: string) => {
    input.focus();
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    if (key) input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    else input.blur();
    await new Promise((r) => setTimeout(r, 0));
  };
  await edit('girder', 'Enter');
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(dispatch).toHaveBeenLastCalledWith({ cmd: 'model.setName', name: 'girder' });
  await edit('discarded', 'Escape');
  expect(input.value).toBe('beam');
  expect(dispatch).toHaveBeenCalledTimes(1);
  await edit('  ', 'Enter');
  expect(dispatch).toHaveBeenCalledTimes(1);
  await edit('second');
  expect(dispatch).toHaveBeenCalledTimes(2);
  expect(dispatch).toHaveBeenLastCalledWith({ cmd: 'model.setName', name: 'second' });
  expect(root.querySelector('[aria-label="Unsaved changes"]')).not.toBeNull();
  render(null, root);
});
