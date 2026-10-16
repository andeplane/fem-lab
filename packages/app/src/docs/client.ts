/** Standalone progressive enhancement for the static documentation host. */
export interface DocsEntry {
  title: string;
  url: string;
  section: string;
  content: string;
}

export interface DocsEnvironment {
  document: Document;
  fetch: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
  clipboard: { writeText(text: string): Promise<void> };
}

const normalize = (value: string): string => value.toLocaleLowerCase().trim().replace(/\s+/g, ' ');

/** All query terms must match; exact operation names and titles rank before body matches. */
export function rankDocs(entries: readonly DocsEntry[], query: string): DocsEntry[] {
  const needle = normalize(query);
  if (!needle) return [];
  const terms = needle.split(' ');
  return entries.map((entry, order) => {
    const title = normalize(entry.title);
    const section = normalize(entry.section);
    const haystack = `${title} ${section} ${normalize(entry.content)}`;
    if (!terms.every(term => haystack.includes(term))) return { entry, order, score: 0 };
    const score = (title === needle ? 1000 : title.startsWith(needle) ? 500 : title.includes(needle) ? 250 : 0)
      + terms.reduce((sum, term) => sum + (title.includes(term) ? 30 : section.includes(term) ? 10 : 1), 0);
    return { entry, order, score };
  }).filter(result => result.score > 0).sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, 10).map(result => result.entry);
}

function readIndex(value: unknown, base: string): DocsEntry[] {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1
    || !('entries' in value) || !Array.isArray(value.entries)) throw new Error('Invalid search index');
  return value.entries.filter((entry: unknown): entry is DocsEntry => {
    if (!entry || typeof entry !== 'object') return false;
    for (const key of ['title', 'url', 'section', 'content'] as const) {
      if (!(key in entry) || typeof (entry as Record<string, unknown>)[key] !== 'string') return false;
    }
    try {
      const url = new URL((entry as DocsEntry).url, base);
      return url.origin === new URL(base).origin && ['http:', 'https:'].includes(url.protocol);
    } catch { return false; }
  });
}

