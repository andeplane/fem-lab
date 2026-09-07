import { FemError, type DocumentSnapshot, type RunLease } from '@femlab/registry';
import type { ReplacementSource, SessionOptions } from './session-protocol';
import { sameSession, SessionChannel, SessionTransport } from './session-transport';

export interface SessionResources {
  dispose(): void;
  abandon?(): Promise<void>;
  prepareToLeave?(): Promise<void>;
  recoverySource?(source: ReplacementSource): Promise<ReplacementSource>;
  recoveryFailed?(error: unknown): void;
}
export interface ActiveSession<T extends SessionResources> {
  readonly transport: SessionTransport;
  readonly initial: DocumentSnapshot;
  readonly resources: T;
}
export interface WorkspaceOptions<T extends SessionResources> {
  spawn(): Worker;
  epoch(): string;
  engine: SessionOptions;
  /** Build a private UI/resource bundle; publish is called only once it is complete. */
  build(transport: SessionTransport, snapshot: DocumentSnapshot, source?: ReplacementSource): Promise<T>;
  publish(session: ActiveSession<T>): void;
}

/** Atomic activation owns one pointer. Old callbacks retain their old resources and endpoint. */
export class SessionWorkspace<T extends SessionResources> {
  private current: ActiveSession<T> | undefined;
  private preparing = false;
  private recoveryRequested = false;
  constructor(private readonly options: WorkspaceOptions<T>) {}
  get active(): ActiveSession<T> {
    if (!this.current) throw new FemError('session.transitioning', 'workspace is still starting');
    return this.current;
  }
  private async create(): Promise<SessionTransport> {
    const channel = new SessionChannel(this.options.spawn(), error => {
      const active = this.current;
      if (active?.transport.channel !== channel) return;
      if (this.preparing) { this.recoveryRequested = true; return; }
      void this.recover(active.transport).catch(failure => active.resources.recoveryFailed?.(failure ?? error));
    });
    try {
      const created = await channel.request({ op: 'create', epoch: this.options.epoch(), options: this.options.engine });
      const run = await channel.request({ op: 'beginRun', session: created.stamp.session });
      return new SessionTransport(channel, run.value as RunLease, (origin, source) => this.replace(origin, source), origin => this.recover(origin));
    } catch (error) { channel.close(); throw error; }
  }
  async start(): Promise<ActiveSession<T>> {
    if (this.current || this.preparing) throw new FemError('session.conflict', 'workspace already started');
    this.preparing = true;
    const transport = await this.create().catch((error: unknown) => { this.preparing = false; throw error; });
    try {
      const initial = await transport.snapshot();
      const resources = await this.options.build(transport, initial);
      this.current = { transport, initial, resources };
      this.options.publish(this.current);
      return this.current;
    } catch (error) { transport.channel.close(); throw error; }
    finally { this.preparing = false; }
  }
  async recover(origin: SessionTransport): Promise<void> {
    const expected = this.active;
    if (!sameSession(origin.stamp.session, expected.transport.stamp.session)) throw new FemError('session.expired', 'recovery belongs to an inactive session');
    if (this.preparing) throw new FemError('session.transitioning', 'a replacement is already being prepared');
    const source = expected.transport.channel.recoveryJournal();
    this.preparing = true;
    expected.transport.channel.close(new FemError('cancelled', 'the running operation was cancelled; recovering acknowledged history'));
    let candidate: SessionTransport | undefined;
    let resources: T | undefined;
    let published = false;
    try {
      const recovery = await expected.resources.recoverySource?.(source) ?? source;
      candidate = await this.create();
      const initial = await candidate.prepare(recovery, this.options.engine);
      resources = await this.options.build(candidate, initial, recovery);
      if (this.current !== expected) throw new FemError('session.conflict', 'active session changed during recovery');
      const next = { transport: candidate, initial, resources };
      this.current = next; published = true;
      try { this.options.publish(next); } finally { expected.resources.dispose(); }
    } catch (error) { expected.resources.recoveryFailed?.(error); throw error; }
    finally {
      this.preparing = false;
      if (!published) { candidate?.channel.close(); try { await resources?.abandon?.(); } finally { resources?.dispose(); } }
    }
  }
  async replace(origin: SessionTransport, source: ReplacementSource): Promise<SessionTransport> {
    const expected = this.active;
    if (!sameSession(origin.stamp.session, expected.transport.stamp.session)) throw new FemError('session.expired', 'replacement belongs to an inactive session');
    if (this.preparing) throw new FemError('session.transitioning', 'another replacement is being prepared');
    this.preparing = true;
    let ticket: string | undefined;
    let candidate: SessionTransport | undefined;
    let resources: T | undefined;
    let published = false;
    try {
      // Reservation occurs under the old engine's exclusive execution, so writes cannot race
      // validation/publication. Reads keep the old document usable during preparation.
      ticket = await origin.reserve();
      await expected.resources.prepareToLeave?.();
      candidate = await this.create();
      const initial = await candidate.prepare(structuredClone(source), this.options.engine);
      resources = await this.options.build(candidate, initial, source);
      const initiating = await candidate.fork();
      if (this.current !== expected) throw new FemError('session.conflict', 'active session changed during preparation');
      await origin.channel.request({ op: 'retire', ticket });
      const next = { transport: candidate, initial, resources };
      this.current = next;
      published = true;
      this.recoveryRequested = false;
      // Publish a complete bundle synchronously, then revoke all old endpoint traffic.
      try { this.options.publish(next); }
      finally { expected.transport.channel.close(); expected.resources.dispose(); }
      return initiating;
    } finally {
      this.preparing = false;
      if (!published) {
        candidate?.channel.close();
        try { await resources?.abandon?.(); }
        finally {
          resources?.dispose();
          if (ticket !== undefined) await origin.channel.request({ op: 'abandon', ticket }).catch(() => undefined);
        }
        if (this.recoveryRequested) {
          this.recoveryRequested = false;
          void this.recover(expected.transport).catch(error => expected.resources.recoveryFailed?.(error));
        }
      }
    }
  }
}
