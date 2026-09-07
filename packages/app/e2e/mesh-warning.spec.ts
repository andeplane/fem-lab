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
  await expect.poll(() => page.evaluate(async () => (await window.fem.query.journal()).entries.length)).toBe(journal.entries.length + 1);
  await expect.poll(() => page.evaluate(async () => (await window.fem.query.journal()).entries.at(-1)?.cmd)).toEqual({ cmd: 'mesh.set', ...args, order: 2 });
  expect((await page.evaluate(() => window.fem.query.journal())).entries).toHaveLength(journal.entries.length + 1);
});

test('@cpu tetrahedral accuracy fix produces quadratic tetrahedra on Apply', async ({ page }) => {
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined');
  await page.evaluate(async () => {
    await window.fem.model.new({ name: 'tetrahedral-accuracy' });
    await window.fem.geometry.addBox({ name: 'block', size: ['1 m', '1 m', '1 m'] });
    await window.fem.mesh.set({ mesher: { kind: 'lattice', size: '1 m' }, simplices: true, order: 1 });
  });
  expect((await page.evaluate(() => window.fem.query.mesh())).elementKind).toBe('tet4');
  await expect(page.locator('.tree .summary').filter({ hasText: 'Tet 4' })).toHaveCount(1);
  const args = { mesher: { kind: 'lattice', size: '1 m' }, simplices: true, order: 1 };
  await page.evaluate((args) => window.fem.dispatch({ cmd: 'form.open', command: 'mesh.set', args }), args);
  const journal = await page.evaluate(() => window.fem.query.journal());
  const warning = page.locator('.props [data-field="order"] [role="status"]');
  await expect(warning).toContainText('Linear tetrahedra');
  await warning.getByRole('button', { name: 'Switch to quadratic' }).click();
  expect(await page.evaluate(() => window.fem.query.journal())).toEqual(journal);
  await page.locator('.props button.apply').click();
  await expect.poll(() => page.evaluate(async () => (await window.fem.query.journal()).entries.length)).toBe(journal.entries.length + 1);
  await expect.poll(() => page.evaluate(async () => (await window.fem.query.mesh()).elementKind)).toBe('tet10');
  await expect(page.locator('.tree .summary').filter({ hasText: 'Tet 10' })).toHaveCount(1);
  const after = await page.evaluate(() => window.fem.query.journal());
  expect(after.entries).toHaveLength(journal.entries.length + 1);
  expect(after.entries.at(-1)?.cmd).toEqual({ cmd: 'mesh.set', ...args, order: 2 });
});

test('@cpu the free tet mesher warns at order 1 without needing simplices', async ({ page }) => {
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined');
  await page.evaluate(async () => {
    await window.fem.model.new({ name: 'free-tet-accuracy' });
    await window.fem.geometry.addBox({ name: 'block', size: ['1 m', '1 m', '1 m'] });
  });
  const args = { mesher: { kind: 'tet', size: '0.3 m' }, order: 1 };
  await page.evaluate((args) => window.fem.dispatch({ cmd: 'form.open', command: 'mesh.set', args }), args);
  const journal = await page.evaluate(() => window.fem.query.journal());
  const warning = page.locator('.props [data-field="order"] [role="status"]');
  await expect(warning).toContainText('Linear tetrahedra');
  await warning.getByRole('button', { name: 'Switch to quadratic' }).click();
  expect(await page.evaluate(() => window.fem.query.journal())).toEqual(journal);
  await page.locator('.props button.apply').click();
  await expect.poll(() => page.evaluate(async () => (await window.fem.query.journal()).entries.length)).toBe(journal.entries.length + 1);
  await expect.poll(() => page.evaluate(async () => (await window.fem.query.mesh()).elementKind)).toBe('tet10');
  const after = await page.evaluate(() => window.fem.query.journal());
  expect(after.entries.at(-1)?.cmd).toEqual({ cmd: 'mesh.set', ...args, order: 2 });
});
