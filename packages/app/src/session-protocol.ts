import type { FieldRequest } from './result-transfer';
import type { ResultSelector } from '@femlab/registry';
import type { ActiveBenchmark } from './benchmark';
import type { ProjectRecord } from './project-repository';
import type { BufferSpec, ProjectMeta, Command, DocumentSnapshot, EngineError, ExecutionContext, JournalEntry, ModelFile, Progress, Query, RunLease, SessionRef, Stamp, StateVersion } from '@femlab/registry';

export interface SessionOptions { gpu: boolean; threads: number }
export type ReplacementSource = (
  | { kind: 'commands'; commands: Command[] }
  | { kind: 'journal'; entries: JournalEntry[]; skipSolves: boolean; revision?: number }
  | { kind: 'file'; file: ModelFile }) & { project?: { meta: ProjectMeta; expected: ProjectRecord | null }; benchmark?: ActiveBenchmark };
export type SessionRequest = { id: number } & (
  | { op: 'create'; epoch: string; options: SessionOptions }
  | { op: 'beginRun'; session: SessionRef }
  | { op: 'cancelRun' | 'forkRun'; context: ExecutionContext }
  | { op: 'query'; context: ExecutionContext; query: Query }
  | { op: 'dispatch'; context: ExecutionContext; expectedVersion: StateVersion; command: Command }
  | { op: 'snapshot'; context: ExecutionContext }
  | { op: 'field'; context: ExecutionContext; field: FieldRequest }
  | { op: 'surface'; context: ExecutionContext; selector?: ResultSelector }
  | { op: 'gpuSelfTest'; context: ExecutionContext; n: number }
  | { op: 'reserve'; context: ExecutionContext; expectedVersion: StateVersion }
  | { op: 'abandon' | 'retire'; ticket: string }
  | { op: 'prepare'; context: ExecutionContext; expectedVersion: StateVersion; source: ReplacementSource; options: SessionOptions }
);
export type SessionMessage = SessionRequest extends infer R ? R extends SessionRequest ? Omit<R, 'id'> : never : never;
export type SessionResponse = { id: number; context: ExecutionContext | null } & (
  | { ok: true; stamp: Stamp; value: unknown; buffers?: BufferSpec[]; raw?: ArrayBuffer[] }
  | { ok: false; error: EngineError }
  | { progress: Progress }
);
export interface PreparedSession { snapshot: DocumentSnapshot; lease: RunLease }
