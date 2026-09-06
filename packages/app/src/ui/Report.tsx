// The design handoff's full-screen calculation note. This module is imported only while the
// Report panel is open: marked, KaTeX and its fonts stay off the boot path.
import type { ReportText } from '@femlab/registry';
import 'katex/dist/katex.min.css';
import katex from 'katex';
import { Marked, type MarkedExtension, type Tokens } from 'marked';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Store, UiState } from '../store';
import { Cmd, type Dispatch } from './cmd';
import type { Query } from './SchemaForm';
import './report.css';

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const parser = new Marked({ gfm: true });
type MathToken = Tokens.Generic & { text: string; displayMode: boolean };
const math: MarkedExtension = {
  extensions: [
    {
      name: 'reportDisplayMath',
      level: 'block',
      start: (source) => source.indexOf('$$'),
      tokenizer(source) {
        const match = /^\$\$\s*([\s\S]+?)\s*\$\$(?:\n|$)/.exec(source);
        return match ? ({ type: 'reportDisplayMath', raw: match[0], text: match[1]!, displayMode: true } as MathToken) : undefined;
      },
      renderer: (token) => `${katex.renderToString((token as MathToken).text, { displayMode: true, throwOnError: false, strict: false })}\n`,
    },
    {
      name: 'reportInlineMath',
      level: 'inline',
      start: (source) => source.indexOf('$'),
      tokenizer(source) {
        const match = /^\$([^$\n]+?)\$(?=\s|[.,:;!?)]|$)/.exec(source);
        return match ? ({ type: 'reportInlineMath', raw: match[0], text: match[1]!, displayMode: false } as MathToken) : undefined;
      },
      renderer: (token) => katex.renderToString((token as MathToken).text, { displayMode: false, throwOnError: false, strict: false }),
    },
  ],
};
parser.use(math);
// marked deliberately passes raw HTML through. Reports need Markdown, tables and KaTeX, not an
// HTML escape hatch, so raw tags are rendered as text before they ever reach the DOM.
parser.use({ renderer: { html: ({ text }) => escapeHtml(text) } });

/** Engine Markdown becomes inert report HTML; model names and Journal strings are untrusted. */
export function renderReportMarkdown(markdown: string): string {
  const template = document.createElement('template');
  template.innerHTML = parser.parse(markdown) as string;
  for (const element of template.content.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) if (attribute.name.toLowerCase().startsWith('on')) element.removeAttribute(attribute.name);
    const href = element.getAttribute('href');
    if (href !== null && !safeUrl(href)) element.removeAttribute('href');
    // Report figures come from query.screenshot below. Markdown may contain user-authored names
    // and Journal values, so it never gets to fetch another origin through an image element.
    element.removeAttribute('src');
  }
  return template.innerHTML;
}

/** Decode the forms browsers normalise before navigation, then allow only inert/local/web URLs. */
function safeUrl(value: string): boolean {
  let probe = value.trim();
  for (let i = 0; i < 3; i++) {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = probe;
    probe = textarea.value;
    try {
      probe = decodeURIComponent(probe);
    } catch {
      return false;
    }
  }
  probe = probe.replace(/[\u0000-\u0020\u007f]+/g, '');
  if (/^(?:https?:|mailto:)/i.test(probe)) return true;
  return !/^[a-z][a-z\d+.-]*:/i.test(probe);
}

/** Put the real viewer figure after Results and before Verification when that section exists. */
export function splitForFigure(markdown: string): [string, string] {
  const at = markdown.indexOf('\n## Verification\n');
  return at < 0 ? [markdown, ''] : [markdown.slice(0, at), markdown.slice(at + 1)];
}

type LoadState = { kind: 'loading' } | { kind: 'ready'; report: ReportText; screenshot: string } | { kind: 'error'; message: string };

