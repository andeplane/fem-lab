import { expect, test, type Page } from '@playwright/test';

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
  await page.waitForFunction(async () => Boolean(await window.fem.query.capabilities()), undefined, { timeout: 60_000 });
}

test('@cpu the Geometry add menu closes on Escape and restores chip focus', async ({ page }) => {
  await page.goto('./');
  await ready(page);
  await page.evaluate(() => window.fem.model.new({ name: 'add-menu-escape' }));
  const journalBefore = await page.evaluate(() => window.fem.query.journal());
  const chip = page.locator('.chip-add', { hasText: '+ add body' });
  await chip.click();
  await expect(page.locator('.add-menu')).toBeVisible();
  await page.locator('.add-menu .menu-item').first().focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('.add-menu')).toBeHidden();
  await expect(chip).toBeFocused();
  await expect.poll(async () => page.evaluate(() => window.fem.query.journal())).toEqual(journalBefore);
  await expect(page.locator('.props')).toContainText('geometry.addBox');
});
