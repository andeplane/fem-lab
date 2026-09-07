import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { Command, DocumentSnapshot, ExecutionContext, RunLease, Stamp, WriteReply, WriteRequest } from '@femlab/registry';

const { SessionEngine } = createRequire(import.meta.url)('../../../tools/wasm-node/femlab_engine_wasm.js') as typeof import('../src/generated/wasm/femlab_engine_wasm');
type Owner = InstanceType<typeof SessionEngine>;

class Client {
  lease: RunLease;
  private sequence = 0;
  constructor(private readonly owner: Owner) {
    const stamp = JSON.parse(owner.stamp()) as Stamp;
    this.lease = JSON.parse(owner.begin_run(JSON.stringify(stamp.session))) as RunLease;
  }
  context(): ExecutionContext {
    return { session: this.lease.stamp.session, runId: this.lease.runId, operationId: String(this.sequence) };
  }
  prepare(command: Command): WriteRequest {
    this.sequence++;
    return structuredClone({ context: this.context(), expectedVersion: this.lease.stamp.stateVersion, command });
  }
  async write(command: Command): Promise<WriteReply> {
    const reply = JSON.parse(await this.owner.dispatch(JSON.stringify(this.prepare(command)), undefined)) as WriteReply;
    this.lease.stamp = reply.stamp;
    return reply;
  }
  snapshot(): DocumentSnapshot { return JSON.parse(this.owner.snapshot(JSON.stringify(this.context()))) as DocumentSnapshot; }
}
const fresh: Command = { cmd: 'model.new', name: 'same-name' };
const box: Command = { cmd: 'geometry.addBox', name: 'shared', size: ['1 m', '1 m', '1 m'] };
const remove: Command = { cmd: 'geometry.remove', name: 'shared' };

describe('checked WASM owner', () => {
  it('rejects a retained producer after another session creates the same named body', async () => {
    const owner = new SessionEngine(1, 'wasm-test');
    try {
      const ui = new Client(owner);
      await ui.write(fresh); await ui.write(box);
      const old = new Client(owner);
      const queued = old.prepare(remove);
      await ui.write(fresh); await ui.write(box);
      const before = ui.snapshot();
      await expect(owner.dispatch(JSON.stringify(queued), undefined)).rejects.toMatchObject({ code: 'session.expired' });
      expect(ui.snapshot()).toEqual(before);
      expect(() => old.snapshot()).toThrow();
      expect(before.file.journal.entries.map(e => e.cmd.cmd)).toEqual(['model.new', 'geometry.addBox']);
      expect(before.model.hash).toBe(before.file.journal.entries.at(-1)!.hashAfter);
    } finally { owner.free(); }
  });

  it('allows only explicit initiating transitions, rejects conflicts, and makes retries idempotent', async () => {
    const owner = await SessionEngine.create({ gpu: false, threads: 1 }, 'wasm-transition');
    try {
      const a = new Client(owner);
      await a.write(fresh);
      const b = new Client(owner);
      const pending = b.prepare(box);
      await a.write(box);
      const before = a.snapshot();
      await expect(owner.dispatch(JSON.stringify(pending), undefined)).rejects.toMatchObject({ code: 'session.conflict' });
      expect(a.snapshot()).toEqual(before);
      const request = a.prepare(remove);
      const raw = await owner.dispatch(JSON.stringify(request), undefined);
      expect(await owner.dispatch(JSON.stringify(request), undefined)).toBe(raw);
      await expect(owner.dispatch(JSON.stringify({ ...request, command: box }), undefined)).rejects.toMatchObject({ code: 'operation.reused' });
      owner.cancel_run(JSON.stringify(b.lease.stamp.session), b.lease.runId);
      await expect(owner.dispatch(JSON.stringify(b.prepare(remove)), undefined)).rejects.toMatchObject({ code: 'cancelled' });
      await expect(owner.dispatch(JSON.stringify(box), undefined)).rejects.toMatchObject({ code: 'schema' });
      const reply = JSON.parse(owner.query(JSON.stringify({ context: a.context(), query: { query: 'query.model' } }))) as { stamp: Stamp; value: { bodies: unknown[] } };
      expect(reply.value.bodies).toHaveLength(0);
      expect(reply.stamp.stateVersion).not.toBe(before.stamp.stateVersion);
    } finally { owner.free(); }
  });
});
