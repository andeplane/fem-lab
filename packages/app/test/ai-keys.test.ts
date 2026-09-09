// PLAN 4.4: a stored key wins, the dev server's shell key stands in while `vite dev` runs, and the
// settings row can always say which of the two the current key came from.
import { beforeEach, describe, expect, it } from 'vitest';
import { adoptSessionKeys, defaultProvider, maskKey, resolveKey, storedModel, storeKey, KEY_SLOT } from '../src/ai/keys';

const memory = (): Storage => {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
};

const hostile = (): Storage =>
  new Proxy({} as Storage, {
    get: () => () => {
      throw new Error('storage is blocked');
    },
  });

let storage: Storage;
beforeEach(() => {
  storage = memory();
});

describe('key resolution', () => {
  it('prefers the key the person stored in this browser', () => {
    storeKey('anthropic', 'sk-ant-stored', storage);
    expect(resolveKey('anthropic', storage, { anthropic: 'sk-ant-dev', openai: null })).toEqual({ key: 'sk-ant-stored', source: 'stored' });
  });

  it('falls back to the key the dev server injected, and says so', () => {
    expect(resolveKey('openai', storage, { anthropic: null, openai: 'sk-proj-dev' })).toEqual({ key: 'sk-proj-dev', source: 'dev' });
  });

  it('reports no key when nothing is stored and the build injected nothing', () => {
    expect(resolveKey('anthropic', storage, null)).toEqual({ key: null, source: 'none' });
  });

  it('stores the Anthropic key in the slot the `ai.setKey` Command already writes, and forgets on null', () => {
    storeKey('anthropic', 'sk-ant-1', storage);
    expect(storage.getItem(KEY_SLOT.anthropic)).toBe('sk-ant-1');
    storeKey('anthropic', null, storage);
    expect(resolveKey('anthropic', storage, null).key).toBeNull();
  });

  it('survives a browser that refuses localStorage entirely', () => {
    const blocked = hostile();
    storeKey('anthropic', 'sk-ant-1', blocked);
    expect(resolveKey('anthropic', blocked, null)).toEqual({ key: null, source: 'none' });
  });
});

describe('the default provider', () => {
  it('is the first provider with a key, Anthropic preferred', () => {
    expect(defaultProvider(storage, { anthropic: 'a', openai: 'b' })).toBe('anthropic');
    expect(defaultProvider(storage, { anthropic: null, openai: 'b' })).toBe('openai');
  });

  it('is Anthropic when no key exists anywhere, so the settings row has something to show', () => {
    expect(defaultProvider(storage, null)).toBe('anthropic');
  });
});

describe('the model choice', () => {
  it('defaults to the current Opus and ignores a stored id that belongs to the other provider', () => {
    expect(storedModel('anthropic', storage)).toBe('claude-opus-5');
    storage.setItem('femlab.ai.model', 'gpt-6-astra');
    expect(storedModel('anthropic', storage)).toBe('claude-opus-5');
    expect(storedModel('openai', storage)).toBe('gpt-6-astra');
  });

  it('keeps a stored id the provider does offer', () => {
    storage.setItem('femlab.ai.model', 'claude-sonnet-5');
    expect(storedModel('anthropic', storage)).toBe('claude-sonnet-5');
  });
});

describe('masking', () => {
  it('shows enough of a key to recognise it and not enough to use it', () => {
    expect(maskKey('sk-ant-api03-abcdefgh7f2a')).toBe('sk-ant-a…7f2a');
    expect(maskKey('short')).toBe('••••');
  });
});


describe('persistent key storage (#485)', () => {
  it('keeps keys in localStorage so a new tab or session still has them, next to the model preference', () => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('femlab.ai.model', 'gpt-6-astra');
    storeKey('openai', 'kept-key');
    expect(localStorage.getItem(KEY_SLOT.openai)).toBe('kept-key');
    expect(sessionStorage.getItem(KEY_SLOT.openai)).toBeNull();
    sessionStorage.clear();
    expect(resolveKey('openai', undefined, null)).toEqual({ key: 'kept-key', source: 'stored' });
    expect(defaultProvider(localStorage, null)).toBe('openai');
    expect(storedModel('openai')).toBe('gpt-6-astra');
    localStorage.clear();
  });

  it('adopts a key the session-only build left in this tab once, without overwriting a persistent one', () => {
    const session = memory();
    session.setItem(KEY_SLOT.anthropic, 'left-a');
    session.setItem(KEY_SLOT.openai, 'left-b');
    storage.setItem(KEY_SLOT.openai, 'kept-b');
    storage.setItem('femlab.ai.model', 'gpt-6-astra');
    adoptSessionKeys(storage, session);
    expect(storage.getItem(KEY_SLOT.anthropic)).toBe('left-a');
    expect(storage.getItem(KEY_SLOT.openai)).toBe('kept-b');
    expect(session.getItem(KEY_SLOT.anthropic)).toBeNull();
    expect(session.getItem(KEY_SLOT.openai)).toBeNull();
    expect(storage.getItem('femlab.ai.model')).toBe('gpt-6-astra');
    adoptSessionKeys(storage, session);
    expect(storage.getItem(KEY_SLOT.anthropic)).toBe('left-a');
  });

  it('removes the session copy even if persistent storage refuses the key, and never throws', () => {
    const session = memory();
    session.setItem(KEY_SLOT.openai, 'left-key');
    adoptSessionKeys(hostile(), session);
    expect(session.getItem(KEY_SLOT.openai)).toBeNull();
    expect(() => adoptSessionKeys(null, hostile())).not.toThrow();
    expect(resolveKey('openai', null, null).key).toBeNull();
  });

  it('chooses the keyed provider from the persistent slots', () => {
    storage.setItem(KEY_SLOT.openai, 'kept-b');
    expect(defaultProvider(storage, null, storage)).toBe('openai');
  });
});
