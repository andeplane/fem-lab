import { expect, test } from './fixtures';

test('@cpu prescribed temperatures drive the bundled heat example without a no-load warning', async ({ page }) => {
  await page.setViewportSize({ width: 1720, height: 1000 });
  await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'example.open', name: 'bar-transient-heat' }));
  const model = await page.evaluate(() => window.fem.query.model());
  expect(model.loads).toHaveLength(0);
  expect(model.constraints).toHaveLength(2);
  expect(model.warnings.map(warning => warning.code)).not.toContain('model.unloaded');
  await expect(page.locator('.banner').filter({ hasText: 'W-1400' })).toHaveCount(0);
  const loads = page.locator('.tree-group').filter({ has: page.locator('.group-label', { hasText: /^Loads$/ }) });
  await expect(loads).toHaveCount(1);
  // This benchmark is driven by boundary temperatures and intentionally has no Loads.
  await expect(loads.locator('.badge')).toHaveText('—');
  await expect(loads.locator('.badge.warn')).toHaveCount(0);
  const material = page.locator('#tree-materials-items .row').filter({ has: page.locator('.name', { hasText: /^slab$/ }) });
  await expect(material.locator('.summary')).toContainText('W/(m K)');
  await expect(material.locator('.summary')).toContainText('J/(kg K)');
  await material.locator('.row-main').click();
  await expect(page.locator('.props [data-field="k"] input')).toHaveValue(/W\/\(m K\)/);
  await expect(page.locator('.props [data-field="cp"] input')).toHaveValue(/J\/\(kg K\)/);
  const drawer = page.locator('.assistant');
  await expect(drawer).toHaveCount(0);
  await material.locator('[data-cmd="chat.insertMention"]').click();
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('.tokens .token')).toContainText('@material:slab');
  await expect(drawer.locator('textarea')).toBeFocused();
  await page.evaluate(() => window.fem.dispatch({ cmd: 'solve.run', step: 'transient', solver: 'cpu-direct' }));
  const result = await page.evaluate(() => window.fem.query.result());
  expect(result.extremes.find(extreme => extreme.field === 'temperature')?.max.value).toBeGreaterThan(0);
  await expect(page.locator('.banner')).toHaveCount(0);
  await expect(page.locator('.tree .badge.warn')).toHaveCount(0);
});
