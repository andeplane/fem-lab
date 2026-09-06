import { expect, test, type Page } from '@playwright/test';

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
  await page.waitForFunction(async () => Boolean(await window.fem.query.capabilities()), undefined, { timeout: 60_000 });
}

async function canvasIsSized(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.locator('.viewer canvas').evaluate((el) => {
        const canvas = el as HTMLCanvasElement;
        const scale = Math.min(devicePixelRatio, 2);
        return [canvas.width - Math.round(canvas.clientWidth * scale), canvas.height - Math.round(canvas.clientHeight * scale)];
      }),
    )
    .toEqual([0, 0]);
}

test.describe('@cpu panel resizing', () => {
  test('drag, keyboard and cancel preserve defaults, Journal and viewer backing size', async ({ page }) => {
    await page.goto('./');
    await ready(page);
    await page.evaluate(() => window.fem.model.new({ name: 'panel-resize' }));
    await page.setViewportSize({ width: 1600, height: 900 });
    await expect(page.locator('.resize-handle.tree')).toHaveAttribute('aria-valuenow', '274');
    await expect(page.locator('.resize-handle.properties')).toHaveAttribute('aria-valuenow', '308');
    await expect(page.locator('.resize-handle.bottom')).toHaveAttribute('aria-valuenow', '252');
    const journalBefore = (await page.evaluate(() => window.fem.query.journal())) as unknown as { entries: unknown[] };
    const treeBefore = (await page.locator('.workspace > .panel.tree').boundingBox())!;
    const treeHandle = page.locator('.resize-handle.tree');
    const treeHandleBox = (await treeHandle.boundingBox())!;
    await page.mouse.move(treeHandleBox.x + treeHandleBox.width / 2, treeHandleBox.y + 100);
    await page.mouse.down();
    await page.mouse.move(treeHandleBox.x + treeHandleBox.width / 2 + 60, treeHandleBox.y + 100);
    await page.mouse.up();
    await expect(treeHandle).toHaveAttribute('aria-valuenow', '334');
    expect((await page.locator('.workspace > .panel.tree').boundingBox())!.width).toBe(treeBefore.width + 60);
    await treeHandle.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(treeHandle).toHaveAttribute('aria-valuenow', '324');
    expect(((await page.evaluate(() => window.fem.query.journal())) as unknown as { entries: unknown[] }).entries).toHaveLength(journalBefore.entries.length);

    const cancelStart = Number(await treeHandle.getAttribute('aria-valuenow'));
    const cancelBox = (await treeHandle.boundingBox())!;
    await page.mouse.move(cancelBox.x + cancelBox.width / 2, cancelBox.y + 100);
    await page.mouse.down();
    await page.mouse.move(cancelBox.x + cancelBox.width / 2 + 90, cancelBox.y + 100);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(treeHandle).toHaveAttribute('aria-valuenow', String(cancelStart));

    const bottomHandle = page.locator('.resize-handle.bottom');
    const bottomStart = Number(await bottomHandle.getAttribute('aria-valuenow'));
    const bottomBox = (await bottomHandle.boundingBox())!;
    await page.mouse.move(bottomBox.x + 100, bottomBox.y);
    await page.mouse.down();
    await page.mouse.move(bottomBox.x + 100, bottomBox.y - 40);
    await page.mouse.up();
    await expect(bottomHandle).toHaveAttribute('aria-valuenow', String(bottomStart + 40));
    await canvasIsSized(page);

    await page.getByRole('button', { name: '✳ Assistant', exact: true }).click();
    const assistant = page.locator('aside.assistant');
    await expect(assistant).toBeVisible();
    await expect(assistant).toHaveCSS('width', '392px');
    const assistantHandle = page.locator('.resize-handle.assistant');
    const assistantBox = (await assistantHandle.boundingBox())!;
    await page.mouse.move(assistantBox.x + assistantBox.width / 2, assistantBox.y + 100);
    await page.mouse.down();
    await page.mouse.move(assistantBox.x + assistantBox.width / 2 - 40, assistantBox.y + 100);
    await page.mouse.up();
    await expect(assistant).toHaveCSS('width', '432px');
    const drawer = (await assistant.boundingBox())!;
    const workspace = (await page.locator('.workspace').boundingBox())!;
    expect(Math.round(drawer.x + drawer.width)).toBe(1600);
    expect(Math.round(workspace.x + workspace.width)).toBe(Math.round(drawer.x));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1600);
    await canvasIsSized(page);
  });

  test('keeps the supported 1180 and 1600 layouts inside the viewport', async ({ page }) => {
    await page.goto('./');
    await ready(page);
    await page.evaluate(() => window.fem.model.new({ name: 'panel-overflow' }));
    for (const width of [1180, 1600]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator('.workspace')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await canvasIsSized(page);
    }
  });
});
