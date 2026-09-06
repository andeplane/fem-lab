import { expect, test } from '@playwright/test';

test('@cpu mesh accuracy warning previews a supported quadratic switch', async ({ page }, testInfo) => {
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'file.openExample', name: 'cantilever' }));
  const args = { mesher: { kind: 'lattice', size: '25 mm' }, order: 1, formulation: 'full' };
  await page.evaluate((args) => window.fem.dispatch({ cmd: 'form.open', command: 'mesh.set', args }), args);
  const journal = await page.evaluate(() => window.fem.query.journal());
  const warning = page.locator('.props [data-field="order"] [role="status"]');
  await expect(warning).toContainText('can lock in bending');
  await page.screenshot({ path: testInfo.outputPath('mesh-warning.png') });
  await warning.getByRole('button', { name: 'Switch to quadratic' }).click();
  await expect(warning).toHaveCount(0);
  await expect(page.locator('.props [data-field="order"] input')).toHaveValue('2');
  expect(await page.evaluate(() => window.fem.query.journal())).toEqual(journal);
  await page.locator('.props button.apply').click();
  await expect.poll(() => page.evaluate(async () => (await window.fem.query.journal()).entries.at(-1)?.cmd)).toEqual({ cmd: 'mesh.set', ...args, order: 2 });
  expect((await page.evaluate(() => window.fem.query.journal())).entries).toHaveLength(journal.entries.length + 1);
});
