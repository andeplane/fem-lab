import { FemError, HOST_COMMANDS, HOST_QUERIES, Registry, type AccountState, type EngineSchema, type HostDef, type ProjectMeta } from '@femlab/registry';
import { z } from 'zod';
import type { HostCaps } from './capabilities';
import { FORM_OPEN } from './host';
import type { LastError, UiState } from './store';

export type StartupPhase = 'starting' | 'cancelling' | 'cancelled' | 'failed';
export interface StartupStatus { phase: StartupPhase; attempt: number }
/** Host presentation only: there is no Model, Journal, transport or simulated Store. */
export type StartState = Pick<UiState, 'ready' | 'account' | 'projects' | 'project' | 'hostCaps' | 'engineCaps' | 'notes' | 'lastError'> & {
  startup?: StartupStatus;
  catalog?: 'loading' | 'ready' | 'failed';
  catalogError?: string;
  panels?: UiState['panels'];
};
export interface StartupOptions {
  schema: EngineSchema;
  caps: HostCaps;
  account: AccountState;
  listProjects(): Promise<ProjectMeta[]>;
  start(signal: AbortSignal): Promise<void>;
}
const unavailable = () => new FemError('session.transitioning', 'the simulation engine is not ready', null, 'query.workspaceStatus');
export function workspaceStatus(ready: boolean, startup?: StartupStatus) {
  return ready ? { phase: 'ready', ready: true } : { phase: startup?.phase ?? 'starting', ready: false, attempt: startup?.attempt ?? 0 };
}
export const WORKSPACE_STATUS = {
  name: 'query.workspaceStatus', execution: 'workspace', schema: z.object({}), tool: true,
  description: 'Read workspace readiness without starting or querying an engine. During initial startup, reports starting, cancelling, cancelled or failed and the attempt number. Model actions require ready. Retry a settled initial failure with workspace.retryStartup; cancel an in-flight initial attempt with workspace.cancelStartup.',
} satisfies Omit<HostDef, 'run'>;

/** Owns only initial startup. The complete session publication retires this binding forever. */
export class StartupHost {
  readonly registry: Registry;
  private value: StartState;
  private readonly listeners = new Set<() => void>();
  private attempt: AbortController | undefined;
  private retired = false;
  constructor(private readonly options: StartupOptions) {
    this.value = { ready: false, account: options.account, projects: [], project: null, hostCaps: options.caps, engineCaps: null, notes: [], lastError: null, startup: { phase: 'starting', attempt: 0 }, catalog: 'loading' };
    const deny = (): never => { throw unavailable(); };
    const commands = HOST_COMMANDS.map(({ run: _run, ...definition }) => ({ ...definition, run: deny }));
    const queries = HOST_QUERIES.map(({ run: _run, ...definition }) => ({ ...definition, run: deny }));
    this.registry = Registry.hostOnly({
      schema: options.schema, context: this, guard: () => this.assertActive(), unavailable,
      hostCommands: [...commands, { ...FORM_OPEN, run: deny }, {
        name: 'workspace.retryStartup', execution: 'workspace', schema: z.object({}), tool: true,
        description: 'Retry a failed or cancelled initial workspace startup with a fresh engine session. Wait until cancellation has settled. Never replays or queues a Model action; unavailable after the initial session is published.',
        run: () => this.start(),
      }, {
        name: 'workspace.cancelStartup', execution: 'control', schema: z.object({}), tool: true,
        description: 'Cancel only this page’s in-flight initial workspace startup and close its private Worker. The Start screen and saved project catalog remain available. Wait for cancelled before workspace.retryStartup. Does not cancel a published session.',
        run: () => this.cancel(),
      }],
      hostQueries: [...queries, { ...HOST_QUERIES.find(query => query.name === 'query.projects')!, run: () => ({ projects: this.value.projects }) }, { ...WORKSPACE_STATUS, run: () => workspaceStatus(false, this.value.startup) }],
    });
  }
  get state(): StartState { return this.value; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private set(patch: Partial<StartState>): void {
    if (this.retired) return;
    this.value = { ...this.value, ...patch };
    for (const listener of this.listeners) listener();
  }
  private assertActive(): void { if (this.retired) throw new FemError('session.expired', 'the startup registry has handed off to the active session'); }
  setAccount(account: AccountState): void { this.set({ account }); }
  async loadProjects(): Promise<void> {
    try { this.set({ projects: await this.options.listProjects(), catalog: 'ready' }); }
    catch (error) { this.set({ catalog: 'failed', catalogError: error instanceof Error ? error.message : String(error) }); }
  }
  async start(): Promise<void> {
    this.assertActive();
    if (this.attempt) throw new FemError('session.transitioning', 'the previous startup attempt has not settled');
    const controller = new AbortController();
    this.attempt = controller;
    this.set({ startup: { phase: 'starting', attempt: (this.value.startup?.attempt ?? 0) + 1 }, lastError: null });
    try { await this.options.start(controller.signal); controller.signal.throwIfAborted(); }
    catch (error) {
      const failure: LastError = error instanceof FemError ? { code: error.code, cause: error.cause, where: error.where, suggestion: error.suggestion } : { code: 'unsupported', cause: error instanceof Error ? error.message : String(error), where: 'workspace startup', suggestion: 'workspace.retryStartup' };
      this.set({ startup: { phase: controller.signal.aborted ? 'cancelled' : 'failed', attempt: this.value.startup!.attempt }, lastError: controller.signal.aborted ? null : failure });
      throw error;
    } finally { this.attempt = undefined; }
  }
  cancel(): void {
    this.assertActive();
    if (!this.attempt) throw new FemError('session.conflict', 'there is no in-flight startup attempt');
    this.set({ startup: { phase: 'cancelling', attempt: this.value.startup!.attempt } });
    this.attempt.abort(new FemError('cancelled', 'workspace startup was cancelled'));
  }
  retire(): void { this.retired = true; this.listeners.clear(); }
}

/** Observe late host completion while cancellation settles immediately, before spawning a Worker. */
export async function startupWait<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = () => { signal.removeEventListener('abort', cancel); reject(signal.reason); };
    void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  });
}
