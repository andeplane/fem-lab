import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDocs, rankDocs } from '../src/docs/client';
import type { DocsEntry, DocsEnvironment } from '../src/docs/client';
const entries: DocsEntry[] = [
  { title: 'Loads and constraints', url: '/docs/loads/', section: 'Guides', content: 'Apply force to a named node set.' },
  { title: 'model.addNode', url: '/docs/api/#add-node', section: 'Commands', content: 'Create a node using SI coordinates.' },
  { title: 'model.addNodes', url: '/docs/api/#add-nodes', section: 'Commands', content: 'Create several nodes.' },
  { title: 'Replay a model', url: '/docs/replay/', section: 'Guides', content: 'Replay model.addNode and preserve the Journal.' },
];
const tick = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 0)); };
const q = <T extends Element = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;
const press = (target: Element, key: string, extra: KeyboardEventInit = {}): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }); target.dispatchEvent(event); return event;
};
let cleanup: (() => void) | undefined;
let fetchIndex: ReturnType<typeof vi.fn<DocsEnvironment['fetch']>>;
let writeText: ReturnType<typeof vi.fn<DocsEnvironment['clipboard']['writeText']>>;
const start = (): void => { cleanup = initializeDocs({ document, fetch: fetchIndex, clipboard: { writeText } }); };
const open = async (value = ''): Promise<void> => {
  q<HTMLButtonElement>('.docs-search-open').click(); q<HTMLInputElement>('#docs-search-input').value = value;
  q('#docs-search-input').dispatchEvent(new Event('input', { bubbles: true })); await tick();
};
beforeEach(() => {
  document.documentElement.className = 'no-js'; document.documentElement.dataset.searchIndex = '/docs/search-index.abc.json'; delete document.documentElement.dataset.femDocs;
  document.body.innerHTML = `<button class="docs-search-open">Search documentation</button>
    <button class="docs-menu-toggle" aria-expanded="false" aria-controls="docs-sidebar">Menu</button>
    <nav id="docs-sidebar" class="docs-sidebar"><a href="/docs/guide/">Guide</a></nav>
    <main><input id="other-input"><textarea></textarea><select></select><div contenteditable="true">Editable</div>
    <div class="docs-code"><button class="docs-copy">Copy code</button><pre><code>const value = &lt;safe&gt;;</code></pre></div></main>
    <dialog id="docs-search"><button data-docs-search-close>Close</button><input id="docs-search-input" type="search">
    <p id="docs-search-status" role="status"></p><ol id="docs-search-results"></ol></dialog>`;
  const dialog = q<HTMLDialogElement>('#docs-search'); dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new Event('close')); };
  fetchIndex = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: 1, entries }) }); writeText = vi.fn().mockResolvedValue(undefined);
});
afterEach(() => { cleanup?.(); cleanup = undefined; vi.restoreAllMocks(); });

