import { FemError, type Command, type EngineError, type RunLease } from '@femlab/registry';
import { toStructured } from './engine-error';
import { SessionChannel, SessionTransport } from './session-transport';
import type { AppSurface } from './surface';
import type { FormState, Store } from './store';

export type GeometryDraftState = { status: 'idle' | 'pending' | 'ready' } | { status: 'error'; error: EngineError };
export interface DraftRenderer {
  render(commands: Command[]): Promise<AppSurface>;
  clear(): void;
}
export interface DraftView { setGeometryDraft(surface: AppSurface | null): void }
export interface DraftClock { schedule(fn: () => void, ms: number): unknown; cancel(handle: unknown): void }

/** A disposable CPU-only session, separate from the active Model's channel and Journal. */
export function geometryDraftRenderer(spawn: () => Worker, epoch: () => string): DraftRenderer {
  let channel: SessionChannel | undefined;
  let transport: Promise<SessionTransport> | undefined;
  let rendering = false;
  const clear = () => { channel?.close(); channel = undefined; transport = undefined; rendering = false; };
  return {
    clear,
    async render(commands) {
      // Cancel a slow superseded draft instead of growing a queue behind it.
      if (rendering) clear();
      if (!transport) {
        const own = channel = new SessionChannel(spawn());
        transport = (async () => {
          const created = await own.request({ op: 'create', epoch: epoch(), options: { gpu: false, threads: 1 } });
          const run = await own.request({ op: 'beginRun', session: created.stamp.session });
          return new SessionTransport(own, run.value as RunLease, async () => { throw new FemError('unsupported', 'draft sessions cannot activate projects'); });
        })();
      }
      const own = transport;
      const ownChannel = channel;
      rendering = true;
      const result = (async () => {
        const engine = await own;
        await engine.prepare({ kind: 'commands', commands }, { gpu: false, threads: 1 });
        return engine.surface();
      })();
      return result.finally(() => { if (transport === own) { rendering = false; if (ownChannel?.signal.aborted) clear(); } });
    },
  };
}

/** Preview is a consequence of the existing form.open Command, not an engine write. */
export class GeometryDraft {
  private form: FormState | null = null;
  private revision: number;
  private selection: Store['state']['selection'];
  private mode: Store['state']['viewMode'];
  private generation = 0;
  private timer: unknown;
  private deadline: unknown;
  private surface: AppSurface | null = null;
  private readonly detach: () => void;
  constructor(private readonly store: Store, private readonly renderer: DraftRenderer,
    private readonly view: () => DraftView | null, private readonly clock: DraftClock,
    private readonly values: (form: FormState) => Record<string, unknown>) {
    this.revision = store.state.revision;
    this.selection = store.state.selection;
    this.mode = store.state.viewMode;
    this.detach = store.subscribe(() => this.update());
    this.update();
  }
  restore(): void { this.view()?.setGeometryDraft(this.surface); }
  private clear(): void {
    this.generation++;
    if (this.timer !== undefined) this.clock.cancel(this.timer);
    this.timer = undefined;
    if (this.deadline !== undefined) this.clock.cancel(this.deadline);
    this.deadline = undefined;
    this.surface = null;
    this.renderer.clear();
    this.restore();
    if (this.store.state.geometryDraft.status !== 'idle') this.store.set({ geometryDraft: { status: 'idle' } });
  }
  private update(): void {
    const state = this.store.state;
    const formChanged = this.form !== state.form;
    const contextChanged = this.revision !== state.revision || this.selection !== state.selection;
    const modeChanged = this.mode !== state.viewMode;
    if (!formChanged && !contextChanged && !modeChanged) return;
    this.form = state.form;
    this.revision = state.revision;
    this.selection = state.selection;
    this.mode = state.viewMode;
    const form = state.form;
    // A successful Apply, a different selection, or a closed form discards the old draft.
    // Another field edit/reopen is required to start a new preview after that commit.
    if (contextChanged || !form || !['geometry.addBox', 'geometry.add'].includes(form.cmd) || state.viewMode !== 'geometry') return this.clear();
    if (this.timer !== undefined) this.clock.cancel(this.timer);
    if (this.deadline !== undefined) this.clock.cancel(this.deadline);
    const generation = ++this.generation;
    this.surface = null;
    this.restore();
    this.store.set({ geometryDraft: { status: 'pending' } });
    // Replaying only dimensional context avoids mesh building, materials, loads and solves.
    const context = (state.journal?.entries.slice(0, state.revision) ?? [])
      .map(entry => entry.cmd).filter(command => command.cmd === 'model.setIdealisation');
    const commands: Command[] = [{ cmd: 'model.new', name: 'Uncommitted geometry preview' }, ...context,
      { cmd: form.cmd, ...this.values(form) } as Command];
    this.timer = this.clock.schedule(() => {
      this.timer = undefined;
      this.deadline = this.clock.schedule(() => {
        if (generation !== this.generation) return;
        this.generation++;
        this.renderer.clear();
        this.store.set({ geometryDraft: { status: 'error', error: { code: 'unsupported', cause: 'This draft exceeded the five-second preview limit', where: 'shape', suggestion: 'Simplify the shape or reduce segments, then edit Properties again' } } });
      }, 5000);
      void this.renderer.render(commands).then(surface => {
        if (generation !== this.generation) return;
        this.clock.cancel(this.deadline);
        this.deadline = undefined;
        if (!surface.positions.every(Number.isFinite)) {
          this.store.set({ geometryDraft: { status: 'error', error: { code: 'schema', cause: 'Draft coordinates exceed the viewer range', where: 'shape', suggestion: 'Use smaller coordinates or dimensions' } } });
          return;
        }
        this.surface = surface;
        this.restore();
        this.store.set({ geometryDraft: { status: 'ready' } });
      }, error => {
        if (generation !== this.generation) return;
        this.clock.cancel(this.deadline);
        this.deadline = undefined;
        this.surface = null;
        this.restore();
        this.store.set({ geometryDraft: { status: 'error', error: toStructured(error) } });
      });
    }, 180);
  }
  dispose(): void { this.detach(); this.clear(); }
}
