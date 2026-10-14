import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type { Command, DocumentSnapshot, ExecutionContext, RunLease, Stamp, WriteReply, WriteRequest } from '@femlab/registry';
import { MAX_MODEL_FILE_BYTES, modelFileEncoder, modelFileText } from '@femlab/registry';

const { SessionEngine, PreparedEngine } = createRequire(import.meta.url)('../../../tools/wasm-node/femlab_engine_wasm.js') as typeof import('../src/generated/wasm/femlab_engine_wasm');
type Owner = InstanceType<typeof SessionEngine>;
type Prepared = Awaited<ReturnType<typeof PreparedEngine.create>>;

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


describe('prepared WASM replacement', () => {
  it.each([false, true])('checks actual UTF-8 host text before commit, with trailing LF %s', async trailingNewline => {
    for (const margin of [-1, 0, 1]) {
      const owner = new SessionEngine(1, `wasm-size-${trailingNewline}-${margin}`);
      let candidate: Prepared | undefined;
      try {
        const ui = new Client(owner);
        await ui.write({ ...fresh, name: 'quote " slash \\ newline\n snow ☃ rocket 🚀' });
        await ui.write(box);
        await ui.write({ cmd: 'material.add', name: 'large_modulus', E: '1e20 Pa', nu: 0.3 });
        const before = ui.snapshot();
        const text = modelFileText(before.file, trailingNewline);
        const bytes = new TextEncoder().encode(text).byteLength;
        expect(bytes).toBeGreaterThan(text.length);
        expect(text).toContain('100000000000000000000');
        const request = ui.prepare(fresh);
        const ticket = owner.begin_replacement(JSON.stringify(request.context), request.expectedVersion);
        candidate = await PreparedEngine.create(ticket, { gpu: false, threads: 1 });
        await candidate.file(JSON.stringify(before.file));
        const encode = vi.fn(modelFileEncoder(trailingNewline));
        if (margin < 0) {
          expect(() => candidate!.finish(encode, bytes + margin)).toThrow();
          expect(() => candidate!.finish(encode, MAX_MODEL_FILE_BYTES)).toThrow();
          const consumed = candidate; candidate = undefined;
          expect(() => owner.commit_candidate(consumed)).toThrow();
          expect(ui.snapshot()).toEqual(before);
          owner.abandon_replacement(ticket);
          await ui.write(remove); // failure released admission for the existing producer
        } else {
          const ready = JSON.parse(candidate.finish(encode, bytes + margin)) as DocumentSnapshot;
          expect(modelFileText(ready.file, trailingNewline)).toBe(text);
          const saved = JSON.parse(text);
          expect(saved).toEqual(ready.file);
          const consumed = candidate; candidate = undefined;
          ui.lease.stamp = JSON.parse(owner.commit_candidate(consumed)).stamp;
          const reopenRequest = ui.prepare(fresh);
          const reopenTicket = owner.begin_replacement(JSON.stringify(reopenRequest.context), reopenRequest.expectedVersion);
          candidate = await PreparedEngine.create(reopenTicket, { gpu: false, threads: 1 });
          await candidate.file(text);
          candidate.finish(modelFileEncoder(trailingNewline), bytes + margin);
          const reopenedCandidate = candidate; candidate = undefined;
          const reopened = JSON.parse(owner.commit_candidate(reopenedCandidate)) as DocumentSnapshot;
          expect(reopened.file).toEqual(before.file);
        }
        expect(encode).toHaveBeenCalledOnce();
        expect(JSON.parse(encode.mock.calls[0]![0])).toEqual(before.file);
      } finally { candidate?.free(); owner.free(); }
    }
  });

  it.each(['throw', 'non-string'])('consumes an encoder %s failure before publication or fake I/O', async mode => {
    const owner = new SessionEngine(1, `wasm-encoder-${mode}`);
    const ui = new Client(owner);
    await ui.write(box);
    const before = ui.snapshot();
    const request = ui.prepare(fresh);
    const ticket = owner.begin_replacement(JSON.stringify(request.context), request.expectedVersion);
    let candidate: Prepared | undefined = await PreparedEngine.create(ticket, { gpu: false, threads: 1 });
    try {
      await candidate.commands(JSON.stringify([fresh]));
      const encode = vi.fn(() => { if (mode === 'throw') throw new Error('injected encoder failure'); return 42; });
      const write = vi.fn();
      expect(() => { candidate!.finish(encode, MAX_MODEL_FILE_BYTES); write(); }).toThrow();
      expect(encode).toHaveBeenCalledOnce();
      expect(write).not.toHaveBeenCalled();
      expect(() => candidate!.finish(modelFileEncoder(), MAX_MODEL_FILE_BYTES)).toThrow();
      const consumed = candidate; candidate = undefined;
      expect(() => owner.commit_candidate(consumed)).toThrow();
      expect(ui.snapshot()).toEqual(before);
      owner.abandon_replacement(ticket);
      await ui.write(remove);
      expect(ui.snapshot().file.model.bodies).toEqual([]);
    } finally { candidate?.free(); owner.free(); }
  });

  it.each([NaN, Infinity, -1, 0.5, 2 ** 32])('consumes invalid host byte budget %s without calling its encoder', async budget => {
    const owner = new SessionEngine(1, 'wasm-budget');
    const ui = new Client(owner);
    const before = ui.snapshot();
    const request = ui.prepare(fresh);
    const ticket = owner.begin_replacement(JSON.stringify(request.context), request.expectedVersion);
    let candidate: Prepared | undefined = await PreparedEngine.create(ticket, { gpu: false, threads: 1 });
    try {
      const encode = vi.fn(modelFileEncoder());
      expect(() => candidate!.finish(encode, budget)).toThrow();
      expect(encode).not.toHaveBeenCalled();
      const consumed = candidate; candidate = undefined;
      expect(() => owner.commit_candidate(consumed)).toThrow();
      expect(ui.snapshot()).toEqual(before);
      owner.abandon_replacement(ticket);
    } finally { candidate?.free(); owner.free(); }
  });

  it('keeps the active model after replay or parse failure and refuses a partial commit', async () => {
    const owner = new SessionEngine(1, 'wasm-candidate-failure');
    const ui = new Client(owner);
    await ui.write(fresh); await ui.write(box);
    const before = ui.snapshot();
    const request = ui.prepare(fresh);
    const ticket = owner.begin_replacement(JSON.stringify(request.context), request.expectedVersion);
    const failed = await PreparedEngine.create(ticket, { gpu: false, threads: 1 });
    await expect(failed.commands(JSON.stringify([fresh, box, { cmd: 'geometry.remove', name: 'missing' }]))).rejects.toMatchObject({ code: 'not-found' });
    expect(() => failed.finish(modelFileEncoder(), MAX_MODEL_FILE_BYTES)).toThrow();
    expect(ui.snapshot()).toEqual(before);
    failed.free();
    const malformed = await PreparedEngine.create(ticket, { gpu: false, threads: 1 });
    await malformed.commands(JSON.stringify([fresh]));
    await expect(malformed.file('{bad json')).rejects.toMatchObject({ code: 'schema' });
    expect(() => malformed.finish(modelFileEncoder(), MAX_MODEL_FILE_BYTES)).toThrow();
    expect(() => owner.commit_candidate(malformed)).toThrow();
    owner.abandon_replacement(ticket);
    expect(ui.snapshot()).toEqual(before);
    owner.free();
  });

  it('publishes a validated file as one fresh session and rejects mismatched snapshots', async () => {
    const owner = new SessionEngine(1, 'wasm-candidate-success');
    const ui = new Client(owner);
    await ui.write(fresh); await ui.write(box);
    const old = new Client(owner);
    const saved = ui.snapshot().file;
    const request = ui.prepare(fresh);
    const ticket = owner.begin_replacement(JSON.stringify(request.context), request.expectedVersion);
    const wrong = await PreparedEngine.create(ticket, { gpu: false, threads: 1 });
    await expect(wrong.file(JSON.stringify({ ...saved, model: { ...saved.model, name: 'unrecorded change' } }))).rejects.toMatchObject({ code: 'schema' });
    wrong.free();
    const candidate = await PreparedEngine.create(ticket, { gpu: false, threads: 1 });
    await candidate.file(JSON.stringify(saved));
    const ready = JSON.parse(candidate.finish(modelFileEncoder(), MAX_MODEL_FILE_BYTES)) as DocumentSnapshot;
    expect(ui.snapshot().stamp).not.toEqual(ready.stamp);
    const published = JSON.parse(owner.commit_candidate(candidate)) as DocumentSnapshot;
    expect(published).toEqual(ready);
    expect(published.file).toEqual(saved);
    expect(() => old.snapshot()).toThrow();
    ui.lease.stamp = published.stamp;
    await ui.write(remove);
    expect(ui.snapshot().file.model.bodies).toHaveLength(0);
    owner.free();
  });

  it('rejects a ready candidate after cancellation and preserves the old session', async () => {
    const owner = new SessionEngine(1, 'wasm-candidate-cancel');
    const ui = new Client(owner);
    await ui.write(box);
    const before = ui.snapshot();
    const request = ui.prepare(fresh);
    const ticket = owner.begin_replacement(JSON.stringify(request.context), request.expectedVersion);
    const candidate = await PreparedEngine.create(ticket, { gpu: false, threads: 1 });
    await candidate.journal(JSON.stringify(before.file.journal.entries), true);
    candidate.finish(modelFileEncoder(), MAX_MODEL_FILE_BYTES);
    owner.cancel_run(JSON.stringify(ui.lease.stamp.session), ui.lease.runId);
    expect(() => owner.commit_candidate(candidate)).toThrow();
    expect(new Client(owner).snapshot()).toEqual(before);
    owner.free();
  });
});
