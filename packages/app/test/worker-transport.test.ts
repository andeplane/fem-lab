// The worker protocol without a worker: a fake that records what was posted and answers with
// hand-written `Res` frames, so the encode/decode, the in-flight queue and cancel-by-replay are
// all testable in node.
import type { Ack, Command } from '@femlab/registry';
import { FemError } from '@femlab/registry';
import { describe, expect, it, vi } from 'vitest';
import type { AppReq, AppRes } from '../src/protocol';
import { toStructured } from '../src/protocol';
import { WorkerTransport } from '../src/worker-transport';

class FakeWorker {
  onmessage: ((e: MessageEvent<AppRes>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  readonly sent: AppReq[] = [];
  terminated = false;
  /** Answers queued by op; anything unanswered stays in flight. */
  answer: (req: AppReq, reply: (res: AppRes, raw?: ArrayBuffer[]) => void) => void = () => undefined;

  postMessage(req: AppReq): void {
    this.sent.push(req);
    this.answer(req, (res, raw) => this.onmessage?.({ data: raw ? { ...res, raw } : res } as MessageEvent<AppRes>));
  }
  terminate(): void {
    this.terminated = true;
  }
}

const ack = (over: Partial<Ack> = {}): Ack => ({ seq: 0, revision: 1, hash: 'h0', warnings: [], output: { kind: 'none' } as unknown as Ack['output'], ...over });

function make(answer: FakeWorker['answer']) {
  const workers: FakeWorker[] = [];
  const transport = new WorkerTransport(() => {
    const w = new FakeWorker();
    w.answer = answer;
    workers.push(w);
    return w as unknown as Worker;
  }, { gpu: true, threads: 4 });
  return { transport, workers };
}

const ok = (id: number, value: unknown): AppRes => ({ id, ok: true, value });

describe('WorkerTransport', () => {
  it('boots the engine with the host capabilities it was given', async () => {
    const { transport, workers } = make((req, reply) => reply(ok(req.id, { engineVersion: '0.1.0' })));
    await expect(transport.init()).resolves.toEqual({ engineVersion: '0.1.0' });
    expect(workers[0]!.sent[0]).toMatchObject({ op: 'create', payload: { gpu: true, threads: 4 } });
  });

  it('routes progress frames to the caller and still resolves with the Ack', async () => {
    const { transport } = make((req, reply) => {
      if (req.op !== 'dispatch') return reply(ok(req.id, null));
      reply({ id: req.id, progress: { phase: 'assemble', fraction: 0.5 } });
      reply(ok(req.id, ack()));
    });
    const seen: string[] = [];
    const a = await transport.dispatch({ cmd: 'model.new', name: 'x' } as unknown as Command, (p) => seen.push(p.phase));
    expect(seen).toEqual(['assemble']);
    expect(a.hash).toBe('h0');
  });

  it('rebuilds typed arrays from a bulk reply', async () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Uint32Array([0, 1, 2]);
    const { transport } = make((req, reply) =>
      reply(
        {
          id: req.id,
          ok: true,
          value: { faceNames: ['b.top'], bodyNames: ['b'], source: 'geometry' },
          buffers: [
            { name: 'positions', dtype: 'f32', length: 9 },
            { name: 'indices', dtype: 'u32', length: 3 },
            { name: 'triFace', dtype: 'u32', length: 1 },
            { name: 'triBody', dtype: 'u32', length: 1 },
          ],
        },
        [positions.buffer as ArrayBuffer, indices.buffer as ArrayBuffer, new Uint32Array([0]).buffer, new Uint32Array([0]).buffer],
      ),
    );
    const s = await transport.surface();
    expect(Array.from(s.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(s.faceNames[s.triFace[0]!]).toBe('b.top');
    expect(s.source).toBe('geometry');
  });

  it('rejects with the engine\'s structured error, not a string', async () => {
    const { transport } = make((req, reply) => reply({ id: req.id, ok: false, error: { code: 'name.taken', cause: "a body is already called 'beam'", where: 'name', suggestion: 'pick another name' } }));
    await expect(transport.query({ query: 'query.model' })).rejects.toBeInstanceOf(FemError);
    await expect(transport.query({ query: 'query.model' })).rejects.toMatchObject({ code: 'name.taken', where: 'name' });
  });

  it('runs one call at a time, even after one of them fails', async () => {
    const pending: (() => void)[] = [];
    const { transport, workers } = make((req, reply) => {
      pending.push(() => (req.id % 2 === 0 ? reply({ id: req.id, ok: false, error: { code: 'internal', cause: 'no', where: null, suggestion: null } }) : reply(ok(req.id, ack({ seq: req.id })))));
    });
    const calls = [transport.query({ query: 'query.model' }), transport.query({ query: 'query.journal' }), transport.query({ query: 'query.script' })].map((p) => p.catch(() => 'failed'));
    await Promise.resolve();
    expect(workers[0]!.sent).toHaveLength(1);
    while (pending.length > 0) {
      pending.shift()!();
      await new Promise((r) => setTimeout(r, 0));
    }
    await Promise.all(calls);
    expect(workers[0]!.sent).toHaveLength(3);
  });

  it('cancels by killing the worker and replaying the Journal it has acknowledged', async () => {
    const { transport, workers } = make((req, reply) => reply(ok(req.id, req.op === 'dispatch' ? ack({ seq: (req.payload as { seq?: number }).seq ?? 0, revision: ((req.payload as { seq?: number }).seq ?? 0) + 1 }) : null)));
    await transport.dispatch({ cmd: 'model.new', name: 'x', seq: 0 } as unknown as Command);
    await transport.dispatch({ cmd: 'geometry.addBox', name: 'b', seq: 1 } as unknown as Command);
    await transport.cancel();

    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    const [create, replay] = workers[1]!.sent;
    expect(create).toMatchObject({ op: 'create', payload: { gpu: true, threads: 4 } });
    expect(replay!.op).toBe('replay');
    expect((replay!.payload as { entries: { cmd: Command }[] }).entries.map((e) => (e.cmd as unknown as { cmd: string }).cmd)).toEqual(['model.new', 'geometry.addBox']);
  });

  it('replays only up to the revision an undo left behind, keeping the entries a redo needs', async () => {
    const { transport, workers } = make((req, reply) => {
      const p = req.payload as { cmd?: string; seq?: number };
      if (req.op !== 'dispatch') return reply(ok(req.id, null));
      if (p.cmd === 'journal.undo') return reply(ok(req.id, ack({ seq: -1, revision: 1 })));
      return reply(ok(req.id, ack({ seq: p.seq ?? 0, revision: (p.seq ?? 0) + 1 })));
    });
    await transport.dispatch({ cmd: 'model.new', name: 'x', seq: 0 } as unknown as Command);
    await transport.dispatch({ cmd: 'geometry.addBox', name: 'b', seq: 1 } as unknown as Command);
    await transport.dispatch({ cmd: 'journal.undo' } as unknown as Command);
    await transport.cancel();
    expect((workers[1]!.sent[1]!.payload as { entries: unknown[] }).entries).toHaveLength(1);
  });

  it('restarts the engine after a wasm panic, reports it once, and keeps working', async () => {
    const panic = 'recursive use of an object detected which would lead to unsafe aliasing in rust';
    let crashes = 0;
    const { transport, workers } = make((req, reply) => {
      // `mesh.set` panics inside wasm: once as a Worker that throws, once as the structured
      // error the Worker reports when it catches the panic itself. Both poison the Engine.
      if (req.op === 'dispatch' && (req.payload as { cmd: string }).cmd === 'mesh.set' && crashes < 2) {
        crashes += 1;
        if (crashes === 1) throw new Error(panic);
        return reply({ id: req.id, ok: false, error: { code: 'internal', cause: panic, where: null, suggestion: null } });
      }
      reply(ok(req.id, req.op === 'dispatch' ? ack({ seq: (req.payload as { seq?: number }).seq ?? 0, revision: ((req.payload as { seq?: number }).seq ?? 0) + 1 }) : null));
    });
    await transport.dispatch({ cmd: 'model.new', name: 'x', seq: 0 } as unknown as Command);
    const boom = transport.dispatch({ cmd: 'mesh.set', seq: 1 } as unknown as Command);
    await expect(boom).rejects.toBeInstanceOf(FemError);
    await expect(boom).rejects.toMatchObject({ code: 'internal', where: 'engine.worker' });
    await expect(boom).rejects.toMatchObject({ cause: `the engine restarted after a crash: ${panic}` });

    // a fresh Worker, booted and replayed up to the Command that was acknowledged
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    const [create, replay] = workers[1]!.sent;
    expect(create).toMatchObject({ op: 'create', payload: { gpu: true, threads: 4 } });
    expect((replay!.payload as { entries: { cmd: Command }[] }).entries.map((e) => (e.cmd as unknown as { cmd: string }).cmd)).toEqual(['model.new']);

    // the same panic reported as a structured error restarts the engine just as well
    const again = transport.dispatch({ cmd: 'mesh.set', seq: 1 } as unknown as Command);
    await expect(again).rejects.toMatchObject({ code: 'internal', cause: `the engine restarted after a crash: ${panic}` });
    expect(workers).toHaveLength(3);

    // and the next Command goes through on the new Worker
    await expect(transport.dispatch({ cmd: 'geometry.addBox', name: 'b', seq: 1 } as unknown as Command)).resolves.toMatchObject({ revision: 2 });
    expect(workers).toHaveLength(3);
  });

  it('fails every in-flight call when the worker itself dies', async () => {
    const { transport, workers } = make(() => undefined);
    const call = transport.query({ query: 'query.model' });
    await Promise.resolve();
    workers[0]!.onerror?.({ message: 'out of memory' } as ErrorEvent);
    await expect(call).rejects.toMatchObject({ code: 'internal' });
  });

  it('ignores replies for calls it has already settled', async () => {
    const late: ((res: AppRes) => void)[] = [];
    const { transport } = make((req, reply) => {
      reply(ok(req.id, null));
      late.push(reply);
    });
    await transport.query({ query: 'query.model' });
    expect(() => late[0]!(ok(1, null))).not.toThrow();
  });
});

describe('toStructured', () => {
  it('passes an engine error through and fills the optional fields', () => {
    expect(toStructured({ code: 'set.empty', cause: 'nothing matched' })).toEqual({ code: 'set.empty', cause: 'nothing matched', where: null, suggestion: null });
  });

  it('wraps anything else as internal', () => {
    expect(toStructured(new Error('boom'))).toMatchObject({ code: 'internal', cause: 'boom' });
    expect(toStructured('plain string')).toMatchObject({ code: 'internal', cause: 'plain string' });
    expect(toStructured({ code: 'not-a-real-code', cause: 'x' })).toMatchObject({ code: 'internal' });
  });
});

describe('gpuSelfTest', () => {
  it('goes through the same queue as everything else', async () => {
    const { transport, workers } = make((req, reply) => reply(ok(req.id, 500500)));
    await expect(transport.gpuSelfTest(1000)).resolves.toBe(500500);
    expect(workers[0]!.sent[0]).toMatchObject({ op: 'gpuSelfTest', payload: { n: 1000 } });
  });
});

it('never leaves the queue broken after a rejection', async () => {
  const { transport } = make((req, reply) => (req.id === 1 ? reply({ id: req.id, ok: false, error: { code: 'internal', cause: 'first fails', where: null, suggestion: null } }) : reply(ok(req.id, 'second works'))));
  await expect(transport.query({ query: 'query.model' })).rejects.toThrow();
  await expect(transport.query({ query: 'query.model' })).resolves.toBe('second works');
});

it('does not record undo/redo acks as new Journal entries', async () => {
  const spy = vi.fn();
  const { transport } = make((req, reply) => {
    spy(req.op);
    reply(ok(req.id, ack({ seq: -1, revision: 0 })));
  });
  await transport.dispatch({ cmd: 'journal.undo' } as unknown as Command);
  await transport.cancel();
  expect(spy).toHaveBeenCalled();
});

it('returns the import boundary Journal and uses its normalized entries for cancel replay', async () => {
  const journal = { entries: [{ seq: 0, cmd: { cmd: 'model.new' as const, name: 'normalized', description: null }, hashAfter: 'normalized-hash' }] };
  const { transport, workers } = make((req, reply) => reply(ok(req.id, req.op === 'importFile' ? { ...ack(), journal } : {})));
  await transport.init();
  const file = { format: 'femlab/1', engineVersion: '0', model: {}, journal: { entries: [] } } as never;
  expect((await transport.importFile(file)).journal).toEqual(journal);
  await transport.cancel();
  const replay = workers.at(-1)!.sent.find((r) => r.op === 'replay');
  expect(replay?.payload).toMatchObject({ entries: journal.entries });
});
