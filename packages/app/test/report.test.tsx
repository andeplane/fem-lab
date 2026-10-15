import type { ModelSummary, ReportText, ResultSummary } from '@femlab/registry';
import { render } from 'preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readHostCaps } from '../src/capabilities';
import { makeHostContext } from '../src/host';
import { initialState, Store, type UiState } from '../src/store';
import { renderReportMarkdown, Report, splitForFigure } from '../src/ui/Report';
import type { Dispatch } from '../src/ui/cmd';
import type { EngineTransport as WorkerTransport } from '@femlab/registry';
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
const PNG = 'data:image/png;base64,QUJD';
const query = vi.fn(async (input: { query: string }) => (input.query === 'query.report' ? report : { png: PNG }));

function mount(result: ResultSummary | null = {} as ResultSummary, dispatch: Dispatch = async () => undefined) {
  const store = new Store(state(result));
  const root = document.createElement('div');
  document.body.append(root);
  render(<Report s={store.state} store={store} dispatch={dispatch} query={query} />, root);
  return { root, store, dispatch };
}

async function loadFigure(root: HTMLElement, store: Store): Promise<HTMLImageElement> {
  const image = await waitFor(() => root.querySelector<HTMLImageElement>('.report-figure img'), 'the report figure');
  Object.defineProperty(image, 'decode', { configurable: true, value: vi.fn(async () => undefined) });
  image.dispatchEvent(new Event('load'));
  await waitFor(() => store.state.reportReady, 'the decoded report figure');
  return image;
}

describe('Report', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    query.mockClear();
    // happy-dom starts in quirks mode; the real app has <!doctype html> and KaTeX checks it.
    Object.defineProperty(document, 'compatMode', { configurable: true, value: 'CSS1Compat' });
  });

  it('renders the real report Markdown, tables, code and KaTeX in the paper view', async () => {
    const { root, store } = mount();
    await waitFor(() => root.querySelector('.report-paper'), 'the report paper');

    expect(query).toHaveBeenCalledWith({ query: 'query.report' });
    expect(query).toHaveBeenCalledWith({ query: 'query.screenshot', width: 2400, height: 1350, legend: true, title: 'cantilever' });
    expect(root.querySelector('h1')!.textContent).toBe('Calculation note: cantilever');
    expect(root.querySelector('table')!.textContent).toContain('Revision');
    expect(root.querySelector('pre code')!.textContent).toContain('fem.solve.run');
    expect(root.querySelector('.katex')).not.toBeNull();
    expect(root.querySelector<HTMLImageElement>('.report-figure img')!.src).toBe(PNG);
    expect(store.state.reportReady).toBe(false);
    await loadFigure(root, store);
    expect(root.querySelector<HTMLButtonElement>('[data-cmd="report.print"]')!.disabled).toBe(false);
    expect(root.querySelector('.report-toolbar')!.textContent).toContain('from rev 9 · Markdown · query.report');
  });

  it('keeps every toolbar action in the registry and copies the exact Markdown bytes', async () => {
    const commands: Record<string, unknown>[] = [];
    const { root, store } = mount({} as ResultSummary, async (cmd) => void commands.push(cmd));
    await waitFor(() => root.querySelector('.report-paper'), 'the report paper');
    await loadFigure(root, store);

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
    const { root } = mount(null);

    expect(root.querySelector('[role="dialog"]')!.textContent).toContain('No Result to report yet');
    expect(root.textContent).toContain('Finish the model and press Solve');
    expect(query).not.toHaveBeenCalled();
    expect(root.querySelector('[data-cmd="panel.toggle"]')).not.toBeNull();
  });

  it('shows a query failure instead of an empty paper', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const store = new Store(state());
    render(<Report s={store.state} store={store} dispatch={async () => undefined} query={async () => Promise.reject(new Error('result disappeared'))} />, root);
    await waitFor(() => root.querySelector('[role="alert"]'), 'the report error');
    expect(root.querySelector('[role="alert"]')!.textContent).toContain('result disappeared');
  });

  it('keeps PDF printing unavailable until the committed figure finishes decoding', async () => {
    let finish!: () => void;
    const decoding = new Promise<void>((resolve) => void (finish = resolve));
    const { root, store } = mount();
    const image = await waitFor(() => root.querySelector<HTMLImageElement>('.report-figure img'), 'the delayed report figure');
    const decode = vi.fn(() => decoding);
    Object.defineProperty(image, 'decode', { configurable: true, value: decode });

    image.dispatchEvent(new Event('load'));
    await Promise.resolve();
    expect(decode).toHaveBeenCalledOnce();
    expect(store.state.reportReady).toBe(false);
    expect(root.querySelector<HTMLButtonElement>('[data-cmd="report.print"]')!.disabled).toBe(true);

    finish();
    await waitFor(() => store.state.reportReady, 'the delayed decode');
    expect(root.querySelector<HTMLButtonElement>('[data-cmd="report.print"]')!.disabled).toBe(false);
  });

  it('reports a figure decode failure and leaves printing unavailable', async () => {
    const { root, store } = mount();
    const image = await waitFor(() => root.querySelector<HTMLImageElement>('.report-figure img'), 'the broken report figure');
    Object.defineProperty(image, 'decode', { configurable: true, value: vi.fn(async () => Promise.reject(new Error('bad PNG'))) });
    image.dispatchEvent(new Event('load'));
    await waitFor(() => root.querySelector('[role="alert"]'), 'the image error');
    expect(root.querySelector('[role="alert"]')!.textContent).toContain('bad PNG');
    expect(store.state.reportReady).toBe(false);
    expect(root.querySelector<HTMLButtonElement>('[data-cmd="report.print"]')!.disabled).toBe(true);
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

  it('drops unsafe and encoded protocols and every untrusted image source while preserving web links', () => {
    const html = renderReportMarkdown('[one](javascript:alert(1)) [two](java%73cript:alert(2)) [three](jav&#x61;script:alert(3)) [web](https://example.com) ![bad](data:text/html,x) ![remote](https://example.com/tracker.png)');
    const template = document.createElement('template');
    template.innerHTML = html;
    expect([...template.content.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual([null, null, null, 'https://example.com']);
    expect([...template.content.querySelectorAll('img')].every((image) => !image.hasAttribute('src'))).toBe(true);
  });

  it('splits the viewer figure between Results and Verification', () => {
    expect(splitForFigure('# Note\n\n## Results\n\nvalue\n\n## Verification\n\npass')).toEqual(['# Note\n\n## Results\n\nvalue\n', '## Verification\n\npass']);
  });
});

describe('report.print host boundary', () => {
  it('returns a structured error until a mounted report is ready', () => {
    const store = new Store(state());
    const print = vi.fn();
    const host = makeHostContext(
      store,
      {} as WorkerTransport,
      { current: null },
      readHostCaps({ navigator: { userAgent: 'Chrome/140' } }),
      undefined,
      undefined,
      undefined,
      print,
    );
    expect(() => host.report.print()).toThrow(expect.objectContaining({ code: 'unsupported', where: 'report' }));
    store.set({ reportReady: true });
    host.report.print();
    expect(print).toHaveBeenCalledOnce();
  });
});