export function Report({ s, store, dispatch, query }: { s: UiState; store: Store; dispatch: Dispatch; query: Query }) {
  const [loaded, setLoaded] = useState<LoadState>({ kind: 'loading' });
  const hasResult = s.result !== null;
  const dialog = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLElement>('button:not([disabled]), a[href]')?.focus();
    return () => {
      prior?.focus();
    };
  }, [hasResult]);

  useEffect(() => {
    store.set({ reportReady: false });
    if (!hasResult) return () => store.set({ reportReady: false });
    let live = true;
    setLoaded({ kind: 'loading' });
    void Promise.all([query({ query: 'query.report' }), query({ query: 'query.screenshot', width: 2400, height: 1350, legend: true, title: s.model?.name ?? 'Result' })])
      .then(([value, image]) => {
        if (!live) return;
        const report = value as Partial<ReportText>;
        if (typeof report.markdown !== 'string' || !Array.isArray(report.sections)) throw new Error('query.report returned an invalid document');
        const screenshot = (image as { png?: unknown }).png;
        if (typeof screenshot !== 'string' || !screenshot.startsWith('data:image/png;base64,')) throw new Error('query.screenshot returned an invalid viewer image');
        setLoaded({ kind: 'ready', report: report as ReportText, screenshot });
        store.set({ reportReady: true });
      })
      .catch((error: unknown) => {
        if (live) setLoaded({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      live = false;
      store.set({ reportReady: false });
    };
  }, [hasResult, query, s.model?.name, s.revision, store]);

  const markdown = loaded.kind === 'ready' ? loaded.report.markdown : '';
  const parts = useMemo(() => splitForFigure(markdown).map((part) => (part === '' ? '' : renderReportMarkdown(part))) as [string, string], [markdown]);
  const close = { panel: 'report', open: false };
  const trapFocus = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab' || !dialog.current) return;
    const focusable = [...dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]')];
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) (event.preventDefault(), last.focus());
    else if (!event.shiftKey && document.activeElement === last) (event.preventDefault(), first.focus());
  };

  if (!hasResult) {
    return (
      <div ref={(node) => void (dialog.current = node)} class="report-blocked" role="presentation" onKeyDown={trapFocus} onClick={() => void dispatch({ cmd: 'panel.toggle', ...close })}>
        <section class="report-blocked-card" role="dialog" aria-modal="true" aria-labelledby="report-blocked-title" onClick={(event) => event.stopPropagation()}>
          <h2 id="report-blocked-title">No Result to report yet</h2>
          <p>The calculation note is generated from a Result and the Journal that produced it. Finish the model and press Solve; the report then opens with every assumption, table and formula filled in.</p>
          <div class="report-blocked-actions">
            <Cmd dispatch={dispatch} cmd="panel.toggle" class="tbutton" args={close}>
              Close
            </Cmd>
          </div>
        </section>
      </div>
    );
  }

  return (
    <section ref={(node) => void (dialog.current = node)} class="report-screen" role="dialog" aria-modal="true" aria-label={`Report for ${s.model?.name ?? 'model'}`} onKeyDown={trapFocus}>
      <header class="report-toolbar">
        <strong>Report · {s.model?.name ?? 'model'}</strong>
        <span class="mono report-meta">from rev {s.revision} · Markdown · query.report</span>
        <span class="report-actions">
          <Cmd dispatch={dispatch} cmd="report.print" class="tbutton" disabled={loaded.kind !== 'ready'} title="Open print dialog; choose Save as PDF">
            Export PDF
          </Cmd>
          <Cmd dispatch={dispatch} cmd="clipboard.copy" class="tbutton" args={{ what: { kind: 'text', text: markdown } }} disabled={loaded.kind !== 'ready'}>
            Copy Markdown
          </Cmd>
          <Cmd dispatch={dispatch} cmd="panel.toggle" class="tbutton muted" args={close}>
            Close
          </Cmd>
        </span>
      </header>
      <div class="report-scroll">
        {loaded.kind === 'loading' ? <div class="report-status" role="status">Generating the calculation note…</div> : null}
        {loaded.kind === 'error' ? (
          <div class="report-status error" role="alert">
            <strong>The calculation note could not be generated.</strong>
            <span>{loaded.message}</span>
          </div>
        ) : null}
        {loaded.kind === 'ready' ? (
          <article class="report-paper report-markdown">
            <div dangerouslySetInnerHTML={{ __html: parts[0] }} />
            <figure class="report-figure">
              <img src={loaded.screenshot} alt={`Current ${s.result?.step ?? ''} Result view for ${s.model?.name ?? 'model'}`} />
              <figcaption>Figure 1 — current {s.result?.step ?? ''} Result view with legend</figcaption>
            </figure>
            {parts[1] === '' ? null : <div dangerouslySetInnerHTML={{ __html: parts[1] }} />}
          </article>
        ) : null}
      </div>
    </section>
  );
}
