import { expect, test, type Page } from '@playwright/test';

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
}

function layerButton(page: Page, layer: string) {
  return page.locator(`button[data-cmd="view.toggle"]`).filter({ hasText: layer });
}

async function toggle(page: Page, layer: string, on?: boolean): Promise<void> {
  await page.evaluate(({ layer, on }) => window.fem.dispatch({ cmd: 'view.toggle', layer, ...(on === undefined ? {} : { on }) }), { layer, on });
}

test.describe('@cpu viewer layers', () => {
  test('toolbar layers flip and survive surface, body and mode rebuilds', async ({ page }) => {
    await page.goto('./');
    await ready(page);
    await page.evaluate(async () => {
      await window.fem.model.new({ name: 'layer-state' });
      await window.fem.geometry.addBox({ name: 'beam', size: ['1 m', '100 mm', '100 mm'] });
    });

    const grid = layerButton(page, 'grid');
    const edges = layerButton(page, 'edges');
    await expect(grid).toHaveAttribute('aria-pressed', 'true');
    await expect(edges).toHaveAttribute('aria-pressed', 'true');

    await grid.click();
    await expect(grid).toHaveAttribute('aria-pressed', 'false');
    await grid.click();
    await expect(grid).toHaveAttribute('aria-pressed', 'true');

    // An explicit registry command is callable by scripts and the Assistant, and the toolbar
    // reflects the resulting state rather than assuming that every toggle means "show".
    await toggle(page, 'grid', false);
    await expect(grid).toHaveAttribute('aria-pressed', 'false');

    // A new surface replaces the mesh, edges, grid and axes objects. The next omitted toggle
    // must flip the preserved hidden state, which would fail if the replacement defaulted visible.
    await page.evaluate(() => window.fem.geometry.addBox({ name: 'weight', size: ['200 mm', '200 mm', '200 mm'] }));
    await expect(grid).toHaveAttribute('aria-pressed', 'false');
    await toggle(page, 'grid');
    await expect(grid).toHaveAttribute('aria-pressed', 'true');

    await toggle(page, 'edges', false);
    await expect(edges).toHaveAttribute('aria-pressed', 'false');
    await page.evaluate(() => window.fem.dispatch({ cmd: 'view.setMode', mode: 'mesh' }));
    await expect(edges).toHaveAttribute('aria-pressed', 'false');
    await toggle(page, 'edges');
    await expect(edges).toHaveAttribute('aria-pressed', 'true');

    await toggle(page, 'grid', false);
    await page.evaluate(() => window.fem.dispatch({ cmd: 'view.setVisible', bodies: ['beam'], on: false }));
    await expect(grid).toHaveAttribute('aria-pressed', 'false');
    await toggle(page, 'grid');
    await expect(grid).toHaveAttribute('aria-pressed', 'true');
  });

  test('Viewer replacement objects retain real visibility state', async ({ page }) => {
    await page.goto('./');
    const states = await page.evaluate(async () => {
      const viewerUrl = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"]'))
        .map((link) => link.href)
        .find((href) => /\/viewer-[^/]+\.js$/.test(href));
      if (!viewerUrl) throw new Error('the built Viewer module was not preloaded');
      const { Viewer } = (await import(viewerUrl)) as {
        Viewer: new (canvas: HTMLCanvasElement) => unknown;
      };
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 240;
      canvas.style.width = '320px';
      canvas.style.height = '240px';
      document.body.append(canvas);

      const viewer = new Viewer(canvas) as unknown as {
        setLayer(layer: string, on?: boolean): boolean;
        setSurface(surface: unknown): void;
        setMode(mode: 'geometry' | 'mesh' | 'results'): void;
        setVisible(bodies: string[], on: boolean): void;
        dispose(): void;
        mesh: { visible: boolean } | null;
        edges: { visible: boolean } | null;
        grid: { visible: boolean } | null;
        triad: { visible: boolean } | null;
      };
      const surface = {
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
        indices: new Uint32Array([0, 1, 2, 1, 3, 2]),
        triBody: new Uint32Array([0, 1]),
        triFace: new Uint32Array([0, 1]),
        faceNames: ['body.a.face', 'body.b.face'],
        bodyNames: ['body.a', 'body.b'],
        source: 'geometry' as const,
      };
      const snapshot = () => ({
        mesh: viewer.mesh?.visible ?? null,
        edges: viewer.edges?.visible ?? null,
        grid: viewer.grid?.visible ?? null,
        axes: viewer.triad?.visible ?? null,
      });

      viewer.setSurface(surface);
      for (const layer of ['mesh', 'edges', 'grid', 'axes']) viewer.setLayer(layer, false);
      const hidden = snapshot();
      viewer.setSurface(surface);
      const afterSurface = snapshot();
      viewer.setMode('mesh');
      const afterMode = snapshot();
      viewer.setVisible(['body.a'], false);
      const afterBody = snapshot();
      viewer.dispose();
      canvas.remove();
      return { hidden, afterSurface, afterMode, afterBody };
    });

    const hidden = { mesh: false, edges: false, grid: false, axes: false };
    expect(states).toEqual({ hidden, afterSurface: hidden, afterMode: hidden, afterBody: hidden });
  });
});