describe('standalone documentation search', () => {
  it('ranks exact operations before prefixes and body mentions, requires all terms and limits results', () => {
    expect(rankDocs(entries, ' MODEL.ADDNODE ').map(e => e.title)).toEqual(['model.addNode', 'model.addNodes', 'Replay a model']);
    expect(rankDocs(entries, 'named force')).toEqual([entries[0]]); expect(rankDocs(entries, 'constraints')).toEqual([entries[0]]);
    expect(rankDocs(entries, 'commands coordinates')).toEqual([entries[1]]); expect(rankDocs(entries, 'node impossible')).toEqual([]); expect(rankDocs(entries, '  ')).toEqual([]);
    expect(rankDocs(Array.from({ length: 20 }, (_, i) => ({ ...entries[0]!, title: `Loads ${i}` })), 'loads')).toHaveLength(10);
  });
  it('loads lazily once, handles typing while pending and safely renders text', async () => {
    let resolve!: (result: Awaited<ReturnType<DocsEnvironment['fetch']>>) => void;
    fetchIndex.mockImplementation(() => new Promise(done => { resolve = done; })); start(); expect(fetchIndex).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains('js')).toBe(true); q<HTMLButtonElement>('.docs-search-open').focus(); await open('script');
    expect(q('#docs-search-status').textContent).toContain('Loading'); q<HTMLButtonElement>('.docs-search-open').click(); expect(fetchIndex).toHaveBeenCalledTimes(1);
    resolve({ ok: true, json: async () => ({ version: 1, entries: [{ title: '<script>alert(1)</script>', section: '<b>API</b>', url: '/docs/safe/', content: '<img src=x onerror=alert(1)>' }] }) }); await tick();
    expect(q('#docs-search-results strong').textContent).toBe('<script>alert(1)</script>'); expect(q('#docs-search-results span').textContent).toBe('<b>API</b>');
    expect(document.querySelector('#docs-search-results script')).toBeNull(); expect(document.querySelector('#docs-search-results img')).toBeNull(); expect(q('#docs-search-status').textContent).toBe('1 result');
    q<HTMLButtonElement>('[data-docs-search-close]').click(); expect(document.activeElement).toBe(q('.docs-search-open')); await open('script'); expect(fetchIndex).toHaveBeenCalledTimes(1);
  });
  it('supports keyboard opening, arrow wrapping, Enter navigation and Escape focus restoration', async () => {
    start(); const trigger = q<HTMLButtonElement>('.docs-search-open'); trigger.focus(); expect(press(trigger, 'k', { ctrlKey: true }).defaultPrevented).toBe(true);
    const input = q<HTMLInputElement>('#docs-search-input'); expect(document.activeElement).toBe(input); input.value = 'model'; input.dispatchEvent(new Event('input')); await tick();
    const found = [...document.querySelectorAll<HTMLAnchorElement>('#docs-search-results a')]; expect(found).toHaveLength(3); expect(q('#docs-search-status').textContent).toBe('3 results');
    press(input, 'ArrowUp'); expect(document.activeElement).toBe(found[2]); press(found[2]!, 'ArrowDown'); expect(document.activeElement).toBe(found[0]);
    press(found[0]!, 'ArrowDown'); expect(document.activeElement).toBe(found[1]); press(found[1]!, 'ArrowUp'); expect(document.activeElement).toBe(found[0]);
    const clicked = vi.fn((event: Event) => event.preventDefault()); found[0]!.addEventListener('click', clicked); input.focus(); press(input, 'Enter'); expect(clicked).toHaveBeenCalledTimes(1);
    press(input, 'Escape'); expect(q<HTMLDialogElement>('#docs-search').open).toBe(false); expect(document.activeElement).toBe(trigger);
    press(trigger, 'k', { metaKey: true }); expect(q<HTMLDialogElement>('#docs-search').open).toBe(true);
  });
  it('does not steal slash from editors, and announces empty or missing results', async () => {
    start(); for (const selector of ['#other-input', 'textarea', 'select', '[contenteditable]']) { expect(press(q(selector), '/').defaultPrevented).toBe(false); expect(q<HTMLDialogElement>('#docs-search').open).toBe(false); }
    expect(press(q('main'), '/', { altKey: true }).defaultPrevented).toBe(false); expect(press(q('main'), '/').defaultPrevented).toBe(true); await tick();
    expect(q('#docs-search-status').textContent).toContain('Search guides'); expect(press(q('#docs-search-input'), 'Enter').defaultPrevented).toBe(false); expect(press(q('#docs-search-input'), 'ArrowDown').defaultPrevented).toBe(false);
    q<HTMLInputElement>('#docs-search-input').value = 'nonexistent'; q('#docs-search-input').dispatchEvent(new Event('input')); expect(q('#docs-search-status').textContent).toContain('No results');
  });
  it('reports request failure and retries when reopened', async () => {
    fetchIndex.mockResolvedValueOnce({ ok: false, json: async () => null }); start(); await open('node'); expect(q('#docs-search-status').textContent).toContain('Search is unavailable');
    q<HTMLButtonElement>('[data-docs-search-close]').click(); await open('node'); expect(fetchIndex).toHaveBeenCalledTimes(2); expect(q('#docs-search-results a')).not.toBeNull();
  });
  it.each([null, {}, { version: 2, entries: [] }, { version: 1, entries: 'wrong' }])('rejects invalid index %j', async value => {
    fetchIndex.mockResolvedValue({ ok: true, json: async () => value }); start(); await open('node'); expect(q('#docs-search-status').textContent).toContain('Search is unavailable');
  });
  it('rejects unsafe URLs and malformed records, allowing same-origin absolute links', async () => {
    fetchIndex.mockResolvedValue({ ok: true, json: async () => ({ version: 1, entries: [null, {}, { ...entries[1], title: 3 }, { ...entries[1], url: 'javascript:alert(1)' },
      { ...entries[1], url: 'https://external.example/docs/' }, { ...entries[1], url: 'https://[' }, { ...entries[1], url: new URL('/docs/safe/', document.baseURI).href }] }) });
    start(); await open('node'); expect(document.querySelectorAll('#docs-search-results a')).toHaveLength(1); expect(q<HTMLAnchorElement>('#docs-search-results a').pathname).toBe('/docs/safe/');
  });
  it.each([undefined, 'https://external.example/search.json'])('never fetches an absent or cross-origin source %s', async source => {
    if (source) document.documentElement.dataset.searchIndex = source; else delete document.documentElement.dataset.searchIndex;
    start(); await open(); expect(fetchIndex).not.toHaveBeenCalled(); expect(q('#docs-search-status').textContent).toContain('Search is unavailable');
  });
  it('allows retry after a synchronous network failure and ignores late rejection after disposal', async () => {
    fetchIndex.mockImplementationOnce(() => { throw new Error('offline'); }); start(); await open('node');
    expect(q('#docs-search-status').textContent).toContain('Search is unavailable');
    q<HTMLButtonElement>('[data-docs-search-close]').click(); await open('node'); expect(fetchIndex).toHaveBeenCalledTimes(2);
    cleanup!(); let reject!: (reason: Error) => void; fetchIndex.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    start(); await open('node'); cleanup!(); reject(new Error('late failure')); await tick();
    expect(q('#docs-search-status').textContent).toContain('Loading');
  });
  it('disposes an in-flight search and event listeners without updating a detached host', async () => {
    let finish!: (result: Awaited<ReturnType<DocsEnvironment['fetch']>>) => void; fetchIndex.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    start(); await open('node'); cleanup!(); finish({ ok: true, json: async () => ({ version: 1, entries }) }); await tick();
    expect(q('#docs-search-results').children).toHaveLength(0); const input = q<HTMLInputElement>('#docs-search-input'); input.value = 'changed'; input.dispatchEvent(new Event('input'));
    expect(q('#docs-search-status').textContent).toContain('Loading');
  });
});
describe('documentation navigation and code', () => {
  it('toggles mobile navigation accessibly and closes on link or Escape', () => {
    start(); const menu = q<HTMLButtonElement>('.docs-menu-toggle'); menu.click(); expect(menu.getAttribute('aria-expanded')).toBe('true'); expect(q('#docs-sidebar').classList.contains('is-open')).toBe(true);
    q('#docs-sidebar a').addEventListener('click', event => event.preventDefault()); q<HTMLAnchorElement>('#docs-sidebar a').click(); expect(menu.getAttribute('aria-expanded')).toBe('false');
    menu.click(); press(menu, 'Escape'); expect(menu.getAttribute('aria-expanded')).toBe('false'); expect(document.activeElement).toBe(menu); press(menu, 'Escape'); press(menu, 'x');
    cleanup!(); menu.click(); expect(menu.getAttribute('aria-expanded')).toBe('false');
  });
  it('copies literal code and offers a manual fallback if clipboard access fails', async () => {
    start(); const button = q<HTMLButtonElement>('.docs-copy'); button.click(); expect(button.disabled).toBe(true); await tick();
    expect(writeText).toHaveBeenCalledWith('const value = <safe>;'); expect(button.textContent).toBe('Copied'); expect(button.disabled).toBe(false);
    writeText.mockRejectedValueOnce(new Error('denied')); button.click(); await tick(); expect(button.textContent).toContain('Copy failed'); expect(button.getAttribute('aria-label')).toContain('manually'); expect(button.disabled).toBe(false);
    q('.docs-code code').remove(); button.click(); expect(writeText).toHaveBeenCalledTimes(2);
  });
  it('does not update copy state after disposal or late clipboard rejection', async () => {
    let finish!: () => void; writeText.mockImplementation(() => new Promise(resolve => { finish = resolve; })); start(); q<HTMLButtonElement>('.docs-copy').click(); cleanup!(); finish(); await tick();
    expect(q('.docs-copy').textContent).toBe('Copy code'); cleanup = undefined; writeText.mockRejectedValue(new Error('denied')); start(); q<HTMLButtonElement>('.docs-copy').click(); cleanup!(); await tick(); expect(q('.docs-copy').textContent).toBe('Copy code');
  });
  it('preserves static pages without interactive controls', () => { document.body.innerHTML = '<main><h1>Static content</h1></main>'; start(); expect(q('h1').textContent).toBe('Static content'); });
  it('auto-initializes the dedicated documentation host', async () => {
    document.documentElement.dataset.femDocs = 'true'; vi.stubGlobal('fetch', fetchIndex); vi.stubGlobal('navigator', { clipboard: { writeText } }); vi.resetModules(); await import('../src/docs/client');
    q<HTMLButtonElement>('.docs-search-open').click(); await tick(); expect(fetchIndex).toHaveBeenCalledTimes(1); q<HTMLButtonElement>('.docs-copy').click(); await tick(); expect(writeText).toHaveBeenCalledTimes(1); vi.unstubAllGlobals();
  });
});
