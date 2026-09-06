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
    await page.locator('button.palette-field').focus();
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
    await page.evaluate(() => window.fem.dispatch({ cmd: 'panel.resize', panel: 'bottom', size: 480 }));
    const clampedBottom = page.locator('.resize-handle.bottom');
    const clampedBottomBox = (await page.locator('.centre > section.bottom').boundingBox())!;
    await expect(clampedBottom).toHaveAttribute('aria-valuenow', String(Math.round(clampedBottomBox.height)));
    const clampedBottomHandleBox = (await clampedBottom.boundingBox())!;
    expect(Math.abs(clampedBottomHandleBox.y + clampedBottomHandleBox.height / 2 - clampedBottomBox.y)).toBeLessThanOrEqual(1);
    const effectiveBottom = Number(await clampedBottom.getAttribute('aria-valuenow'));
    const effectiveBottomHandle = (await clampedBottom.boundingBox())!;
    await page.mouse.move(effectiveBottomHandle.x + 100, effectiveBottomHandle.y);
    await page.mouse.down();
    await page.mouse.move(effectiveBottomHandle.x + 100, effectiveBottomHandle.y + 20);
    await page.mouse.up();
    await expect(clampedBottom).toHaveAttribute('aria-valuenow', String(effectiveBottom - 20));

    await page.evaluate(() => window.fem.dispatch({ cmd: 'panel.resize', panel: 'tree', size: 420 }));
    const clampedTree = page.locator('.resize-handle.tree');
    const clampedTreeBox = (await page.locator('.workspace > .panel.tree').boundingBox())!;
    await expect(clampedTree).toHaveAttribute('aria-valuenow', String(Math.round(clampedTreeBox.width)));
    expect(Number(await clampedTree.getAttribute('aria-valuenow'))).toBeLessThan(420);
    const effectiveTree = Number(await clampedTree.getAttribute('aria-valuenow'));
    const effectiveTreeHandle = (await clampedTree.boundingBox())!;
    await page.mouse.move(effectiveTreeHandle.x + effectiveTreeHandle.width / 2, effectiveTreeHandle.y + 100);
    await page.mouse.down();
    await page.mouse.move(effectiveTreeHandle.x + effectiveTreeHandle.width / 2 - 20, effectiveTreeHandle.y + 100);
    await page.mouse.up();
    await expect(clampedTree).toHaveAttribute('aria-valuenow', String(effectiveTree - 20));

    const assistantHandle = page.locator('.resize-handle.assistant-resize');
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
      if (width === 1180) {
        await page.evaluate(() => Promise.all([
          window.fem.dispatch({ cmd: 'panel.resize', panel: 'tree', size: 420 }),
          window.fem.dispatch({ cmd: 'panel.resize', panel: 'properties', size: 440 }),
        ]));
        const treeHandle = page.locator('.resize-handle.tree');
        const propertiesHandle = page.locator('.resize-handle.properties');
        const treePanel = (await page.locator('.workspace > .panel.tree').boundingBox())!;
        const propertiesPanel = (await page.locator('.workspace > .panel.props').boundingBox())!;
        await expect(treeHandle).toHaveAttribute('aria-valuenow', String(Math.round(treePanel.width)));
        await expect(propertiesHandle).toHaveAttribute('aria-valuenow', String(Math.round(propertiesPanel.width)));
        expect(Math.round(treePanel.width)).toBe(220);
        expect(Math.round(propertiesPanel.width)).toBe(240);
        const treeStart = Number(await treeHandle.getAttribute('aria-valuenow'));
        const treeBox = (await treeHandle.boundingBox())!;
        await page.mouse.move(treeBox.x + treeBox.width / 2, treeBox.y + 100);
        await page.mouse.down();
        await page.mouse.move(treeBox.x + treeBox.width / 2 - 50, treeBox.y + 100);
        await page.mouse.up();
        await expect(treeHandle).toHaveAttribute('aria-valuenow', String(treeStart - 40));
      }
    }
  });
});
