import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';
import type { Command } from '@femlab/registry';
import { SessionRuntime } from '../src/session-runtime';
import { SessionWorkspace } from '../src/session-workspace';
import type { SessionRequest, SessionResponse } from '../src/session-protocol';

const wasm = createRequire(import.meta.url)('../../../tools/wasm-node/femlab_engine_wasm.js') as typeof import('../src/generated/wasm/femlab_engine_wasm');
class RecoveryWorker {
  onmessage: ((event: MessageEvent<SessionResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private engine: InstanceType<typeof wasm.SessionEngine> | undefined;
  private runtime = new SessionRuntime(async (options, epoch) => this.engine = new wasm.SessionEngine(options.threads, epoch), (ticket, options) => wasm.PreparedEngine.create(ticket, options), () => 0);
  postMessage(request: SessionRequest): void { void this.runtime.accept(structuredClone(request), reply => this.onmessage?.({ data: structuredClone(reply) } as MessageEvent<SessionResponse>)); }
  terminate(): void { this.engine?.free(); this.engine = undefined; }
}
function setup() {
  const workers: RecoveryWorker[] = [];
  const workspace = new SessionWorkspace({
    spawn: () => { const worker = new RecoveryWorker(); workers.push(worker); return worker as unknown as Worker; },
    epoch: () => `legacy-project-${workers.length}`, engine: { gpu: false, threads: 1 },
    build: async (_transport, initial) => ({ initial, dispose: vi.fn() }), publish: vi.fn(),
  });
  return { workspace, close: () => { for (const worker of workers) worker.terminate(); } };
}

it('reconstructs legacy project inputs and Journal while skipping every historical solve and study', async () => {
  const h = setup();
  try {
    const { transport } = await h.workspace.start();
    const commands: Command[] = [
      { cmd: 'model.setName', name: 'recovered legacy inputs' },
      { cmd: 'geometry.addBox', name: 'retained_body', size: ['1 m', '2 m', '3 m'] },
      { cmd: 'material.add', name: 'retained_steel', E: '210 GPa', nu: 0.3 },
      { cmd: 'material.assign', material: 'retained_steel', bodies: ['retained_body'] },
      { cmd: 'solve.run', step: 'intentionally_missing', solver: 'gpu-pcg' },
      { cmd: 'study.adapt', step: 'intentionally_missing', targetError: 0.1, refinements: [] },
    ];
    // The same history cannot be computed: successful recovery must omit numerical work.
    await expect(transport.replaceWith({ kind: 'commands', commands })).rejects.toThrow();
    const restored = await transport.replaceWith({ kind: 'legacy-project', commands });
    expect(h.workspace.active.initial.model.name).toBe('recovered legacy inputs');
    expect(h.workspace.active.initial.model.bodies).toHaveLength(1);
    expect(h.workspace.active.initial.file.model.materials).toHaveLength(1);
    expect(h.workspace.active.initial.file.journal.entries.map(entry => entry.cmd)).toEqual(commands);
    expect(await restored.query({ query: 'query.results' })).toMatchObject({ records: [] });
    expect(await restored.query({ query: 'query.journal' })).toMatchObject({ entries: commands.map(cmd => expect.objectContaining({ cmd })) });
  } finally { h.close(); }
});

it('still validates non-numerical legacy inputs and preserves the current owner on failure', async () => {
  const h = setup();
  try {
    const { transport } = await h.workspace.start(); await transport.dispatch({ cmd: 'model.setName', name: 'preserved owner' });
    const before = await transport.snapshot();
    await expect(transport.replaceWith({ kind: 'legacy-project', commands: [{ cmd: 'geometry.addBox', name: 'invalid', size: ['-1 m', '1 m', '1 m'] }] })).rejects.toThrow();
    expect(await transport.snapshot()).toEqual(before); expect(h.workspace.active.transport).toBe(transport);
  } finally { h.close(); }
});
