import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('@cpu editable Model name and explicit save baseline survive rename, undo and open', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto('./');
  await page.waitForFunction(async () => typeof window.fem !== 'undefined' && Boolean(await window.fem.query.capabilities()));
  await page.evaluate(async () => {
    await window.fem.model.new({ name: 'original' });
    await window.fem.geometry.addBox({ name: 'beam', size: ['1 m', '100 mm', '100 mm'] });
  });
  const name = page.getByRole('textbox', { name: 'Model name', exact: true });
  const dirty = page.getByRole('img', { name: 'Unsaved changes' });
  await expect(dirty).toBeVisible();
  const before = await page.evaluate(() => window.fem.query.model());
  const journal = await page.evaluate(() => window.fem.query.journal());
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save', exact: true }).click()]);
  const saved = JSON.parse(await readFile((await download.path())!, 'utf8'));
  await expect(dirty).toBeHidden();
  await page.evaluate(async () => {
    await window.fem.dispatch({ cmd: 'view.fit' });
    await window.fem.dispatch({ cmd: 'panel.toggle', panel: 'palette', open: true });
    await window.fem.dispatch({ cmd: 'panel.toggle', panel: 'palette', open: false });
  });
  await expect(dirty).toBeHidden();
  await name.fill('discard me');
  await name.press('Escape');
  await expect(name).toHaveValue('original');
  expect(await page.evaluate(() => window.fem.query.journal())).toEqual(journal);
  await name.fill('Renamed beam');
  await name.press('Enter');
  await expect(dirty).toBeVisible();
  await expect.poll(async () => (await page.evaluate(() => window.fem.query.model())).name).toBe('Renamed beam');
  const renamed = await page.evaluate(() => window.fem.query.model());
  expect(renamed.bodies).toEqual(before.bodies);
  expect(renamed.hash).not.toBe(before.hash);
  await page.screenshot({ path: testInfo.outputPath('model-name-unsaved.png') });
  expect((await page.evaluate(() => window.fem.query.journal())).entries).toHaveLength(journal.entries.length + 1);
  await page.evaluate(() => window.fem.dispatch({ cmd: 'journal.undo' }));
  await expect(name).toHaveValue('original');
  await expect(dirty).toBeHidden();
  await page.evaluate(() => window.fem.dispatch({ cmd: 'journal.redo' }));
  await expect(name).toHaveValue('Renamed beam');
  await expect(dirty).toBeVisible();
  // A hand-authored file can omit serde defaults; the import receipt carries normalized entries.
  delete saved.journal.entries[0].cmd.description;
  await page.evaluate((json) => window.fem.dispatch({ cmd: 'file.open', json }), JSON.stringify(saved));
  await expect(name).toHaveValue('original');
  await expect(dirty).toBeHidden();
  expect((await page.evaluate(() => window.fem.query.model())).bodies).toEqual(before.bodies);
  await name.fill('Second save');
  await name.blur();
  await expect(dirty).toBeVisible();
  await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save', exact: true }).click()]);
  await expect(dirty).toBeHidden();
});
