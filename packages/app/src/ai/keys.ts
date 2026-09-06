// Where the assistant's API key comes from, and where it does not (ADR 0006, PLAN 4.4): a key the
// person typed, kept in this browser's localStorage, else the shell key `vite.config.ts` injects
// while `vite dev` runs, else none. A production build defines `__DEV_API_KEYS__` as `null`, and
// `scripts/check-no-secrets.mjs` reads `dist/` back to prove no key survived the build.
import { devApiKeys } from '../dev-keys';
import { ANTHROPIC_DEFAULT, ANTHROPIC_MODELS } from './anthropic';
import { OPENAI_DEFAULT, OPENAI_MODELS } from './openai';
import type { ProviderId } from './provider';

export type KeySource = 'stored' | 'dev' | 'none';
export interface KeyInfo {
  key: string | null;
  source: KeySource;
}

/** Anthropic keeps `femlab.ai.key`, the slot the `ai.setKey` host Command already writes. */
export const KEY_SLOT: Record<ProviderId, string> = { anthropic: 'femlab.ai.key', openai: 'femlab.ai.key.openai' };
export const MODEL_SLOT = 'femlab.ai.model';

export const PROVIDER_IDS: ProviderId[] = ['anthropic', 'openai'];
export const MODELS: Record<ProviderId, string[]> = { anthropic: ANTHROPIC_MODELS, openai: OPENAI_MODELS };
export const DEFAULT_MODEL: Record<ProviderId, string> = { anthropic: ANTHROPIC_DEFAULT, openai: OPENAI_DEFAULT };

/** localStorage throws in a locked-down browser; a missing key is a state, not a crash. */
function read(storage: Storage, slot: string): string | null {
  try {
    return storage.getItem(slot);
  } catch {
    return null;
  }
}

export function resolveKey(id: ProviderId, storage: Storage = localStorage, dev = devApiKeys()): KeyInfo {
  const stored = read(storage, KEY_SLOT[id]);
  if (stored) return { key: stored, source: 'stored' };
  const injected = dev?.[id];
  if (injected) return { key: injected, source: 'dev' };
  return { key: null, source: 'none' };
}

export function storeKey(id: ProviderId, key: string | null, storage: Storage = localStorage): void {
  try {
    if (key) storage.setItem(KEY_SLOT[id], key);
    else storage.removeItem(KEY_SLOT[id]);
  } catch {
    // A browser that refuses storage still gets a working session from the dev key or a paste.
  }
}

/** Honor a saved model first; otherwise use the first keyed provider, then Anthropic. */
export function defaultProvider(storage: Storage = localStorage, dev = devApiKeys()): ProviderId {
  const selected = read(storage, MODEL_SLOT);
  const chosen = PROVIDER_IDS.find(id => selected !== null && MODELS[id].includes(selected));
  if (chosen) return chosen;
  return PROVIDER_IDS.find((id) => resolveKey(id, storage, dev).key) ?? 'anthropic';
}

export function storedModel(id: ProviderId, storage: Storage = localStorage): string {
  const model = read(storage, MODEL_SLOT);
  return model && MODELS[id].includes(model) ? model : DEFAULT_MODEL[id];
}

/** `sk-ant-api…7f2a` — enough to recognise a key, not enough to use one over someone's shoulder. */
export function maskKey(key: string): string {
  return key.length <= 12 ? '••••' : `${key.slice(0, 8)}…${key.slice(-4)}`;
}
