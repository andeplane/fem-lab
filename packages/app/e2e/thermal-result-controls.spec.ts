import { readFile } from 'node:fs/promises';
import type { Command } from '@femlab/registry';
import { expect, test, type Page } from './fixtures';

async function open(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => { localStorage.setItem('femlab.tour.dismissed', '1'); localStorage.setItem('femlab.autosave', 'off'); });
  await page.goto('./');
  await page.waitForFunction(() => Boolean(window.fem));
}
async function scalarCopy(page: Page) {
  await expect(page.locator('.legend-sub')).not.toHaveAttribute('title', /displacement|exaggerat|true scale/);
  await expect(page.locator('.legend-sub')).not.toContainText(/exaggerat|true scale/);
  await expect(page.locator('.result-header')).not.toContainText(/drawn|exaggerat|true scale/);
  await expect(page.getByLabel('exaggeration', { exact: true })).toHaveCount(0);
  await expect(page.locator('.deform-bar [data-cmd="view.animate"]')).toHaveCount(0);
}

test('@cpu steady temperature has scalar copy and no deformation controls, while the host remains callable', async ({ page }, info) => {
  await open(page);
  const commands: Command[] = [
    { cmd: 'model.new', name: 'steady-scalar' },
    { cmd: 'geometry.addBox', name: 'bar', size: ['1 m', '100 mm', '100 mm'] },
    { cmd: 'material.add', name: 'conductor', k: '10 W/(m K)' },
    { cmd: 'material.assign', material: 'conductor', bodies: ['bar'] },
    { cmd: 'mesh.set', mesher: { kind: 'lattice', size: { nx: 4, ny: 1, nz: 1 } } },
    { cmd: 'constraint.temperature', name: 'cold', on: 'bar.xmin', value: '0 K' },
    { cmd: 'constraint.temperature', name: 'hot', on: 'bar.xmax', value: '100 K' },
    { cmd: 'step.add', name: 'steady', procedure: 'heat-steady', constraints: ['cold', 'hot'], loads: [] },
    { cmd: 'solve.run', step: 'steady' },
  ];
  await page.evaluate(async commands => { for (const command of commands) await window.fem.dispatch(command); }, commands);
  await page.getByRole('tab', { name: /^results/ }).click();
  const result = await page.evaluate(() => window.fem.query.result());
  expect(result.extremes.map(e => e.field)).toContain('temperature');
  expect(result.extremes.map(e => e.field)).not.toContain('displacement');
  const probe = await page.evaluate(() => window.fem.query.probe({ field: 'temperature', at: ['0.5 m', '50 mm', '50 mm'] }));
  expect(probe.value.value).toBeCloseTo(50, 9);
  await expect(page.locator('.legend-field')).toHaveText('T');
  await expect(page.locator('.legend-sub')).toHaveText('steady');
  await scalarCopy(page);
  await expect(page.locator('.deform-bar')).toHaveCount(0);
  const journal = await page.evaluate(() => window.fem.query.journal());
  await page.evaluate(() => window.fem.dispatch({ cmd: 'view.setDeformScale', scale: 1000 }));
  await scalarCopy(page);
  expect(await page.evaluate(() => window.fem.query.journal())).toEqual(journal);
  await page.screenshot({ path: info.outputPath('steady-scalar.png') });
});

test('@cpu transient temperature keeps real frame and time controls without deformation copy', async ({ page }, info) => {
  await open(page);
  const commands = JSON.parse(await readFile(new URL('../../../tools/fixtures/transient-heat.json', import.meta.url), 'utf8')) as Command[];
  await page.evaluate(async commands => { for (const command of commands) await window.fem.dispatch(command); }, commands);
  await page.getByRole('tab', { name: /^results/ }).click();
  const result = await page.evaluate(() => window.fem.query.result());
  expect(result.extremes.map(e => e.field)).not.toContain('displacement');
  const catalogue = await page.evaluate(() => window.fem.query.frames());
  expect(catalogue.field).toBe('temperature');
  const journal = await page.evaluate(() => window.fem.query.journal());
  await scalarCopy(page);
  const frame = page.getByLabel('retained transient frame');
  await expect(frame).toBeVisible();
  await frame.focus(); await frame.press('Home');
  await expect(frame).toHaveValue('0');
  await expect(page.getByLabel('displayed transient time')).toHaveText(`${catalogue.frames[0]!.time.value} ${catalogue.frames[0]!.time.unit}`);
  await frame.press('End');
  await expect(frame).toHaveValue(String(catalogue.frames.length - 1));
  await expect(page.locator('.deform-bar button[data-cmd="view.playTransient"]')).toBeVisible();
  await expect(page.getByLabel('transient playback speed')).toBeVisible();
  await scalarCopy(page);
  expect(await page.evaluate(() => window.fem.query.journal())).toEqual(journal);
  await page.screenshot({ path: info.outputPath('transient-scalar.png') });
});

test('@cpu mechanical displacement keeps callable exaggeration and true-scale controls', async ({ page }, info) => {
  await open(page);
  await page.evaluate(() => window.fem.dispatch({ cmd: 'example.open', name: 'cantilever' }));
  await page.getByRole('tab', { name: /^results/ }).click();
  const result = await page.evaluate(() => window.fem.query.result());
  expect(result.extremes.map(e => e.field)).toContain('displacement');
  const journal = await page.evaluate(() => window.fem.query.journal());
  await page.evaluate(() => window.fem.dispatch({ cmd: 'view.setDeformScale', scale: 1000 }));
  await expect(page.getByLabel('exaggeration', { exact: true })).toBeVisible();
  await expect(page.locator('.legend-sub')).toContainText('exaggerated ×1000');
  await expect(page.locator('.result-header')).toContainText('drawn exaggerated ×1000');
  await page.locator('.deform-bar button[data-cmd="view.setDeformScale"]').click();
  await expect(page.getByLabel('exaggeration', { exact: true })).toHaveValue('1');
  await expect(page.locator('.legend-sub')).toContainText('true scale');
  await expect(page.locator('.result-header')).toContainText('drawn at true scale');
  expect(await page.evaluate(() => window.fem.query.journal())).toEqual(journal);
  expect(await page.evaluate(() => window.fem.query.result())).toEqual(result);
  await page.screenshot({ path: info.outputPath('mechanical-displacement.png') });
});
