import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync('public/coi-serviceworker.min.js', 'utf8');
function worker(storageFails = false) {
  const listeners = new Map<string, (event: unknown) => void>();
  const saved = new Map<string, Response>();
  const fetch = vi.fn(async () => new Response('engine bytes'));
  const cache = {
    match: async (r: Request) => saved.get(r.url)?.clone(),
    put: async (r: Request, response: Response) => { saved.set(r.url, response); },
  };
  runInNewContext(source, {
    self: { registration: { scope: 'https://example.test/fem-lab/' }, addEventListener: (name: string, fn: (event: unknown) => void) => listeners.set(name, fn) },
    caches: { open: async () => { if (storageFails) throw new Error('storage denied'); return cache; } },
    fetch, URL, Request, Response, Headers, console: { error: vi.fn() },
  });
  const request = (path: string) => new Promise<Response>((resolve) => {
    listeners.get('fetch')!({ request: new Request(`https://example.test${path}`), respondWith: resolve });
  });
  return { fetch, request };
}

describe('deployed worker assets', () => {
  it('retains loaded worker and WASM assets after deployment removes them, preserving isolation', async () => {
    const w = worker();
    for (const name of ['session.worker-abcdefgh.js', 'engine-abcdefgh.wasm']) {
      const path = `/fem-lab/assets/${name}`;
      expect(await (await w.request(path)).text()).toBe('engine bytes');
    }
    w.fetch.mockImplementation(async () => new Response('removed by deployment', { status: 404 }));
    for (const name of ['session.worker-abcdefgh.js', 'engine-abcdefgh.wasm']) {
      const response = await w.request(`/fem-lab/assets/${name}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('engine bytes');
      expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
      expect(response.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
    }
    expect(w.fetch).toHaveBeenCalledTimes(2);
    expect((await w.request('/fem-lab/')).status).toBe(404);
  });
  it('returns a network-error Response on rejected fetch, never undefined', async () => {
    const w = worker();
    w.fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    expect((await w.request('/fem-lab/')).type).toBe('error');
  });
  it('keeps loading when Cache Storage is denied and does not retain HTTP errors', async () => {
    const w = worker(true);
    expect(await (await w.request('/fem-lab/assets/worker-abcdefgh.js')).text()).toBe('engine bytes');
    const normal = worker();
    normal.fetch.mockResolvedValueOnce(new Response('missing', { status: 404 }));
    expect((await normal.request('/fem-lab/assets/worker-abcdefgh.js')).status).toBe(404);
    expect((await normal.request('/fem-lab/assets/worker-abcdefgh.js')).status).toBe(200);
  });
});
