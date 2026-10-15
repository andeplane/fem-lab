import { expect, test } from './fixtures';

test('@cpu native deformation range retains commanded fractions, true scale and large values', async ({ page }, info) => {
  await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
  await page.goto('./');
  await page.waitForFunction(() => Boolean(window.fem));
  await page.evaluate(() => window.fem.dispatch({ cmd: 'example.open', name: 'cantilever' }));
  await page.getByRole('tab', { name: /^results/ }).click();
  const journal = await page.evaluate(() => window.fem.query.journal());
  const result = await page.evaluate(() => window.fem.query.result());
  const slider = page.getByRole('slider', { name: 'exaggeration', exact: true });
  let trueScale: unknown;
  let enlarged: unknown;
  for (const scale of [0.5, 1, 1000]) {
    await page.evaluate(scale => window.fem.dispatch({ cmd: 'view.setDeformScale', scale }), scale);
    await expect(slider).toHaveValue(String(scale));
    await expect(page.locator('.deform-bar > .mono')).toHaveText(`×${scale}`);
    await expect(page.locator('.legend-sub')).toContainText(scale === 1 ? 'true scale' : `exaggerated ×${scale}`);
    await expect(page.locator('.result-header')).toContainText(scale === 1 ? 'drawn at true scale' : `drawn exaggerated ×${scale}`);
    const image = await page.evaluate(() => window.fem.registry.query({ query: 'query.screenshot', legend: false }));
    if (scale === 1) trueScale = image;
    if (scale === 1000) enlarged = image;
  }
  await page.locator('.deform-bar button[data-cmd="view.setDeformScale"]').click();
  await expect(slider).toHaveValue('1');
  await expect(page.locator('.deform-bar > .mono')).toHaveText('×1');
  await expect(page.locator('.legend-sub')).toContainText('true scale');
  expect(enlarged).not.toEqual(trueScale);
  expect(await page.evaluate(() => window.fem.registry.query({ query: 'query.screenshot', legend: false }))).toEqual(trueScale);
  expect(await page.evaluate(() => window.fem.query.journal())).toEqual(journal);
  expect(await page.evaluate(() => window.fem.query.result())).toEqual(result);
  await page.screenshot({ path: info.outputPath('true-scale-range.png') });
});
