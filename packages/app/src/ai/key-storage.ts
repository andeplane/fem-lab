import type { ProviderId } from './provider';

/** Provider-specific slots used by the `ai.setKey` host Command. */
export const KEY_SLOT: Record<ProviderId, string> = { anthropic: 'femlab.ai.key', openai: 'femlab.ai.key.openai' };
const forgottenSlot = (id: ProviderId): string => `${KEY_SLOT[id]}.forgotten`;

/** Accessing the storage property itself can throw in a locked-down browser. */
export function browserStorage(kind: 'localStorage' | 'sessionStorage'): Storage | null {
  try { return globalThis[kind]; } catch { return null; }
}

export function readStorage(storage: Storage | null, slot: string): string | null {
  try { return storage?.getItem(slot) ?? null; } catch { return null; }
}

function writeStorage(storage: Storage | null, slot: string, value: string | null): boolean {
  if (storage === null) return false;
  try {
    if (value === null) storage.removeItem(slot);
    else storage.setItem(slot, value);
    return true;
  } catch { return false; }
}

/** Recheck shared Forget state on every resolution, including in already-open fallback tabs. */
export function retainedSessionKey(id: ProviderId, persistent: Storage | null, session: Storage | null): string | null {
  if (readStorage(persistent, forgottenSlot(id)) === '1') {
    writeStorage(session, KEY_SLOT[id], null);
    return null;
  }
  return readStorage(session, KEY_SLOT[id]);
}

/** Persist a direct-provider key; refused writes retain the existing key and report failure.
 * Forgetting removes both copies and prevents another legacy tab from adopting the key again.
 */
export function storeKey(id: ProviderId, key: string | null, persistent: Storage | null = browserStorage('localStorage'), session: Storage | null = browserStorage('sessionStorage')): boolean {
  if (key) {
    if (!writeStorage(persistent, KEY_SLOT[id], key)) return false;
    return session === null || writeStorage(session, KEY_SLOT[id], null);
  }
  const forgotten = writeStorage(persistent, forgottenSlot(id), '1');
  const removed = writeStorage(persistent, KEY_SLOT[id], null);
  const sessionRemoved = session === null || writeStorage(session, KEY_SLOT[id], null);
  return forgotten && removed && sessionRemoved;
}

/** Adopt a key the earlier session-only build left in this tab's `sessionStorage`, then remove
 * that copy. A key already stored persistently wins. Model preferences are untouched.
 */
export function adoptSessionKeys(persistent: Storage | null = browserStorage('localStorage'), session: Storage | null = browserStorage('sessionStorage')): void {
  for (const id of ['anthropic', 'openai'] as const) {
    const left = readStorage(session, KEY_SLOT[id]);
    if (readStorage(persistent, KEY_SLOT[id]) || readStorage(persistent, forgottenSlot(id)) === '1') {
      writeStorage(session, KEY_SLOT[id], null);
    } else if (left && writeStorage(persistent, KEY_SLOT[id], left)) {
      writeStorage(session, KEY_SLOT[id], null);
    }
  }
}

/** Hosted builds neither read nor migrate cached direct-provider credentials. */
export function prepareKeyStorage(hosted: boolean): void {
  if (!hosted) adoptSessionKeys();
}
