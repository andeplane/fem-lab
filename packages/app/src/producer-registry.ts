import { FemError, type Registry } from '@femlab/registry';
import type { Store } from './store';
/** A producer follows only replacements it initiates. Its UI reader follows that same lease. */
export interface RegistryProducer {
  registry: Registry;
  signal: AbortSignal;
  store(): Store | undefined;
  release(): Promise<void>;
}
const producers = new WeakMap<Registry, () => Promise<RegistryProducer>>();
export function bindRegistryProducer(registry: Registry, fork: () => Promise<RegistryProducer>): void { producers.set(registry, fork); }
export async function acquireRegistryProducer(registry: Registry): Promise<RegistryProducer> {
  const fork = producers.get(registry);
  if (!fork) throw new FemError('session.expired', 'this registry cannot acquire a producer', 'registry');
  return fork();
}
export async function forkRegistryProducer(registry: Registry): Promise<Registry> { return (await acquireRegistryProducer(registry)).registry; }
