import { expect, test } from '@playwright/test';

test('@cpu pressure-area preview follows the draft and live face area', async ({ page }, testInfo) => {
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined');
  await page.evaluate(async () => {
    await window.fem.model.new({ name: 'pressure-preview' });
    await window.fem.model.setUnits({ units: { length: 'mm', force: 'kN', stress: 'MPa' } });
    await window.fem.geometry.addBox({ name: 'beam', size: ['100 mm', '350 mm', '300 mm'] });
    await window.fem.mesh.set({ mesher: { kind: 'lattice', size: '100 mm' } });
    await window.fem.dispatch({ cmd: 'form.open', command: 'load.pressure', args: { name: 'p', on: 'beam.xmax', value: '2.4 MPa' } });
  });
  const preview = page.locator('.pressure-area');
  await expect(preview).toContainText('252.0 kN');
  await expect(preview).toContainText('1.050e+5 mm^2');
  const journal = await page.evaluate(() => window.fem.query.journal());
  await page.locator('[data-field="value"] input').fill('4.8 MPa');
  await expect(preview).toContainText('504.0 kN');
  expect(await page.evaluate(() => window.fem.query.journal())).toEqual(journal);
  await page.screenshot({ path: testInfo.outputPath('pressure-area.png') });
  await page.locator('.props button.apply').click();
  await expect.poll(() => page.evaluate(async () => (await window.fem.query.journal()).entries.length)).toBe(journal.entries.length + 1);
  expect((await page.evaluate(() => window.fem.query.journal())).entries.at(-1)?.cmd).toEqual({
    cmd: 'load.pressure',
    name: 'p',
    on: 'beam.xmax',
    value: '4.8 MPa',
  });
  await page.evaluate(() => window.fem.geometry.addBox({ name: 'beam', size: ['100 mm', '700 mm', '300 mm'] }));
  await expect(preview).toContainText('1008 kN');
  await expect(preview).toContainText('2.100e+5 mm^2');
});

test('@cpu pressure preview includes plane thickness, unit depth and axisymmetric circumference', async ({ page }) => {
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined');
  await page.evaluate(async () => {
    await window.fem.model.new({ name: 'strip-preview' });
    await window.fem.model.setUnits({ units: { length: 'm', force: 'kN', stress: 'MPa' } });
    await window.fem.model.setIdealisation({ idealisation: { kind: 'planeStress', thickness: '30 mm' } });
    await window.fem.mesh.set({
      mesher: {
        kind: 'mapped',
        blocks: [
          {
            corners: [
              ['1 m', '0 m'],
              ['3 m', '0 m'],
              ['3 m', '2 m'],
              ['1 m', '2 m'],
            ],
            n: [2, 3],
            tags: ['bottom', 'right', 'top', 'left'],
          },
        ],
      },
      order: 2,
    });
    await window.fem.dispatch({ cmd: 'form.open', command: 'load.pressure', args: { name: 'p', on: 'sheet.right', value: '2 MPa' } });
  });
  const preview = page.locator('.pressure-area');
  // 2 MPa × 2 m × 0.03 m = 120 kN; no material, constraint or Step needed.
  await expect(preview).toContainText('120.0 kN');
  await expect(preview).toContainText('0.06000 m^2');
  await page.evaluate(() => window.fem.model.setIdealisation({ idealisation: { kind: 'planeStrain' } }));
  await expect(preview).toContainText('4000 kN');
  await expect(preview).toContainText('per 1 m out-of-plane depth');
  await page.evaluate(() => window.fem.model.setIdealisation({ idealisation: { kind: 'axisymmetric' } }));
  // 2 MPa × 2π × 3 m × 2 m = 24π MN, the scalar pressure-area integral.
  await expect(preview).toContainText('7.540e+4 kN');
  await expect(preview).toContainText('37.70 m^2');
  await expect(preview).not.toContainText('per 1 m');
  expect((await page.evaluate(() => window.fem.query.journal())).entries.some((e) => e.cmd.cmd === 'load.pressure')).toBe(false);
});
