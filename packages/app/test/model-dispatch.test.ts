import { describe, expect, it, vi } from 'vitest';
import { Registry } from '@femlab/registry';
import { serializeModelDispatch } from '../src/model-dispatch';

const registry = { describe: (name: string) => ({ provider: name.startsWith('geometry.') ? 'engine' : 'host' }) } as Pick<Registry, 'describe'>;

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};

describe('complete model operation ordering', () => {
  it('holds new, delete and engine edits behind a replay and its refresh while UI and cancel remain live', async () => {
    const replay = gate();
    const entered = gate();
    const calls: string[] = [];
    const dispatch = serializeModelDispatch(registry, async ({ cmd }) => {
      calls.push(cmd);
      if (cmd === 'project.open') { entered.release(); await replay.promise; calls.push('refreshed'); }
    });
    const opening = dispatch({ cmd: 'project.open' });
    await entered.promise;
    const deleting = dispatch({ cmd: 'project.delete' });
    const creating = dispatch({ cmd: 'project.new' });
    const editing = dispatch({ cmd: 'geometry.addBox' });
    await dispatch({ cmd: 'panel.toggle' });
    await dispatch({ cmd: 'solve.cancel' });
    expect(calls).toEqual(['project.open', 'panel.toggle', 'solve.cancel']);
    replay.release();
    await Promise.all([opening, deleting, creating, editing]);
    expect(calls.slice(3)).toEqual(['refreshed', 'project.delete', 'project.new', 'geometry.addBox']);
  });

  it('runs nested script Commands and recovers after a rejected model operation', async () => {
    const run = vi.fn<Registry['dispatch']>(async ({ cmd }) => {
      if (cmd === 'project.open') throw new Error('invalid saved Journal');
      if (cmd === 'script.run') return dispatch({ cmd: 'geometry.addBox' });
      return 'done';
    });
    const dispatch = serializeModelDispatch(registry, run);
    await expect(dispatch({ cmd: 'project.open' })).rejects.toThrow('invalid saved Journal');
    await expect(dispatch({ cmd: 'script.run' })).resolves.toBe('done');
    await expect(dispatch({ cmd: 'project.new' })).resolves.toBe('done');
  });
});
