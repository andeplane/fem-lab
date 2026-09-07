// One checked owner, with host serialization around wasm's exclusive mutable borrow. A new
// MCP request explicitly acquires a lease; nested calls retain it across their own replacement.
import { FemError, type DocumentSnapshot, type RunLease, type Stamp, type WriteReply } from '@femlab/registry';
import type { PreparedEngine, SessionEngine } from '../../app/src/generated/wasm/femlab_engine_wasm';
import type { EngineHandle, EngineProvider } from './engine';

type Owner = Pick<SessionEngine, 'stamp' | 'begin_run' | 'cancel_run' | 'dispatch' | 'query' | 'snapshot' | 'begin_replacement' | 'abandon_replacement' | 'commit_candidate'>;
export interface CheckedModule {
  SessionEngine: new (threads: number, epoch: string) => Owner;
  PreparedEngine: { create(ticket: string, options: { threads: number; gpu: boolean }): Promise<PreparedEngine> };
}
export function sessionEngine(wasm: CheckedModule, threads: number, epoch: string): EngineProvider {
  const owner = new wasm.SessionEngine(threads, epoch);
  let current = JSON.parse(owner.stamp()) as Stamp;
  let tail: Promise<unknown> = Promise.resolve();
  const ordered = <T>(run: () => T | Promise<T>): Promise<T> => {
    const result = tail.then(run); tail = result.catch(() => undefined); return result;
  };
  const acquire = () => {
    const admittedSession = JSON.stringify(current.session);
    return ordered(() => {
      let lease = JSON.parse(owner.begin_run(admittedSession)) as RunLease;
      let operation = 0n;
      let revoked = false;
      const context = () => {
        if (revoked) throw new FemError('cancelled', 'this request has ended');
        return { session: lease.stamp.session, runId: lease.runId, operationId: String(++operation) };
      };
      const handle: EngineHandle = {
        dispatch: input => {
          const cmd = structuredClone(input);
          return ordered(async () => {
            const captured = context();
            if (cmd['cmd'] === 'model.new') {
              const ticket = owner.begin_replacement(JSON.stringify(captured), lease.stamp.stateVersion);
              let candidate: PreparedEngine | undefined;
              let consumed = false;
              try {
                candidate = await wasm.PreparedEngine.create(ticket, { threads, gpu: false });
                await candidate.commands(JSON.stringify([cmd]));
                candidate.finish();
                context(); // cancellation during candidate preparation cannot publish it
                consumed = true;
                const snapshot = JSON.parse(owner.commit_candidate(candidate)) as DocumentSnapshot;
                current = snapshot.stamp;
                lease = { ...lease, stamp: snapshot.stamp };
                return { seq: 0, revision: snapshot.model.revision, hash: snapshot.model.hash, warnings: [], output: { type: 'none' } };
              } finally {
                if (!consumed) { candidate?.free(); owner.abandon_replacement(ticket); }
              }
            }
            const reply = JSON.parse(await owner.dispatch(JSON.stringify({ context: captured, expectedVersion: lease.stamp.stateVersion, command: cmd }))) as WriteReply;
            current = reply.stamp;
            lease = { ...lease, stamp: reply.stamp };
            return reply.ack;
          });
        },
        query: input => {
          const query = structuredClone(input);
          return ordered(() => {
            const reply = JSON.parse(owner.query(JSON.stringify({ context: context(), query }))) as { stamp: Stamp; value: unknown };
            lease = { ...lease, stamp: reply.stamp };
            return reply.value;
          });
        },
        modelFile: () => ordered(() => {
          const snapshot = JSON.parse(owner.snapshot(JSON.stringify(context()))) as DocumentSnapshot;
          lease = { ...lease, stamp: snapshot.stamp };
          return snapshot.file;
        }),
        release: () => {
          revoked = true;
          return ordered(() => { try { owner.cancel_run(JSON.stringify(lease.stamp.session), lease.runId); } catch { /* replacement already revoked this lease */ } });
        },
      };
      return handle;
    });
  };
  return { acquire };
}
