import { describe, expect, it, vi } from 'vitest';
import { makeHostContext } from '../src/host';
import { readHostCaps } from '../src/capabilities';
import { Store } from '../src/store';
import type { EngineTransport as WorkerTransport } from '@femlab/registry';

const transport = { dispatch: async () => undefined, query: async () => undefined } as unknown as WorkerTransport;

describe('viewer layer host state', () => {
  it('passes omitted on through as a flip and mirrors the resulting visibility', () => {
    const store = new Store();
    const visibility = new Map<string, boolean>();
    const setLayer = vi.fn((layer: string, on?: boolean) => {
      const next = on ?? !(visibility.get(layer) ?? true);
      visibility.set(layer, next);
      return next;
    });
    const viewer = { current: { setLayer } } as never;
    const context = makeHostContext(store, transport, viewer, readHostCaps({ navigator: { userAgent: 'Chrome/140' } }));

    context.view.toggle('grid');
    expect(setLayer).toHaveBeenLastCalledWith('grid', undefined);
    expect(store.state.layerVisibility.grid).toBe(false);
    context.view.toggle('grid');
    expect(store.state.layerVisibility.grid).toBe(true);
    context.view.toggle('grid', false);
    expect(store.state.layerVisibility.grid).toBe(false);
  });
});
