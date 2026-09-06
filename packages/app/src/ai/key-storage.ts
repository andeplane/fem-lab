import type { ProviderId } from './provider';

/** Provider-specific slots used by the `ai.setKey` host Command. */
export const KEY_SLOT: Record<ProviderId, string> = { anthropic: 'femlab.ai.key', openai: 'femlab.ai.key.openai' };

/** Accessing the storage property itself can throw in a locked-down browser. */
export function browserStorage(kind: 'localStorage' | 'sessionStorage'): Storage | null {
  try { return globalThis[kind]; } catch { return null; }
}

export function readStorage(storage: Storage | null, slot: string): string | null {
  try { return storage?.getItem(slot) ?? null; } catch { return null; }
}

export function storeKey(id: ProviderId, key: string | null, storage: Storage | null = browserStorage('sessionStorage')): void {
  try {
    if (key) storage?.setItem(KEY_SLOT[id], key);
    else storage?.removeItem(KEY_SLOT[id]);
  } catch { /* Refused storage is treated as an unavailable key. */ }
}

/** Move old persistent keys into this session, then remove the persistent copies.
 * A newly entered session key wins. Model preferences remain persistent.
 */
export function migratePersistentKeys(persistent: Storage | null = browserStorage('localStorage'), session: Storage | null = browserStorage('sessionStorage')): void {
  for (const id of ['anthropic', 'openai'] as const) {
    const old = readStorage(persistent, KEY_SLOT[id]);
    if (old && !readStorage(session, KEY_SLOT[id])) storeKey(id, old, session);
    try { persistent?.removeItem(KEY_SLOT[id]); } catch { /* Storage may be inaccessible. */ }
  }
}
