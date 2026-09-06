// The ⌘K palette is a view of the registry, so its filter is checked against the real registry:
// typing a Command's name has to put that Command first, or `⇥` fills in the wrong form.
import type { CommandDef, EngineSchema } from '@femlab/registry';
import { HOST_COMMANDS, Registry } from '@femlab/registry';
import { describe, expect, it } from 'vitest';
import schema from '../../registry/src/generated/engine.schema.json';
import { readHostCaps } from '../src/capabilities';
import { appHostCommands, makeHostContext } from '../src/host';
import { Store } from '../src/store';
import { fuzzy, rankCommands, requiredOf, score } from '../src/ui/Overlays';
import type { WorkerTransport } from '../src/worker-transport';

const transport = { dispatch: async () => undefined, query: async () => undefined } as unknown as WorkerTransport;
const registry = new Registry({
  schema: schema as unknown as EngineSchema,
  host: makeHostContext(new Store(), transport, { current: null }, readHostCaps({ navigator: { userAgent: 'Chrome/1' } }), async () => undefined),
  hostCommands: [...HOST_COMMANDS, ...appHostCommands(new Store(), transport, { current: null }, async () => undefined)],
});
const commands: CommandDef[] = registry.list().commands;
const names = (query: string) => rankCommands(query, commands).map((c) => c.name);

describe('the command palette', () => {
  it('matches letters in order, and everything on an empty query', () => {
    expect(fuzzy('', 'anything')).toBe(true);
    expect(fuzzy('gab', 'geometry.addBox')).toBe(true);
    expect(fuzzy('xyz', 'geometry.addBox')).toBe(false);
    expect(fuzzy('add box', 'geometry.addBox')).toBe(true);
  });

  it('ranks an exact name first, then a name that contains the query, then the doc strings', () => {
    expect(score('load.pressure', { name: 'load.pressure', description: '' })).toBe(0);
    expect(score('pressure', { name: 'load.pressure', description: '' })).toBe(1);
    expect(score('lprs', { name: 'load.pressure', description: '' })).toBe(2);
    expect(score('a hole', { name: 'geometry.subtractBox', description: 'a hole, notch or opening' })).toBe(3);
    expect(score('ahole', { name: 'geometry.subtractBox', description: 'a hole, notch or opening' })).toBe(4);
    expect(score('zzz', { name: 'a', description: 'b' })).toBeNull();
  });

  it('puts the Command you typed at the top, not whatever the registry lists first', () => {
    expect(names('model.setUnits')[0]).toBe('model.setUnits');
    expect(names('load.pressure')[0]).toBe('load.pressure');
    expect(names('undo')[0]).toBe('journal.undo');
    expect(names('')).toEqual(commands.map((c) => c.name));
  });

  it('lists every registered Command, host and engine alike, with a doc string each', () => {
    expect(commands.length).toBeGreaterThan(60);
    expect(names('')).toContain('geometry.addBox');
    expect(names('')).toContain('view.fit');
    expect(names('')).toContain('form.open');
    for (const c of commands) expect(c.description.length, c.name).toBeGreaterThan(20);
  });

  it('knows which Commands ↵ can run outright and which need ⇥ first', () => {
    const by = (name: string) => requiredOf(commands.find((c) => c.name === name)!);
    expect(by('view.fit')).toEqual([]);
    expect(by('journal.undo')).toEqual([]);
    expect(by('geometry.addBox')).toEqual(['name', 'size']);
    expect(by('solve.run')).toEqual(['step']);
  });
});
