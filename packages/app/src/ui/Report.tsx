// The design handoff's full-screen calculation note. This module is imported only while the
// Report panel is open: marked, KaTeX and its fonts stay off the boot path.
import type { ReportText } from '@femlab/registry';
import 'katex/dist/katex.min.css';
import katex from 'katex';
import { Marked, type MarkedExtension, type Tokens } from 'marked';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { UiState } from '../store';
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
  return parser.parse(markdown) as string;
}

type LoadState = { kind: 'loading' } | { kind: 'ready'; report: ReportText } | { kind: 'error'; message: string };

export function Report({ s, dispatch, query }: { s: UiState; dispatch: Dispatch; query: Query }) {
  const [loaded, setLoaded] = useState<LoadState>({ kind: 'loading' });
  const hasResult = s.result !== null;

  useEffect(() => {
    if (!hasResult) return;
    let live = true;
    setLoaded({ kind: 'loading' });
    void query({ query: 'query.report' })
      .then((value) => {
        if (!live) return;
        const report = value as Partial<ReportText>;
        if (typeof report.markdown !== 'string' || !Array.isArray(report.sections)) throw new Error('query.report returned an invalid document');
        setLoaded({ kind: 'ready', report: report as ReportText });
      })
      .catch((error: unknown) => {
        if (live) setLoaded({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      live = false;
    };
  }, [hasResult, query, s.revision]);

  const markdown = loaded.kind === 'ready' ? loaded.report.markdown : '';
  const html = useMemo(() => (markdown === '' ? '' : renderReportMarkdown(markdown)), [markdown]);
  const close = { panel: 'report', open: false };

  if (!hasResult) {
    return (
      <div class="report-blocked" role="presentation" onClick={() => void dispatch({ cmd: 'panel.toggle', ...close })}>
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
    <section class="report-screen" role="dialog" aria-modal="true" aria-label={`Report for ${s.model?.name ?? 'model'}`}>
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
        {loaded.kind === 'ready' ? <article class="report-paper report-markdown" dangerouslySetInnerHTML={{ __html: html }} /> : null}
      </div>
    </section>
  );
}
