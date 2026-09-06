// The handoff's Step drag is a Model edit: one completed gesture produces one `step.reorder`,
// keyboard users get the same Command, and a dependency error leaves the engine order visible.
import { expect, test, type Page } from '@playwright/test';

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
  await page.waitForFunction(async () => Boolean(await window.fem.query.capabilities()), undefined, { timeout: 60_000 });
}

async function stepNames(page: Page): Promise<string[]> {
  return page.locator('[data-step] .name').allTextContents();
}

async function journalLength(page: Page): Promise<number> {
  return page.evaluate(async () => (await window.fem.query.journal()).entries.length);
}

test.describe('@cpu Step run order', () => {
  test('drag and keyboard reorder once while dependency errors preserve the Model order', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
    await page.goto('./');
    await ready(page);
    await page.evaluate(async () => {
      await window.fem.model.new({ name: 'step-order' });
      await window.fem.step.add({ name: 'heat', procedure: 'heat-steady', constraints: [], loads: [] });
      await window.fem.step.add({ name: 'static', procedure: 'static', constraints: [], loads: [], after: 'heat' });
      await window.fem.step.add({ name: 'modal', procedure: 'modal', constraints: [], loads: [] });
    });
    await expect.poll(() => stepNames(page)).toEqual(['heat', 'static', 'modal']);
    const before = await journalLength(page);

    await page.locator('[data-step="modal"]').dragTo(page.locator('[data-step="heat"]'), {
      targetPosition: { x: 20, y: 2 },
    });
    await expect.poll(() => stepNames(page)).toEqual(['modal', 'heat', 'static']);
    await expect.poll(() => journalLength(page)).toBe(before + 1);
    const dragCommand = await page.evaluate(async () => (await window.fem.query.journal()).entries.at(-1)?.cmd);
    expect(dragCommand).toEqual({ cmd: 'step.reorder', order: ['modal', 'heat', 'static'] });

    await page.getByRole('button', { name: 'Move static earlier' }).click();
    await expect(page.locator('.banner.error')).toContainText("step 'static' must run after its prerequisite 'heat'");
    await expect.poll(() => journalLength(page)).toBe(before + 1);
    expect(await stepNames(page)).toEqual(['modal', 'heat', 'static']);

    await page.getByRole('button', { name: 'Move modal later' }).click();
    await expect.poll(() => stepNames(page)).toEqual(['heat', 'modal', 'static']);
    await expect.poll(() => journalLength(page)).toBe(before + 2);
  });
});
