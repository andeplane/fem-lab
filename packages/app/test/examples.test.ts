// The gallery is driven only by shipped benchmark metadata. These checks hold both filter
// dimensions and their registry Command against the same values the cards render.
import { HOST_COMMANDS, Registry, type EngineSchema } from '@femlab/registry';
import { describe, expect, it } from 'vitest';
import schema from '../../registry/src/generated/engine.schema.json';
import { readHostCaps } from '../src/capabilities';
import { appHostCommands, makeHostContext } from '../src/host';
import { Store } from '../src/store';
import { expectedValue, filterExamples, type ExampleEntry } from '../src/ui/Overlays';
import type { WorkerTransport } from '../src/worker-transport';

const items: ExampleEntry[] = [
  {
    name: 'cantilever',
    commands: 10,
    title: 'Cantilever beam',
    tag: 'P1 · verify',
    tags: ['static', 'beam', 'hex8'],
    difficulty: 1,
    summary: 'A beam.',
    expected: { quantity: 'tip deflection', value: -0.1901, unit: 'mm', reference: 'beam theory' },
    thumbnail: 'thumbnails/cantilever.png',
  },
  {
    name: 'modal',
    commands: 9,
    title: 'Natural frequencies',
    tag: 'P1 · verify',
    tags: ['modal', 'beam'],
    difficulty: 2,
    summary: 'A modal beam.',
    expected: { quantity: 'frequencies', value: [21.06, 42.01], unit: 'Hz', reference: 'Euler–Bernoulli' },
    thumbnail: 'thumbnails/modal.png',
  },
  {
    name: 'thermal',
    commands: 10,
    title: 'Thermal plate',
    tag: 'NAFEMS',
    tags: ['thermal', 'plane-strain'],
    difficulty: 3,
    summary: 'A thermal plate.',
    expected: { quantity: 'stress', value: -150, unit: 'MPa', reference: 'closed form' },
    thumbnail: 'thumbnails/thermal.png',
  },
];

describe('the examples gallery', () => {
  it('combines tag and difficulty filters and resets either dimension with null', () => {
    expect(filterExamples(items, { tag: null, difficulty: null })).toEqual(items);
    expect(filterExamples(items, { tag: 'beam', difficulty: null }).map((e) => e.name)).toEqual(['cantilever', 'modal']);
    expect(filterExamples(items, { tag: 'beam', difficulty: 2 }).map((e) => e.name)).toEqual(['modal']);
    expect(filterExamples(items, { tag: 'thermal', difficulty: 1 })).toEqual([]);
  });

  it('formats scalar and vector expected values without dropping their units', () => {
    expect(expectedValue(items[0]!.expected)).toBe('-0.1901 mm');
    expect(expectedValue(items[1]!.expected)).toBe('21.06 · 42.01 Hz');
  });

  it('routes filter changes through the registry into app view state', async () => {
    const store = new Store();
    const transport = { dispatch: async () => undefined, query: async () => undefined } as unknown as WorkerTransport;
    const viewer = { current: null };
    const host = readHostCaps({ navigator: { userAgent: 'Chrome/1' } });
    const registry = new Registry({
      schema: schema as unknown as EngineSchema,
      host: makeHostContext(store, transport, viewer, host),
      hostCommands: [...HOST_COMMANDS, ...appHostCommands(store, transport, viewer, async () => undefined)],
    });
    await registry.dispatch({ cmd: 'example.filter', tag: 'beam', difficulty: 2 });
    expect(store.state.exampleFilter).toEqual({ tag: 'beam', difficulty: 2 });
    await registry.dispatch({ cmd: 'example.filter', tag: null, difficulty: null });
    expect(store.state.exampleFilter).toEqual({ tag: null, difficulty: null });
  });
});
