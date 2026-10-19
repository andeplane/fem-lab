import { FemError } from '@femlab/registry';

/** Hash routes keep the same static entry point on Firebase and GitHub Pages subdirectories. */
export type WorkspaceRoute = { page: 'home' | 'examples' } | { page: 'project'; id: string };
export function readWorkspaceRoute(hash: string): WorkspaceRoute | null {
  if (!hash || hash === '#' || hash === '#/') return { page: 'home' };
  if (hash === '#/examples') return { page: 'examples' };
  if (!hash.startsWith('#/')) return null; // Existing Journal and tutorial fragments own their syntax.
  const match = /^#\/projects\/([^/]+)$/.exec(hash);
  if (match) {
    try { const id = decodeURIComponent(match[1]!); if (id && id.length <= 256) return { page: 'project', id }; } catch { /* Invalid URI is a visible navigation error. */ }
  }
  throw new FemError('not-found', 'This FEM Lab route does not exist.', 'navigation', 'navigation.home');
}
export const workspaceHash = (route: WorkspaceRoute): string => route.page === 'project' ? `#/projects/${encodeURIComponent(route.id)}` : route.page === 'examples' ? '#/examples' : '#/';

export interface NavigationHistory {
  hash(): string;
  write(hash: string, replace: boolean): void;
  listen(changed: () => void): () => void;
}
export interface NavigationWorkspace {
  current(): { id: string | null; home: boolean; examples: boolean };
  show(page: 'home' | 'examples' | 'workspace'): void;
  /** Uses the active owner's ordinary project.open path, including artifact recovery. */
  open(id: string, signal: AbortSignal): Promise<void>;
  fail(error: unknown): void;
}

/** Lives above document sessions; replacing a Worker never replaces browser history. */
export class WorkspaceNavigation {
  private active = false;
  private opening: AbortController | null = null;
  private generation = 0;
  private pending: Promise<void> = Promise.resolve();
  private detach = () => {};
  constructor(private history: NavigationHistory, private workspace: NavigationWorkspace) {}

  async start(restore = true): Promise<void> {
    if (this.active) return;
    this.active = true;
    this.detach = this.history.listen(() => { void this.restore(); });
    if (restore) await this.restore();
    else this.record(true);
  }
  dispose(): void { this.active = false; this.generation++; this.opening?.abort(); this.detach(); }

  /** Call only after a successful, current-session navigation or document activation. */
  record(replace = false): void {
    if (!this.active) return;
    this.interrupt();
    const current = this.workspace.current();
    const route: WorkspaceRoute = current.examples ? { page: 'examples' } : current.home || !current.id ? { page: 'home' } : { page: 'project', id: current.id };
    const hash = workspaceHash(route);
    if (this.history.hash() !== hash) this.history.write(hash, replace);
  }
  /** New explicit user work wins over an older automatic history open. */
  interrupt(): void { this.generation++; this.opening?.abort(); }
  /** Admission waits for the cancelled open to abandon its engine reservation and resources. */
  interruptAndWait(): Promise<void> { this.interrupt(); return this.pending; }
  /** Identity changes invalidate queued opens and remove the previous private project URL. */
  reset(): void {
    this.interrupt();
    if (!this.active) return;
    this.workspace.show('home');
    this.history.write('#/', true);
  }
  restore(): Promise<void> {
    const hash = this.history.hash(), generation = ++this.generation;
    this.opening?.abort();
    if (!this.active) return Promise.resolve();
    let route: WorkspaceRoute | null;
    try { route = readWorkspaceRoute(hash); }
    catch (error) {
      this.workspace.show('home'); this.history.write('#/', true); this.workspace.fail(error);
      return Promise.resolve();
    }
    // Menu/gallery navigation must not wait behind a slow private artifact download.
    if (!route || route.page !== 'project' || this.workspace.current().id === route.id) {
      this.workspace.show(!route || route.page === 'project' ? 'workspace' : route.page);
      if (!hash) this.history.write('#/', true);
      return Promise.resolve();
    }
    const opening = new AbortController();
    this.opening = opening;
    const operation = this.pending.then(async () => {
      if (!this.active || generation !== this.generation) return;
      try {
        await this.workspace.open(route.id, opening.signal);
        if (generation !== this.generation || !this.active) return;
        this.workspace.show('workspace');
      } catch (error) {
        if (generation !== this.generation || !this.active) return;
        this.workspace.show('home');
        this.history.write('#/', true);
        this.workspace.fail(error);
      } finally { if (this.opening === opening) this.opening = null; }
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }
}

/** Browser I/O is injected; unit tests exercise the same router with an in-memory history. */
export function browserNavigationHistory(browser: Pick<Window, 'location' | 'history' | 'addEventListener' | 'removeEventListener'>): NavigationHistory {
  return {
    hash: () => browser.location.hash,
    write: (hash, replace) => browser.history[replace ? 'replaceState' : 'pushState'](null, '', browser.location.pathname + browser.location.search + hash),
    listen: changed => {
      // Hash traversal can emit both events. Generation fencing coalesces their queued work.
      browser.addEventListener('popstate', changed);
      browser.addEventListener('hashchange', changed);
      return () => { browser.removeEventListener('popstate', changed); browser.removeEventListener('hashchange', changed); };
    },
  };
}
