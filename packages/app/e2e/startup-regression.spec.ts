import { expect, test } from '@playwright/test';

test('@sw a loaded tab can create tutorial projects after the network disappears', async ({ page, context }) => {
  await page.goto('./');
  await page.waitForFunction(() => !!window.fem, undefined, { timeout: 60_000 });
  await page.getByRole('button', { name: /Tutorials Nine/ }).click();
  await page.getByRole('button', { name: /Cantilever beam 6 min/ }).click();
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Do it for me', exact: true }).click();
  await expect(page.getByText('Choose display units', { exact: true })).toBeVisible({ timeout: 30_000 });
  const model = await page.evaluate(async () => {
    await window.fem.dispatch({ cmd: 'model.new', name: 'second-offline-project' });
    return window.fem.query.model();
  });
  expect(model.name).toBe('second-offline-project');
});

test('@cpu loading screen appears while the entry downloads and respects reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/assets/index-*.js', route => route.abort());
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'Preparing your workspace' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Loading application…');
  expect(await page.locator('.boot-scan').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
});
