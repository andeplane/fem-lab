import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileDelivery, Registry } from '@femlab/registry';
import { CompletedFileRow } from '../src/ai/CompletedFileRow';
import { createCompletedFiles } from '../src/completed-files';

const file: FileDelivery = { name: 'reports/<original>.txt', mime: 'text/plain', bytes: 9, to: 'folder', id: 'file-id' };
const metadata = { id: file.id!, name: file.name, mime: file.mime!, bytes: file.bytes! };
const roots: HTMLElement[] = [];
afterEach(() => { for (const root of roots.splice(0)) { render(null, root); root.remove(); } });
function harness(query = vi.fn(async (): Promise<unknown> => ({ file: metadata }))) {
  const root = document.createElement('div'); document.body.append(root); roots.push(root);
  const registry: Pick<Registry, 'query'> = { query };
  const dispatch = vi.fn(async (_command: { cmd: string } & Record<string, unknown>): Promise<unknown> => undefined);
  const draw = (receipt = file, version = 0, target = registry) => render(<CompletedFileRow file={receipt} registry={target} dispatch={dispatch} version={version} />, root);
  const download = () => root.querySelector<HTMLButtonElement>('[data-cmd="file.download"]')!;
  draw();
  return { root, registry, dispatch, draw, download, query };
}

describe('completed file row', () => {
  it('shows exact bytes and escaped original name and uses registered copy/download Commands', async () => {
    const h = harness();
    await vi.waitFor(() => expect(h.download().disabled).toBe(false));
    expect(h.query).toHaveBeenCalledWith({ query: 'query.fileDelivery', id: 'file-id' });
    expect(h.root.textContent).toContain('9 B');
    expect(h.root.querySelector('.path')!.textContent).toBe('reports/<original>.txt');
    expect(h.root.querySelector('original')).toBeNull();
    expect(h.root.textContent).toContain('project folder');
    h.root.querySelector<HTMLButtonElement>('[data-cmd="clipboard.copy"]')!.click();
    expect(h.dispatch).toHaveBeenCalledWith({ cmd: 'clipboard.copy', what: { kind: 'text', text: file.name } });
    h.download().click();
    expect(h.dispatch).toHaveBeenCalledWith({ cmd: 'file.download', id: 'file-id' });
    await vi.waitFor(() => expect(h.download().disabled).toBe(false));
    expect(h.root.textContent).not.toContain('delivered');
  });

  it('leaves legacy receipts visibly unavailable without guessing size', () => {
    const h = harness();
    h.draw({ name: 'old.txt', to: 'download' });
    expect(h.root.textContent).toContain('Size unavailable');
    expect(h.root.textContent).toContain('no retained file');
    expect(h.download().disabled).toBe(true);
  });

  it('disables null or invalid metadata and receipts outside the retention policy', async () => {
    const h = harness(vi.fn(async () => ({ file: null })));
    await vi.waitFor(() => expect(h.root.textContent).toContain('expired or is not retained'));
    expect(h.download().disabled).toBe(true);
    h.draw({ ...file, unavailable: 'oversize', bytes: 20_000_000 });
    expect(h.root.textContent).toContain('20000000 B');
    expect(h.root.textContent).toContain('exceeds the retention limit');
    expect(h.download().disabled).toBe(true);
  });

  it('cannot restore availability from a deferred old version or registry query', async () => {
    let resolveOld!: (value: unknown) => void;
    const h = harness(vi.fn(() => new Promise<unknown>(resolve => { resolveOld = resolve; })));
    await vi.waitFor(() => expect(h.query).toHaveBeenCalledTimes(1));
    const nextQuery = vi.fn(async () => ({ file: null }));
    const nextRegistry: Pick<Registry, 'query'> = { query: nextQuery };
    h.draw(file, 1, nextRegistry);
    expect(h.download().disabled).toBe(true);
    await vi.waitFor(() => expect(nextQuery).toHaveBeenCalledTimes(1));
    resolveOld({ file: metadata });
    await vi.waitFor(() => expect(h.root.textContent).toContain('expired or is not retained'));
    expect(h.download().disabled).toBe(true);
  });

  it('handles eviction after the query as local unavailable state without a success claim', async () => {
    const h = harness();
    await vi.waitFor(() => expect(h.download().disabled).toBe(false));
    h.dispatch.mockRejectedValueOnce({ code: 'file.not-found', cause: 'expired' });
    h.download().click();
    await vi.waitFor(() => expect(h.root.textContent).toContain('expired or delivery failed'));
    expect(h.download().disabled).toBe(true);
    expect(h.root.textContent).not.toContain('Downloaded');
  });

  it('ignores an old availability response when only the cache version changes', async () => {
    let resolveOld!: (value: unknown) => void;
    const query = vi.fn(async (): Promise<unknown> => ({ file: null }));
    query.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    const h = harness(query);
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    h.draw(file, 1);
    expect(h.download().disabled).toBe(true);
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2));
    resolveOld({ file: metadata });
    await vi.waitFor(() => expect(h.root.textContent).toContain('expired or is not retained'));
    expect(h.download().disabled).toBe(true);
  });

  it('accepts an actual repeated-download basename while metadata retains the original folder path', async () => {
    const deliver = vi.fn((_name: string, _mime: string, _data: string | Uint8Array) => undefined);
    const cache = createCompletedFiles({ download: deliver, nextId: () => 'repeat' });
    const original = cache.capture()({ name: 'reports/a.txt', to: 'folder', mime: 'text/plain', data: 'original' }).complete();
    const repeated = cache.download(original.id!);
    expect(repeated.name).toBe('a.txt');
    expect(cache.info(repeated.id!)!.name).toBe('reports/a.txt');
    const h = harness(vi.fn(async () => ({ file: cache.info(repeated.id!) })));
    h.draw(repeated);
    await vi.waitFor(() => expect(h.download().disabled).toBe(false));
    expect(h.root.querySelector('.path')!.textContent).toBe('a.txt');
    h.download().click();
    expect(h.dispatch).toHaveBeenCalledWith({ cmd: 'file.download', id: original.id });
    expect(deliver).toHaveBeenCalledWith('a.txt', 'text/plain', 'original');
    cache.dispose();
  });
});
