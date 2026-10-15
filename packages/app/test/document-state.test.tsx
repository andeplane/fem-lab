import { render } from 'preact';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appHostCommands } from '../src/host';

import { Store, journalIdentity, unsaved } from '../src/store';
import { ModelName } from '../src/ui/ModelName';
import type { EngineTransport as WorkerTransport } from '@femlab/registry';

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => vi.unstubAllGlobals());
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
  expect(store.state.savedBaseline).toEqual(entries);
});

it('compares an imported file through journalDiff without importing or changing the active Journal', async () => {
  const current = entries[0]!;
  const imported = { ...current, cmd: { cmd: 'model.new' as const, name: 'imported' } };
  const store = new Store({ ...new Store().state, journal: { entries: [current], revision: 1, hash: 'active', canUndo: true, canRedo: false } });
  const query = vi.fn(async () => ({ baseHash: 'base', currentHash: 'active', sharedEntries: 0, removed: [imported], added: [current] }));
  const importFile = vi.fn();
  const transport = { query, importFile } as unknown as WorkerTransport;
  const compare = appHostCommands(store, transport, { current: null }, async () => undefined).find((def) => def.name === 'file.compare')!;
  const result = await compare.run({ json: JSON.stringify({ format: 'femlab/1', journal: { entries: [imported] } }) }, {} as never);

  expect(result).toMatchObject({ sharedEntries: 0, removed: [imported], added: [current] });
  expect(query).toHaveBeenCalledWith({ query: 'query.journalDiff', base: { entries: [imported] } });
  expect(importFile).not.toHaveBeenCalled();
  expect(store.state.journal?.entries).toEqual([current]);
  expect(store.state.comparisonSource).toBe('imported');
});

it('rejects malformed comparison files as structured schema errors', async () => {
  const compare = appHostCommands(new Store(), { query: vi.fn() } as unknown as WorkerTransport, { current: null }, async () => undefined).find((def) => def.name === 'file.compare')!;
  await expect(compare.run({ json: 'null' }, {} as never)).rejects.toMatchObject({ code: 'schema', where: 'file' });
});

it('keeps an explicit baseline normalized while undo and redo update the causal diff', () => {
  const first = entries[0]!;
  const second = { seq: 1, cmd: { cmd: 'model.setName' as const, name: 'girder' }, hashAfter: 'h2' };
  const store = new Store();
  store.markSaved({ entries: [first] });
  store.set({ journal: { entries: [first, second], revision: 2, hash: 'h2', canUndo: true, canRedo: false } });
  expect(store.state.savedBaseline).toEqual([first]);
  expect(unsaved(store.state)).toBe(true);
  store.set({ journal: { entries: [first], revision: 1, hash: 'h', canUndo: false, canRedo: true } });
  expect(unsaved(store.state)).toBe(false);
});

it('commits the name exactly once on Enter or blur, cancels Escape, and rejects blank drafts', async () => {
  const dispatch = vi.fn(async () => undefined);
  const root = document.createElement('div');
  document.body.append(root);
  render(<ModelName name="beam" dirty dispatch={dispatch} />, root);
  const input = root.querySelector('input')!;
  expect(input.title).toBe('beam');
  expect(input.getAttribute('aria-description')).toContain('Escape to cancel');
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

it('a new activation has no saved baseline and an old completion can only change its old Store', () => {
  const old = new Store(); old.markSaved({ entries });
  const complete = old.beginSave();
  const fresh = new Store();
  complete({ entries });
  expect(fresh.state.savedBaseline).toBeNull();
  expect(fresh.state.savedJournal).toBeNull();
  expect(fresh.state.comparisonSource).toBeNull();
  expect(old.state.savedBaseline).toEqual(entries);
});
