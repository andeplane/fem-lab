import type { SessionEngine, PreparedEngine } from './generated/wasm/femlab_engine_wasm.js';
import type { BufferSpec, DocumentSnapshot, Stamp } from '@femlab/registry';
import type { SessionOptions, SessionRequest, SessionResponse } from './session-protocol';
import { toStructured } from './engine-error';
const json = JSON.stringify;
class Publication { constructor(readonly stamp: Stamp, readonly value: unknown) {} }
interface Bulk { value: unknown; buffers: BufferSpec[]; raw: ArrayBuffer[] }
function bulk(value: Record<string, unknown>, fields: [string, BufferSpec['dtype']][]): Bulk {
  const buffers: BufferSpec[] = [];
  const raw: ArrayBuffer[] = [];
  for (const [name, dtype] of fields) {
    const view = value[name] as Float32Array | Float64Array | Uint32Array;
    const owned = view.slice();
    buffers.push({ name, dtype, length: owned.length });
    raw.push(owned.buffer as ArrayBuffer);
    delete value[name];
  }
  return { value, buffers, raw };
}
export class SessionRuntime {
  private engine: SessionEngine | undefined;
  private tail: Promise<void> = Promise.resolve();
  constructor(
    private readonly create: (options: SessionOptions, epoch: string) => Promise<SessionEngine>,
    private readonly candidate: (ticket: string, options: SessionOptions) => Promise<PreparedEngine>,
  ) {}
  private async handle(req: SessionRequest, progress: (phase: string, fraction: number, message: string) => boolean): Promise<unknown> {
const need = (): SessionEngine => {
  if (!this.engine) throw { code: 'internal', cause: 'session Worker has not been created' };
  return this.engine;
};
  switch (req.op) {
    case 'create':
      if (this.engine) throw { code: 'session.conflict', cause: 'a Worker owns exactly one backend epoch' };
      this.engine = await this.create(req.options, req.epoch);
      return null;
    case 'beginRun': return JSON.parse(need().begin_run(json(req.session)));
    case 'forkRun': return JSON.parse(need().fork_run(json(req.context)));
    case 'cancelRun': need().cancel_run(json(req.context.session), req.context.runId); return null;
    case 'dispatch': {
      const reply = JSON.parse(await need().dispatch(json({ context: req.context, expectedVersion: req.expectedVersion, command: req.command }), progress));
      return new Publication(reply.stamp, reply.ack);
    }
    case 'query': {
      const reply = need().query_transfer(json({ context: req.context, query: req.query })) as { value: Record<string, unknown> };
      return 'values' in reply.value && reply.value['values'] instanceof Float64Array
        ? bulk(reply.value, [['values', 'f64']]) : reply.value;
    }
    case 'snapshot': return JSON.parse(need().snapshot(json(req.context)));
    case 'surface': {
      const value = need().surface(json(req.context), req.resultId) as Record<string, unknown>;
      value['triFace'] = value['triSet']; delete value['triSet'];
      value['faceNames'] = value['setNames']; value['setNames'] = value['membershipNames']; delete value['membershipNames'];
      value['edgeFace'] = value['edgeSet']; delete value['edgeSet'];
      return bulk(value, [['positions', 'f32'], ['indices', 'u32'], ['triFace', 'u32'], ['triBody', 'u32'], ['triSetOffsets', 'u32'], ['triSets', 'u32'], ['edges', 'u32'], ['edgeFace', 'u32'], ['edgeBody', 'u32']]);
    }
    case 'gpuSelfTest': return need().gpu_self_test(json(req.context), req.n);
    case 'reserve': return need().begin_replacement(json(req.context), req.expectedVersion);
    case 'retire': need().retire_replacement(req.ticket); return null;
    case 'abandon': need().abandon_replacement(req.ticket); return null;
    case 'prepare': {
      const ticket = need().begin_replacement(json(req.context), req.expectedVersion);
      let candidate: PreparedEngine | undefined;
      try {
        candidate = await this.candidate(ticket, req.options);
        const source = req.source;
        switch (source.kind) {
          case 'commands': await candidate.commands(json(source.commands)); break;
          case 'journal':
            await candidate.journal(json(source.entries), source.skipSolves);
            if (source.revision !== undefined && source.revision < source.entries.length) {
              await candidate.commands(json([{ cmd: 'journal.undo', steps: source.entries.length - source.revision }]));
            }
            break;
          case 'file': await candidate.file(json(source.file)); break;
        }
        candidate.finish();
        const consumed = candidate; candidate = undefined;
        return JSON.parse(need().commit_candidate(consumed)) as DocumentSnapshot;
      } catch (error) {
        candidate?.free();
        need().abandon_replacement(ticket);
        throw error;
      }
    }
  }
}
  accept(req: SessionRequest, post: (reply: SessionResponse, raw?: ArrayBuffer[]) => void): Promise<void> {
  const context = 'context' in req ? req.context : null;
  const run = async (): Promise<void> => {
    try {
      const result = await this.handle(req, (phase, fraction, message) => { post({ id: req.id, context, progress: { phase, fraction, message } }); return true; });
      const stamp = result instanceof Publication ? result.stamp : JSON.parse(this.engine!.stamp()) as Stamp;
      const value = result instanceof Publication ? result.value : result;
      if (value && typeof value === 'object' && 'raw' in value) {
        const data = value as Bulk;
        post({ id: req.id, context, ok: true, stamp, ...data }, data.raw);
      } else post({ id: req.id, context, ok: true, stamp, value });
    } catch (error) { post({ id: req.id, context, ok: false, error: toStructured(error) }); }
  };
  this.tail = this.tail.then(run, run);
  return this.tail;
  }

}
