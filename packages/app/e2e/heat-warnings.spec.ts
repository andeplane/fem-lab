import { expect, test } from './fixtures';

test('@cpu prescribed temperatures drive the bundled heat example without a no-load warning', async ({ page }) => {
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
  await expect(loads).not.toContainText('1 warning');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'solve.run', step: 'transient', solver: 'cpu-direct' }));
  const result = await page.evaluate(() => window.fem.query.result());
  expect(result.extremes.find(extreme => extreme.field === 'temperature')?.max.value).toBeGreaterThan(0);
  await expect(page.locator('.banner').filter({ hasText: 'W-1400' })).toHaveCount(0);
});
