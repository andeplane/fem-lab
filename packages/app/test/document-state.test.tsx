import { render } from 'preact';
import { beforeEach, expect, it, vi } from 'vitest';
import { appHostCommands } from '../src/host';
import { Store, journalIdentity, unsaved } from '../src/store';
import { ModelName } from '../src/ui/ModelName';
import type { WorkerTransport } from '../src/worker-transport';

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

it('establishes an exact saved baseline only after a bundled example opens completely', async () => {
  const first = { seq: 0, cmd: { cmd: 'model.new' as const, name: 'example' }, hashAfter: 'normalized-0' };
  const second = {
    seq: 1,
    cmd: { cmd: 'geometry.addBox' as const, name: 'beam', size: ['1 m', '1 m', '1 m'] as [string, string, string] },
    hashAfter: 'normalized-1',
  };
  const store = new Store({ ...new Store().state, savedJournal: 'previous baseline' });
  const dispatch = vi.fn(async () => ({ output: { kind: 'none' } }));
  const transport = { dispatch } as unknown as WorkerTransport;
  const refresh = vi.fn(async () => store.set({ journal: { entries: [first, second], revision: 2, hash: 'journal', canUndo: true, canRedo: false } }));
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => JSON.stringify([{ cmd: first.cmd }, { cmd: second.cmd }]) })));
  const open = appHostCommands(store, transport, { current: null }, refresh).find((def) => def.name === 'file.openExample')!;

  await open.run({ name: 'example' }, {} as never);
  expect(dispatch).toHaveBeenCalledTimes(2);
  expect(store.state.savedJournal).toBe(journalIdentity([first, second]));

  store.set({ savedJournal: 'still previous' });
  dispatch.mockResolvedValueOnce({ output: { kind: 'none' } });
  dispatch.mockRejectedValueOnce(new Error('second command failed'));
  await expect(open.run({ name: 'broken' }, {} as never)).rejects.toThrow('second command failed');
  expect(store.state.savedJournal).toBe('still previous');
});

it('does not include an edit made while an opened example restores its Result', async () => {
  const opened = [{ seq: 0, cmd: { cmd: 'model.new' as const, name: 'solved example' }, hashAfter: 'opened' }];
  const edited = [...opened, { seq: 1, cmd: { cmd: 'model.setName' as const, name: 'later edit' }, hashAfter: 'edited' }];
  const store = new Store();
  const dispatch = vi.fn(async () => ({ output: { kind: 'solve' } }));
  const transport = { dispatch } as unknown as WorkerTransport;
  const refresh = vi.fn(async () => store.set({ journal: { entries: opened, revision: 1, hash: 'opened', canUndo: true, canRedo: false } }));
  let finishResult!: () => void;
  const onAck = vi.fn(() => new Promise<void>((resolve) => { finishResult = resolve; }));
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    text: async () => JSON.stringify([{ cmd: opened[0]!.cmd }, { cmd: { cmd: 'solve.run', step: 'static' } }]),
  })));
  const open = appHostCommands(store, transport, { current: null }, refresh, { onAck } as never).find((def) => def.name === 'file.openExample')!;

  const pending = open.run({ name: 'solved-example' }, {} as never);
  await vi.waitFor(() => expect(onAck).toHaveBeenCalledOnce());
  store.set({ journal: { entries: edited, revision: 2, hash: 'edited', canUndo: true, canRedo: false } });
  finishResult();
  await pending;

  expect(store.state.savedJournal).toBe(journalIdentity(opened));
  expect(unsaved(store.state)).toBe(true);
});
