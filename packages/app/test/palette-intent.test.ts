import * as intentResolver from '../src/ai/palette-intent';
import { appHostCommands } from '../src/host';
import { Store } from '../src/store';
import type { WorkerTransport } from '../src/worker-transport';
import { HOST_COMMANDS, Registry, type EngineSchema } from '@femlab/registry';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../registry/src/generated/engine.schema.json';
import { fakeHost, fakeTransport } from '../../registry/test/fakes';
import { resolvePaletteIntent } from '../src/ai/palette-intent';
import type { ChatRequest, Provider } from '../src/ai/provider';

function setup(answer: unknown) {
  const transport = fakeTransport();
  const registry = new Registry({ schema: schema as unknown as EngineSchema, host: fakeHost(transport), hostCommands: HOST_COMMANDS });
  let request!: ChatRequest;
  const provider: Provider = {
    id: 'anthropic',
    models: ['fake'],
    async *chat(input) {
      request = input;
      yield { type: 'tool_use', id: 'preview', name: 'prepare_preview', input: answer };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
  return { registry, transport, provider, request: () => request };
}

describe('palette intent resolution', () => {
  it('uses the actual registry schemas and object names to preview parameters without executing', async () => {
    const f = setup({
      proposals: [{ command: 'load.pressure', argsJson: JSON.stringify({ name: 'bearing-load', on: 'bearing_top', value: '2.4 MPa' }) }],
      clarification: '',
    });
    const result = await resolvePaletteIntent(
      'apply 2.4 MPa to @set:bearing_top',
      f.registry,
      [{ ref: 'set:bearing_top', kind: 'set', name: 'bearing_top', summary: 'bearing top face' }],
      f.provider,
    );
    expect(result.proposals).toEqual([{ command: 'load.pressure', args: { name: 'bearing-load', on: 'bearing_top', value: '2.4 MPa' }, missing: [] }]);
    expect(f.request().system).toContain('bearing top face');
    expect(f.request().system).toContain('"command":"load.pressure"');
    expect(f.request().system).toContain('"parameters"');
    expect(f.transport.dispatch).not.toHaveBeenCalled();
  });

  it('supports unrelated intents and keeps ambiguity and missing parameters in the preview', async () => {
    const f = setup({
      proposals: [
        { command: 'step.add', argsJson: '{"procedure":"heat"}' },
        { command: 'constraint.temperature', argsJson: '{"name":"hot"}' },
      ],
      clarification: 'Create a heat Step, or set a boundary temperature? Which target and temperature?',
    });
    const result = await resolvePaletteIntent('set up heating', f.registry, [], f.provider);
    expect(result.proposals.map((p) => p.command)).toEqual(['step.add', 'constraint.temperature']);
    expect(result.proposals[0]!.missing).toContain('name');
    expect(result.proposals[1]!.missing).toContain('on');
    expect(result.clarification).toContain('Which target');
    expect(f.transport.dispatch).not.toHaveBeenCalled();
  });

  it('handles unsupported requests and rejects invented commands, parameters and malformed payloads', async () => {
    const unsupported = setup({ proposals: [], clarification: 'This capability is not in the registry.' });
    expect((await resolvePaletteIntent('simulate quantum gravity', unsupported.registry, [], unsupported.provider)).proposals).toEqual([]);
    for (const proposal of [
      { command: 'invented.run', argsJson: '{}' },
      { command: 'load.pressure', argsJson: '{"secret":true}' },
      { command: 'load.pressure', argsJson: '{"cmd":"model.new"}' },
      { command: 'load.pressure', argsJson: '[]' },
      { command: 'load.pressure', argsJson: 'not json' },
    ]) {
      const f = setup({ proposals: [proposal], clarification: '' });
      await expect(resolvePaletteIntent('do something', f.registry, [], f.provider)).rejects.toThrow();
      expect(f.transport.dispatch).not.toHaveBeenCalled();
    }
  });

  it('uses provider prose as a clarification without pretending a command was found', async () => {
    const f = setup(null);
    const provider: Provider = {
      id: 'openai',
      models: ['fake'],
      async *chat() {
        yield { type: 'text_delta', text: 'Which face should carry the load?' };
        yield { type: 'done', stopReason: 'end_turn' };
      },
    };
    expect(await resolvePaletteIntent('apply pressure', f.registry, [], provider)).toEqual({
      proposals: [],
      clarification: 'Which face should carry the load?',
    });
  });
});

it('the registered intent command keeps the newest response and never dispatches proposed Commands', async () => {
  const store = new Store();
  const transport = fakeTransport();
  let registry!: Registry;
  registry = new Registry({
    schema: schema as unknown as EngineSchema,
    host: fakeHost(transport),
    hostCommands: [
      ...HOST_COMMANDS,
      ...appHostCommands(
        store,
        transport as unknown as WorkerTransport,
        { current: null },
        async () => undefined,
        undefined,
        () => registry,
      ),
    ],
  });
  let first!: (value: { proposals: []; clarification: string }) => void;
  const pending = new Promise<{ proposals: []; clarification: string }>((resolve) => {
    first = resolve;
  });
  const resolve = vi
    .spyOn(intentResolver, 'resolvePaletteIntent')
    .mockImplementationOnce(() => pending)
    .mockResolvedValueOnce({ proposals: [], clarification: 'Second answer' });
  try {
    const one = registry.dispatch({ cmd: 'palette.resolve', text: 'first request' });
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    await registry.dispatch({ cmd: 'palette.resolve', text: 'second request' });
    first({ proposals: [], clarification: 'Old answer' });
    await one;
    expect(store.state.paletteIntent?.text).toBe('second request');
    expect(store.state.paletteIntent?.clarification).toBe('Second answer');
    expect(registry.describe('palette.resolve').tool).toBe(false);
    expect(transport.dispatch).not.toHaveBeenCalled();
  } finally {
    resolve.mockRestore();
  }
});
