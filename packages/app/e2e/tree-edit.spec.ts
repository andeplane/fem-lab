import { expect, test } from '@playwright/test';

test('@cpu tree edits preserve shape and optional material parameters', async ({ page }) => {
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined');
  await page.evaluate(async () => {
    await window.fem.model.new({ name: 'lossless-edit' });
    await window.fem.geometry.add({ name: 'cylinder', shape: { kind: 'cylinder', radius: '20 mm', height: '50 mm', segments: 12 } });
    await window.fem.material.add({ name: 'steel', E: '210.123456789 GPa', nu: 0.3, alpha: '1.23456789e-5 1/K', cp: '460 J/(kg K)', source: 'keep source' });
  });
  const before = await page.evaluate(async () => (await window.fem.query.model()).hash);
  await page.locator('.tree .row-main').filter({ has: page.locator('.name', { hasText: /^cylinder$/ }) }).click();
  await expect(page.locator('.props .panel-sub')).toHaveText('geometry.add');
  await page.locator('.props .apply').click();
  await expect.poll(() => page.evaluate(async () => (await window.fem.query.model()).hash)).toBe(before);
  // Wait for Apply to finish before moving to the next row; the unchanged hash alone cannot
  // tell whether the upsert ran, so also require its Journal entry.
  await expect.poll(() => page.evaluate(async () => (await window.fem.query.journal()).entries.length)).toBe(4);
  await page.locator('.tree .row-main').filter({ has: page.locator('.name', { hasText: /^steel$/ }) }).click();
  const modulus = page.locator('.props [data-field="E"] input');
  await expect(modulus).toHaveValue('210123456789 Pa');
  await modulus.fill('199.876543219 GPa');
  await page.locator('.props .apply').click();
  await expect.poll(() => page.evaluate(async () => (await window.fem.query.journal()).entries.length)).toBe(5);
  const definition = await page.evaluate(() => window.fem.query.definition({ kind: 'material', name: 'steel' }));
  expect(definition.command).toMatchObject({ cmd: 'material.add', E: { value: 199876543219, unit: 'Pa' }, alpha: { value: 1.23456789e-5, unit: '1/K' }, cp: { value: 460, unit: 'J/(kg K)' }, source: 'keep source' });
});
