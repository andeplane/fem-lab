import { expect, test } from '@playwright/test';

async function ready(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
  await page.waitForFunction(async () => Boolean(await window.fem.query.capabilities()), undefined, { timeout: 60_000 });
}

test('@cpu Journal comparison keeps the explicit baseline and does not import the comparison file', async ({ page }) => {
  await ready(page);
  await page.evaluate(async () => {
    await window.fem.model.new({ name: 'comparison' });
    await window.fem.geometry.addBox({ name: 'beam', size: ['1 m', '100 mm', '100 mm'] });
  });
  const download = page.waitForEvent('download');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'file.save' }));
  const saved = await (await download).path();
  expect(saved).toBeTruthy();
  const { readFile } = await import('node:fs/promises');
  const savedFile = await readFile(saved!, 'utf8');

  await page.evaluate(() => window.fem.model.setName({ name: 'edited' }));
  const before = await page.evaluate(() => window.fem.query.journal());
  await page.evaluate((json) => window.fem.dispatch({ cmd: 'file.compare', json }), savedFile);
  const after = await page.evaluate(() => window.fem.query.journal());
  const diff = await page.evaluate(() => window.fem.registry.query({ query: 'query.journalComparison' }));

  expect(after).toEqual(before);
  expect(diff).toMatchObject({ sharedEntries: 2, removed: [], added: [{ cmd: { cmd: 'model.setName' } }] });
  await page.evaluate(() => window.fem.journal.undo({ steps: 1 }));
  await expect.poll(() => page.evaluate(() => window.fem.registry.query({ query: 'query.journalComparison' }))).toMatchObject({ sharedEntries: 2, added: [] });
  await expect(page.locator('.comparison-label')).toContainText('Since last explicit save/open');
});
