import { expect, test, type Page } from '@playwright/test';

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
  await page.waitForFunction(async () => Boolean(await window.fem.query.capabilities()), undefined, { timeout: 60_000 });
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
});