/** Returns a teardown function; all browser I/O is supplied by the documentation host. */
export function initializeDocs({ document: doc, fetch, clipboard }: DocsEnvironment): () => void {
  const removers: (() => void)[] = [];
  let disposed = false;
  const listen = (target: EventTarget, name: string, handler: EventListener): void => {
    target.addEventListener(name, handler);
    removers.push(() => target.removeEventListener(name, handler));
  };
  doc.documentElement.classList.remove('no-js');
  doc.documentElement.classList.add('js');
  const menu = doc.querySelector<HTMLButtonElement>('.docs-menu-toggle');
  const sidebar = doc.querySelector<HTMLElement>('#docs-sidebar');
  const closeMenu = (): void => {
    sidebar?.classList.remove('is-open');
    menu?.setAttribute('aria-expanded', 'false');
  };
  if (menu && sidebar) {
    listen(menu, 'click', () => {
      const open = sidebar.classList.toggle('is-open');
      menu.setAttribute('aria-expanded', String(open));
    });
    listen(sidebar, 'click', event => {
      if ((event.target as Element).closest('a')) closeMenu();
    });
  }

  for (const button of doc.querySelectorAll<HTMLButtonElement>('.docs-copy')) {
    listen(button, 'click', () => {
      const code = button.closest('.docs-code')?.querySelector('code');
      if (!code) return;
      button.disabled = true;
      void clipboard.writeText(code.textContent ?? '').then(() => {
        if (!disposed) { button.textContent = 'Copied'; button.setAttribute('aria-label', 'Code copied'); }
      }).catch(() => {
        if (!disposed) {
          button.textContent = 'Copy failed — select code';
          button.setAttribute('aria-label', 'Copy failed. Select and copy the code manually.');
        }
      }).finally(() => { if (!disposed) button.disabled = false; });
    });
  }

  const dialog = doc.querySelector<HTMLDialogElement>('#docs-search');
  const input = doc.querySelector<HTMLInputElement>('#docs-search-input');
  const results = doc.querySelector<HTMLOListElement>('#docs-search-results');
  const status = doc.querySelector<HTMLElement>('#docs-search-status');
  if (dialog && input && results && status) {
    let entries: DocsEntry[] | undefined;
    let loading: Promise<void> | undefined;
    let failed = false;
    let selection = -1;
    let previousFocus: HTMLElement | null = null;
    const links = (): HTMLAnchorElement[] => [...results.querySelectorAll<HTMLAnchorElement>('a')];
    const render = (): void => {
      results.replaceChildren();
      selection = -1;
      if (!entries) {
        status.textContent = failed ? 'Search is unavailable. Browse the navigation or try again.' : 'Loading documentation search…';
        return;
      }
      const matches = rankDocs(entries, input.value);
      if (!input.value.trim()) { status.textContent = 'Search guides, concepts and API commands.'; return; }
      status.textContent = matches.length ? `${matches.length} result${matches.length === 1 ? '' : 's'}` : 'No results. Try another topic or command name.';
      for (const entry of matches) {
        const item = doc.createElement('li');
        const link = doc.createElement('a');
        link.href = new URL(entry.url, doc.baseURI).href;
        const title = doc.createElement('strong');
        title.textContent = entry.title;
        const section = doc.createElement('span');
        section.textContent = entry.section;
        const excerpt = doc.createElement('p');
        excerpt.textContent = entry.content.replace(/\s+/g, ' ').slice(0, 150);
        link.append(title, section, excerpt);
        item.append(link);
        results.append(item);
      }
    };
    const load = (): void => {
      if (entries || loading) return;
      failed = false;
      render();
      loading = Promise.resolve().then(async () => {
        try {
          const source = doc.documentElement.dataset.searchIndex;
          if (!source) throw new Error('Missing search index');
          const url = new URL(source, doc.baseURI);
          if (url.origin !== new URL(doc.baseURI).origin) throw new Error('Cross-origin search index');
          const response = await fetch(url.href);
          if (!response.ok) throw new Error('Search request failed');
          const parsed = readIndex(await response.json(), doc.baseURI);
          if (!disposed) entries = parsed;
        } catch { if (!disposed) failed = true; }
        finally { loading = undefined; if (!disposed) render(); }
      });
    };
    const open = (): void => {
      if (!dialog.open) {
        previousFocus = doc.activeElement as HTMLElement | null;
        dialog.showModal();
      }
      input.focus();
      load();
      render();
    };
    const restoreFocus = (): void => { previousFocus?.focus(); };
    const close = (): void => { dialog.close(); restoreFocus(); };
    for (const trigger of doc.querySelectorAll('.docs-search-open')) listen(trigger, 'click', open);
    for (const button of dialog.querySelectorAll('[data-docs-search-close]')) listen(button, 'click', close);
    listen(dialog, 'close', restoreFocus);
    listen(input, 'input', render);
    listen(doc, 'keydown', event => {
      const key = event as KeyboardEvent;
      const target = key.target as Element;
      const editing = target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
      if ((key.key.toLowerCase() === 'k' && (key.ctrlKey || key.metaKey)) || (key.key === '/' && !editing && !key.ctrlKey && !key.metaKey && !key.altKey)) {
        key.preventDefault(); open(); return;
      }
      if (key.key === 'Escape') {
        if (dialog.open) { key.preventDefault(); close(); }
        else if (sidebar?.classList.contains('is-open')) { closeMenu(); menu?.focus(); }
        return;
      }
      if (!dialog.open) return;
      const found = links();
      if ((key.key === 'ArrowDown' || key.key === 'ArrowUp') && found.length) {
        key.preventDefault();
        const focused = found.indexOf(doc.activeElement as HTMLAnchorElement);
        if (focused >= 0) selection = focused;
        selection = selection < 0 ? (key.key === 'ArrowDown' ? 0 : found.length - 1)
          : (selection + (key.key === 'ArrowDown' ? 1 : -1) + found.length) % found.length;
        found[selection]!.focus();
      } else if (key.key === 'Enter' && doc.activeElement === input && found.length) {
        key.preventDefault(); found[0]!.click();
      }
    });
  }
  return () => {
    disposed = true;
    for (const remove of removers) remove();
  };
}

if (typeof document !== 'undefined' && document.documentElement.dataset.femDocs === 'true') {
  initializeDocs({ document, fetch: url => window.fetch(url), clipboard: { writeText: async text => navigator.clipboard.writeText(text) } });
}
