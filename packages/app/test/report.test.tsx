import type { ModelSummary, ReportText, ResultSummary } from '@femlab/registry';
import { render } from 'preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialState, type UiState } from '../src/store';
import { renderReportMarkdown, Report } from '../src/ui/Report';
import { waitFor } from './wait-for';

const MARKDOWN = `# Calculation note: cantilever

| | |
| --- | --- |
| Revision | 9 |

## Assumptions

Linear elastic response.

$$\\delta = \\frac{P L^3}{3 E I}$$

## Journal

\`\`\`ts
await fem.solve.run({ step: "static" });
\`\`\`
`;

const state = (result: ResultSummary | null = {} as ResultSummary): UiState =>
  ({
    ...initialState,
    revision: 9,
    model: { name: 'cantilever' } as ModelSummary,
    result,
    panels: { ...initialState.panels, report: true },
  }) as UiState;

const report: ReportText = { markdown: MARKDOWN, sections: ['header', 'assumptions', 'journal'] };

describe('Report', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    // happy-dom starts in quirks mode; the real app has <!doctype html> and KaTeX checks it.
    Object.defineProperty(document, 'compatMode', { configurable: true, value: 'CSS1Compat' });
  });

  it('renders the real report Markdown, tables, code and KaTeX in the paper view', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const query = vi.fn(async () => report);
    render(<Report s={state()} dispatch={async () => undefined} query={query} />, root);
    await waitFor(() => root.querySelector('.report-paper'), 'the report paper');

    expect(query).toHaveBeenCalledWith({ query: 'query.report' });
    expect(root.querySelector('h1')!.textContent).toBe('Calculation note: cantilever');
    expect(root.querySelector('table')!.textContent).toContain('Revision');
    expect(root.querySelector('pre code')!.textContent).toContain('fem.solve.run');
    expect(root.querySelector('.katex')).not.toBeNull();
    expect(root.querySelector('.report-toolbar')!.textContent).toContain('from rev 9 · Markdown · query.report');
  });

  it('keeps every toolbar action in the registry and copies the exact Markdown bytes', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const commands: Record<string, unknown>[] = [];
    render(<Report s={state()} dispatch={async (cmd) => void commands.push(cmd)} query={async () => report} />, root);
    await waitFor(() => root.querySelector('.report-paper'), 'the report paper');

    root.querySelector<HTMLButtonElement>('[data-cmd="report.print"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-cmd="clipboard.copy"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-cmd="panel.toggle"]')!.click();
    await waitFor(() => commands.length === 3, 'the three report Commands');
    expect(commands).toEqual([
      { cmd: 'report.print' },
      { cmd: 'clipboard.copy', what: { kind: 'text', text: MARKDOWN } },
      { cmd: 'panel.toggle', panel: 'report', open: false },
    ]);
    expect([...root.querySelectorAll('button')].every((button) => button.hasAttribute('data-cmd'))).toBe(true);
  });

  it('explains why there is no report before a Result and does not query the engine', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const query = vi.fn(async () => report);
    render(<Report s={state(null)} dispatch={async () => undefined} query={query} />, root);

    expect(root.querySelector('[role="dialog"]')!.textContent).toContain('No Result to report yet');
    expect(root.textContent).toContain('Finish the model and press Solve');
    expect(query).not.toHaveBeenCalled();
    expect(root.querySelector('[data-cmd="panel.toggle"]')).not.toBeNull();
  });

  it('shows a query failure instead of an empty paper', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    render(<Report s={state()} dispatch={async () => undefined} query={async () => Promise.reject(new Error('result disappeared'))} />, root);
    await waitFor(() => root.querySelector('[role="alert"]'), 'the report error');
    expect(root.querySelector('[role="alert"]')!.textContent).toContain('result disappeared');
  });
});

describe('renderReportMarkdown', () => {
  it('renders raw HTML from model names as inert text', () => {
    const html = renderReportMarkdown('# <img src=x onerror="alert(1)">safe<script>alert(2)</script>');
    expect(html).toContain('safe');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;img');
  });
});
