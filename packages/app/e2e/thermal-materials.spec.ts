import { expect, test } from './fixtures';

test('@cpu heat example shows conductivity and specific heat in its material row', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
  await page.evaluate(() => window.fem.dispatch({ cmd: 'file.openExample', name: 'bar-transient-heat' }));
  const material = page.locator('.tree .row-main').filter({ has: page.locator('.name', { hasText: /^slab$/ }) });
  await expect(material).toContainText('k 35 W/(m K)');
  await expect(material).toContainText('cp 440.5 J/(kg K)');
  const summary = material.locator('.material-summary');
  expect(await summary.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe('normal');
  expect(await summary.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const snapshot = await page.evaluate(() => window.fem.query.model());
  expect(snapshot.materials[0]!.k).toEqual({ value: 35, unit: 'W/(m K)' });
  expect(snapshot.materials[0]!.cp).toEqual({ value: 440.5, unit: 'J/(kg K)' });
  await page.screenshot({ path: testInfo.outputPath('heat-material-properties.png') });
});
