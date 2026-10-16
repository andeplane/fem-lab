/** A plain, unsent request survives same-tab authentication. It never contains model tokens. */
export interface LandingPrompt {
  read(owner?: string | null): string;
  save(text: string, owner?: string | null): boolean;
  bind(owner: string): string;
  clear(): void;
}
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const KEY = 'femlab.unsentLandingPrompt';
export function landingPrompt(storage: () => DraftStorage): LandingPrompt {
  const record = (): {text: string; owner: string | null} | null => {
    const raw = storage().getItem(KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && 'text' in value && typeof value.text === 'string' && 'owner' in value && (value.owner === null || typeof value.owner === 'string') ? value as {text:string;owner:string|null} : null;
  };
  return {
    read(owner = null) { try { const value = record(); return value && (value.owner === null || value.owner === owner) ? value.text : ''; } catch { return ''; } },
    save(text, owner = null) { try { storage().setItem(KEY, JSON.stringify({text, owner})); return true; } catch { return false; } },
    bind(owner) {
      try {
        const value = record();
        if (!value) return '';
        if (value.owner !== null && value.owner !== owner) { storage().removeItem(KEY); return ''; }
        storage().setItem(KEY, JSON.stringify({...value, owner}));
        return value.text;
      } catch { return ''; }
    },
    clear() { try { storage().removeItem(KEY); } catch { /* An unavailable store held no usable return draft. */ } },
  };
}
export const browserLandingPrompt = landingPrompt(() => sessionStorage);
