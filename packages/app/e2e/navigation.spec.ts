import { expect, test } from './fixtures';

test.describe('@cpu workspace navigation', () => {
  test.setTimeout(120_000);
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
    await page.setViewportSize({ width: 1600, height: 1000 });
  });

  test('logo, Back, Forward and refresh preserve an edited solved example', async ({ page }) => {
    await page.goto('./#/examples');
    await expect(page.locator('.gallery')).toBeVisible();
    await page.locator('button[title="file.openExample cantilever"]').click();
    await expect(page.locator('button.solve')).toHaveText(/Solved · rev \d+/);
    await expect(page).toHaveURL(/#\/projects\/[^/]+$/);
    const projectUrl = page.url();
    await page.evaluate(() => window.fem.dispatch({ cmd: 'model.setName', name: 'Edited example' }));
    await page.evaluate(() => window.fem.dispatch({ cmd: 'project.save' }));
    const before = await page.evaluate(async () => ({ model: await window.fem.query.model(), journal: await window.fem.query.journal(), results: await window.fem.registry.query({ query: 'query.results' }) }));
    const logo = page.getByRole('button', { name: 'FEM Lab — main menu' });
    await logo.focus(); await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.getByRole('dialog', { name: 'Projects', exact: true })).toBeVisible();
    await expect(page.locator('[data-cmd="project.downloadBundle"]').first()).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(projectUrl);
    await expect(page.getByRole('dialog', { name: 'Projects', exact: true })).toHaveCount(0);
    await page.goForward();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.getByRole('dialog', { name: 'Projects', exact: true })).toBeVisible();
    await page.goBack(); await expect(page).toHaveURL(projectUrl);
    await page.reload();
    await expect(page.locator('.workspace')).toBeVisible();
    await expect.poll(async () => page.evaluate(() => window.fem.query.model())).toEqual(before.model);
    const after = await page.evaluate(async () => ({ journal: await window.fem.query.journal(), results: await window.fem.registry.query({ query: 'query.results' }) }));
    expect(after.journal).toEqual(before.journal);
    expect(after.results).toEqual(before.results);
    await page.goBack();
    await expect(page).toHaveURL(/#\/examples$/);
    await expect(page.locator('.gallery')).toBeVisible();
    await page.screenshot({ path: 'test-results/navigation-gallery.png' });
  });

  test('direct menu/gallery routes and missing project routes work under the hosting directory', async ({ page }) => {
    await page.goto('./#/examples');
    await expect(page.locator('.gallery')).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search examples' }).fill('cantilever hex20');
    await expect(page.locator('.ex-card')).toHaveCount(1);
    await page.reload();
    await expect(page.locator('.gallery')).toBeVisible();
    await page.getByRole('button', { name: 'Close examples' }).click();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.locator('.start')).toBeVisible();
    await page.goto('./#/projects/does-not-exist');
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.locator('.start')).toBeVisible();
    expect(await page.evaluate(() => window.fem.query.model())).toMatchObject({ bodies: [] });
  });

  test('gallery search stays usable on a narrow screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('./#/examples');
    const search = page.getByRole('searchbox', { name: 'Search examples' });
    await search.fill('CANTILEVER hex20');
    await expect(page.locator('.ex-card')).toHaveCount(1);
    await expect(search).toBeInViewport();
    const bounds = await search.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: 'test-results/navigation-search-mobile.png' });
  });
});
