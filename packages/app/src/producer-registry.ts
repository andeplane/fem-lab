import type { Registry } from '@femlab/registry';
const producers = new WeakMap<Registry, () => Promise<Registry>>();
export function bindRegistryProducer(registry: Registry, fork: () => Promise<Registry>): void { producers.set(registry, fork); }
export async function forkRegistryProducer(registry: Registry): Promise<Registry> { return producers.has(registry) ? producers.get(registry)!() : registry; }
