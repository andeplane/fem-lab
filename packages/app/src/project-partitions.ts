import { FemError } from '@femlab/registry';
import type { AtomicProjects, ProjectRecord } from './project-repository';

// Browser-local routing, not protection from someone with access to the browser's storage.
// Anonymous version-3 IDs stay untouched; signed-in rows live under reserved physical keys.
const PREFIX = '\0femlab:project-owner:v1:';
const invalidId = (): FemError => new FemError('schema', 'project identifier belongs to a reserved storage namespace', 'project');
const copy = <T>(value: T): T => structuredClone(value);

/**
 * A repository destination captures its account for its entire lifetime. Switching accounts
 * creates another adapter; a delayed transaction through this one still targets its old owner.
 * Logical IDs, generations, versions and tombstones survive the physical-key translation.
 */
export function partitionedAtomicProjects(storage: AtomicProjects, owner: string | null): AtomicProjects {
  const physicalId = (id: string): string => {
    if (id.startsWith(PREFIX)) throw invalidId();
    return owner === null ? id : PREFIX + JSON.stringify([owner, id]);
  };
  const logicalId = (id: string): string | null => {
    if (!id.startsWith(PREFIX)) return owner === null ? id : null;
    if (owner === null) return null;
    try {
      const parts: unknown = JSON.parse(id.slice(PREFIX.length));
      if (!Array.isArray(parts) || parts.length !== 2 || parts[0] !== owner || typeof parts[1] !== 'string' || parts[1].startsWith(PREFIX)) return null;
      // Only canonical keys written by this adapter belong to the partition.
      return physicalId(parts[1]) === id ? parts[1] : null;
    } catch { return null; }
  };
  const decode = (row: ProjectRecord | null, id: string): ProjectRecord | null => row === null ? null : {
    ...copy(row), id, meta: row.meta === null ? null : { ...copy(row.meta), id },
  };
  return {
    list: async () => (await storage.list()).flatMap(row => {
      const id = logicalId(row.id);
      return id === null ? [] : [{ ...copy(row), id }];
    }),
    read: async id => decode(await storage.read(physicalId(id)), id),
    update: async (id, change) => {
      const key = physicalId(id);
      const next = await storage.update(key, previous => {
        const changed = change(decode(previous, id));
        if (changed.id !== id || changed.meta !== null && changed.meta.id !== id) throw invalidId();
        return { ...copy(changed), id: key, meta: changed.meta === null ? null : { ...copy(changed.meta), id: key } };
      });
      return decode(next, id)!;
    },
  };
}
