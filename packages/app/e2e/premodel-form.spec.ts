import { expect, test } from '@playwright/test';

test('@cpu model.new can be reviewed and edited from the palette before the first Model', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto('./');
  await page.waitForFunction(async () => typeof window.fem !== 'undefined' && Boolean(await window.fem.query.capabilities()));
  await page.evaluate(() => window.fem.dispatch({ cmd: 'panel.toggle', panel: 'assistant', open: true }));
  const drawer = page.locator('.assistant');
  await expect(drawer).toBeVisible();
  await drawer.locator('textarea').fill('Keep this draft while reviewing a new Model.');
  await drawer.evaluate((node) => node.setAttribute('data-mount-check', 'original'));
  await page.evaluate(async () => {
    await window.fem.dispatch({ cmd: 'panel.resize', panel: 'assistant', size: 520 });
    await window.fem.dispatch({ cmd: 'panel.resize', panel: 'properties', size: 420 });
  });
  const checkLayout = async (withForm: boolean) => {
    for (const width of [1320, 1494, 1800]) {
      await page.setViewportSize({ width, height: 1000 });
      const start = await page.locator('.start').boundingBox();
      const assistant = await drawer.boundingBox();
      expect(start!.x + start!.width).toBeLessThanOrEqual(assistant!.x + 1);
      if (withForm) {
        const props = await page.locator('.props').boundingBox();
        expect(props!.width).toBeCloseTo(420, 0);
        expect(props!.x + props!.width).toBeLessThanOrEqual(assistant!.x + 1);
      }
    }
  };
  await checkLayout(false);

  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.locator('input').fill('model.new');
  await palette.locator('input').press('Tab');
  await expect(palette).toBeHidden();
  await expect(page.locator('.start')).toBeVisible();
  await expect(page.locator('.props')).toBeVisible();
  await expect(page.locator('.props .panel-sub')).toHaveText('model.new');
  await checkLayout(true);
  await expect(page.locator('.shell')).toHaveCount(0);
  expect(await page.evaluate(() => window.fem.query.journal())).toMatchObject({ entries: [] });

  await page.locator('.props [data-field="name"] input').fill('reviewed-model');
  await expect(page.locator('.recorded-cmd')).toContainText('reviewed-model');
  expect(await page.evaluate(() => window.fem.query.journal())).toMatchObject({ entries: [] });
  const props = await page.locator('.props').boundingBox();
  const assistant = await drawer.boundingBox();
  expect(props!.x + props!.width).toBeLessThanOrEqual(assistant!.x);
  await page.screenshot({ path: testInfo.outputPath('premodel-preview.png') });

  await page.locator('.props button.apply').click();
  await expect(page.locator('.shell')).toBeVisible();
  await expect.poll(async () => (await page.evaluate(() => window.fem.query.model())).name).toBe('reviewed-model');
  expect(await page.evaluate(() => window.fem.query.journal())).toMatchObject({ entries: [{ cmd: { cmd: 'model.new', name: 'reviewed-model' } }] });
  await expect(drawer).toHaveAttribute('data-mount-check', 'original');
  await expect(drawer.locator('textarea')).toHaveValue('Keep this draft while reviewing a new Model.');
});
