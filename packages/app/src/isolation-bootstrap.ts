import type { ValidationClock } from '@femlab/registry';

export interface IsolationRegistration { unregister(): Promise<boolean> }
export interface IsolationWorker {
  readonly controller: { postMessage(message: unknown): void } | null;
  register(url: string): Promise<IsolationRegistration>;
  addEventListener(type: 'controllerchange', listener: () => void): void;
  removeEventListener(type: 'controllerchange', listener: () => void): void;
}
export interface IsolationHost {
  isolated: boolean;
  secure: boolean;
  worker?: IsolationWorker;
  storage(): Pick<Storage, 'getItem' | 'setItem'>;
  clock: ValidationClock;
  script: string;
  reload(): void;
}

/** Decide isolation before capabilities or the first engine Worker. A controlled reload never
 * releases its old document's engine. Registration failure/deadline releases portable startup
 * and cannot cause a late reload. All browser, storage and clock operations belong to the host.
 */
export function prepareIsolation(host: IsolationHost): Promise<void> {
  const { worker } = host;
  worker?.controller?.postMessage({ type: 'coepCredentialless', value: true });
  if (host.isolated || !host.secure || !worker) return Promise.resolve();
  let storage: ReturnType<IsolationHost['storage']>;
  try {
    storage = host.storage();
    if (storage.getItem('coi-reset')) return Promise.resolve();
  } catch { return Promise.resolve(); }
  return new Promise(resolve => {
    let settled = false;
    let fellBack = false;
    let registration: IsolationRegistration | undefined;
    const clean = () => {
      worker.removeEventListener('controllerchange', controlled);
      host.clock.clearTimeout(timer);
    };
    const fallback = () => {
      if (settled) return;
      settled = true;
      fellBack = true;
      clean();
      void registration?.unregister().catch(() => {});
      resolve();
    };
    const controlled = () => {
      if (settled || !worker.controller) return;
      try { storage.setItem('coi-reset', '1'); }
      catch { fallback(); return; }
      settled = true;
      clean();
      worker.controller.postMessage({ type: 'coepCredentialless', value: true });
      host.reload();
    };
    const timer = host.clock.setTimeout(fallback, 10_000);
    worker.addEventListener('controllerchange', controlled);
    controlled();
    if (!settled) {
      try {
        void worker.register(host.script).then(value => {
          registration = value;
          if (fellBack) void value.unregister().catch(() => {});
          else if (!settled) controlled();
        }, fallback);
      } catch { fallback(); }
    }
  });
}
