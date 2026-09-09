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

/** Keys live in `localStorage`, so one paste lasts across tabs and sessions in this browser (#485). */
export function storeKey(id: ProviderId, key: string | null, storage: Storage | null = browserStorage('localStorage')): void {
  try {
    if (key) storage?.setItem(KEY_SLOT[id], key);
    else storage?.removeItem(KEY_SLOT[id]);
  } catch { /* Refused storage is treated as an unavailable key. */ }
}

/** Adopt a key the earlier session-only build left in this tab's `sessionStorage`, then remove
 * that copy. A key already stored persistently wins. Model preferences are untouched.
 */
export function adoptSessionKeys(persistent: Storage | null = browserStorage('localStorage'), session: Storage | null = browserStorage('sessionStorage')): void {
  for (const id of ['anthropic', 'openai'] as const) {
    const left = readStorage(session, KEY_SLOT[id]);
    if (left && !readStorage(persistent, KEY_SLOT[id])) storeKey(id, left, persistent);
    try { session?.removeItem(KEY_SLOT[id]); } catch { /* Storage may be inaccessible. */ }
  }
}
