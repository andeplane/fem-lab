// PLAN 4.4: a stored key wins, the dev server's shell key stands in while `vite dev` runs, and the
// settings row can always say which of the two the current key came from.
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultProvider, maskKey, resolveKey, storedModel, storeKey, KEY_SLOT } from '../src/ai/keys';

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
