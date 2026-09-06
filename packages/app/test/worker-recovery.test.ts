// @vitest-environment node
// The worker boundary is controllable, but all acknowledgements, journals, undo/redo and
// replay come from the real Rust/wasm engine built by CI's wasm-hash job.
import { createRequire } from 'node:module';
import type { Command } from '@femlab/registry';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppReq, AppRes } from '../src/protocol';
import { toStructured } from '../src/protocol';
import { restoreHistory } from '../src/recovery';
import { WorkerTransport } from '../src/worker-transport';

const { Engine } = createRequire(import.meta.url)('../../../tools/wasm-node/femlab_engine_wasm.js') as typeof import('../src/generated/wasm/femlab_engine_wasm.js');

class EngineWorker {
  onmessage: ((event: MessageEvent<AppRes>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  sent: AppReq[] = [];
  holdSolve = false;
  private engine?: InstanceType<typeof Engine>;
  private terminated = false;

  postMessage(req: AppReq): void {
    this.sent.push(req);
    void this.handle(req).then(
      (value) => this.reply({ id: req.id, ok: true, value }),
      (error: unknown) => this.reply({ id: req.id, ok: false, error: toStructured(error) }),
    );
  }
  terminate(): void {
    this.terminated = true;
    this.engine?.free();
    this.engine = undefined;
  }
  private reply(data: AppRes): void {
    if (!this.terminated) this.onmessage?.({ data } as MessageEvent<AppRes>);
  }
  private async handle(req: AppReq): Promise<unknown> {
    if (req.op === 'create') {
      this.engine = await Engine.create({ gpu: false, threads: 1 });
      return { engineVersion: 'test' };
    }
    const engine = this.engine!;
    switch (req.op) {
      case 'dispatch':
        if (this.holdSolve && (req.payload as Command).cmd === 'solve.run') return new Promise(() => undefined);
        return JSON.parse(await engine.dispatch(JSON.stringify(req.payload), undefined));
      case 'query': return JSON.parse(engine.query(JSON.stringify(req.payload)));
      case 'exportFile': return JSON.parse(engine.export_file());
      case 'replay': {
        const { entries, revision } = req.payload as { entries: unknown[]; revision: number };
        await restoreHistory(engine, entries, revision);
        return { revision: engine.revision(), hash: engine.model_hash() };
      }
      default: throw new Error(`unexpected operation ${req.op}`);
    }
  }
}

const workers: EngineWorker[] = [];
afterEach(() => { for (const worker of workers.splice(0)) worker.terminate(); });

async function model() {
  const transport = new WorkerTransport(() => {
    const worker = new EngineWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  }, { gpu: false, threads: 1 });
  await transport.init();
  for (const cmd of [
    { cmd: 'model.new', name: 'recovery' },
    { cmd: 'geometry.addBox', name: 'b', size: ['1 m', '1 m', '1 m'] },
    { cmd: 'mesh.set', mesher: { kind: 'lattice', size: '1 m' } },
  ] as Command[]) await transport.dispatch(cmd);
  return transport;
}

async function cancelSolve(transport: WorkerTransport) {
  const old = workers.at(-1)!;
  old.holdSolve = true;
  const solving = transport.dispatch({ cmd: 'solve.run', step: 'pending' }).catch((error: unknown) => error);
  // Wait for the Worker to receive the operation, leaving it deliberately unacknowledged.
  await Promise.resolve();
  expect(old.sent.at(-1)).toMatchObject({ op: 'dispatch', payload: { cmd: 'solve.run' } });
  const queued = transport.dispatch({ cmd: 'model.rename', kind: 'body', name: 'b', to: 'unacknowledged' }).catch((error: unknown) => error);
  const cancelled = transport.cancel();
  // This query must run after both create and replay, even though cancel has yielded.
  const journal = transport.query({ query: 'query.journal' });
  await cancelled;
  expect(await solving).toMatchObject({ code: 'cancelled' });
  expect(await queued).toMatchObject({ code: 'cancelled' });
  return journal;
}

describe('cancel recovery with real engine acknowledgements', () => {
  it.each([false, true])('preserves the active Journal and redo state (redo before cancel: %s)', async (redo) => {
    const transport = await model();
    const undone = await transport.dispatch({ cmd: 'journal.undo' });
    expect(undone.seq).toBe(undone.revision);
    expect(undone.seq).toBe(2);
    if (redo) {
      const redone = await transport.dispatch({ cmd: 'journal.redo' });
      expect(redone.seq).toBe(redone.revision);
    }
    const before = await transport.exportFile();
    const journal = await transport.query({ query: 'query.journal' });
    expect(await cancelSolve(transport)).toEqual(journal);
    expect(await transport.exportFile()).toEqual(before);
    if (!redo) {
      await transport.dispatch({ cmd: 'journal.redo' });
      expect((await transport.exportFile()).journal.entries.at(-1)!.cmd.cmd).toBe('mesh.set');
    }
  });

  it('records mesh exports and truncates a redo tail when a new command is acknowledged', async () => {
    const transport = await model();
    const exported = await transport.export({ format: 'vtu' });
    expect(exported.filename).toBe('recovery.vtu');
    expect(exported.bytes.byteLength).toBeGreaterThan(0);
    expect(workers[0]!.sent.at(-1)).toMatchObject({ op: 'dispatch', payload: { cmd: 'mesh.export' } });
    await transport.dispatch({ cmd: 'journal.undo' });
    await transport.dispatch({ cmd: 'journal.redo' });
    await transport.dispatch({ cmd: 'model.rename', kind: 'body', name: 'b', to: 'renamed' });
    const before = await transport.exportFile();
    const journal = await transport.query({ query: 'query.journal' });
    expect(before.journal.entries.map((entry) => entry.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(before.journal.entries[3]!.cmd.cmd).toBe('mesh.export');
    expect(await cancelSolve(transport)).toEqual(journal);
    expect(await transport.exportFile()).toEqual(before);
    await transport.dispatch({ cmd: 'journal.undo' });
    await transport.dispatch({ cmd: 'model.rename', kind: 'body', name: 'b', to: 'replacement' });
    const branched = await transport.exportFile();
    await cancelSolve(transport);
    expect(await transport.exportFile()).toEqual(branched);
    await expect(transport.dispatch({ cmd: 'journal.redo' })).rejects.toMatchObject({ code: 'not-found' });
  });

  it('keeps undo/redo snapshots aligned when acknowledged solves are skipped during recovery', async () => {
    const transport = await model();
    for (const cmd of [
      { cmd: 'material.add', name: 'steel', E: '210 GPa', nu: 0.3 },
      { cmd: 'material.assign', material: 'steel', bodies: ['b'] },
      { cmd: 'constraint.fix', name: 'root', on: 'b.xmin' },
      { cmd: 'load.traction', name: 'tip', on: 'b.xmax', total: ['0 N', '0 N', '-1 N'] },
      { cmd: 'step.add', name: 'static', procedure: 'static', constraints: ['root'], loads: ['tip'] },
      { cmd: 'solve.run', step: 'static' },
      { cmd: 'model.rename', kind: 'body', name: 'b', to: 'renamed' },
    ] as Command[]) await transport.dispatch(cmd);
    const complete = await transport.exportFile();
    await transport.dispatch({ cmd: 'journal.undo', steps: 2 });
    const before = await transport.exportFile();
    const journal = await transport.query({ query: 'query.journal' });
    expect(await cancelSolve(transport)).toEqual(journal);
    expect(await transport.exportFile()).toEqual(before);
    await transport.dispatch({ cmd: 'journal.redo', steps: 2 });
    expect(await transport.exportFile()).toEqual(complete);
  });
});
