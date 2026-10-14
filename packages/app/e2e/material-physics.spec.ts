import { expect, test } from '@playwright/test';

test('@cpu Material physics chips lead with heat properties and preserve hidden definition values', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined');
  await page.evaluate(async () => {
    await window.fem.model.new({ name: 'heat material form' });
    await window.fem.step.add({ name: 'heat', procedure: 'heat-steady', constraints: [], loads: [] });
    await window.fem.dispatch({ cmd: 'form.open', command: 'material.add', args: { name: 'conductor' } });
  });
  const panel = page.locator('.props');
  await expect(panel.locator('[data-field="k"]')).toBeVisible();
  await expect(panel.locator('[data-field="cp"]')).toBeVisible();
  await expect(panel.locator('[data-field="rho"]')).toBeVisible();
  await expect(panel.locator('[data-field="E"]')).toHaveCount(0);
  await expect(panel.locator('.props-body > [data-field]').first()).toHaveAttribute('data-field', 'name');
  expect(await panel.locator('.props-body > [data-field]').evaluateAll(fields => fields.map(field => field.getAttribute('data-field')))).toEqual(['name', 'k', 'cp', 'rho', 'source']);
  await page.evaluate(async () => {
    await window.fem.material.add({ name: 'steel', E: '210 GPa', nu: 0.3, k: '45 W/(m K)', cp: '460 J/(kg K)', rho: '7850 kg/m^3', source: 'EN 10025' });
    await window.fem.dispatch({ cmd: 'form.edit', kind: 'material', name: 'steel' });
  });
  const journal = await page.evaluate(() => window.fem.query.journal());
  const stiffness = panel.getByRole('button', { name: 'stiffness', exact: true });
  await expect(stiffness).toHaveAttribute('aria-pressed', 'true');
  await stiffness.click();
  await expect(panel.locator('[data-field="E"]')).toHaveCount(0);
  await panel.locator('[data-field="k"] input').fill('50 W/(m K)');
  await expect.poll(() => page.evaluate(() => window.fem.query.journal())).toEqual(journal);
  await panel.getByRole('button', { name: 'Revert', exact: true }).click();
  await expect(panel.locator('[data-field="k"] input')).toHaveValue('45 W/(m K)');
  await expect(stiffness).toHaveAttribute('aria-pressed', 'false');
  await panel.locator('[data-field="k"] input').fill('50 W/(m K)');
  await panel.locator('.apply').click();
  await expect.poll(() => page.evaluate(() => window.fem.query.definition({ kind: 'material', name: 'steel' }))).toMatchObject({ command: { cmd: 'material.add', name: 'steel', E: { value: 210e9, unit: 'Pa' }, nu: 0.3, k: { value: 50, unit: 'W/(m K)' }, cp: { value: 460, unit: 'J/(kg K)' }, rho: { value: 7850, unit: 'kg/m^3' }, source: 'EN 10025' } });
  await stiffness.click();
  await expect(panel.locator('[data-field="E"] input')).toHaveValue('210000000000 Pa');
  await page.evaluate(async () => {
    await window.fem.dispatch({ cmd: 'example.open', name: 'heated-fin-convection' });
    await window.fem.dispatch({ cmd: 'form.edit', kind: 'material', name: 'aluminium' });
  });
  expect(await panel.locator('.props-body > [data-field]').evaluateAll(fields => fields.slice(0, 3).map(field => field.getAttribute('data-field')))).toEqual(['name', 'k', 'cp']);
  await page.screenshot({ path: 'test-results/material-physics-heat.png', fullPage: true });
  expect(errors).toEqual([]);
});
