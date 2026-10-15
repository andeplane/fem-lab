import { expect, test } from './fixtures';
import { readFileSync } from 'node:fs';
import type { Command } from '@femlab/registry';

const commands = JSON.parse(readFileSync(new URL('../../../crates/engine/tests/fixtures/adaptive-heat.json', import.meta.url), 'utf8')) as Command[];

test('@cpu adaptive heat displays element errors and reports an unmet target', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem('femlab.tour.dismissed', '1');
    localStorage.setItem('femlab.autosave', 'off');
  });
  await page.goto('./');
  await page.waitForFunction(() => Boolean(window.fem));
  await page.evaluate(async commands => { for (const command of commands) await window.fem.dispatch(command); }, commands);
  await expect(page.locator('.legend-field')).toHaveText('Estimated spatial error');
  await expect(page.locator('.results')).toContainText('Target not reached · target 1%');
  const sampled = await page.evaluate(async () => {
    const field = await window.fem.query.field({ field: 'errorEstimate' });
    const probe = await window.fem.query.probe({ field: 'errorEstimate', at: ['0.13 m', '0.27 m', '0 m'] });
    const surface = await window.fem.query.surface();
    return { field, probe, surface };
  });
  expect(sampled.field.per).toBe('element');
  expect(sampled.probe.interpolated).toBe(false);
  expect(sampled.probe.value.value).toBe(sampled.field.values[sampled.probe.element]);
  expect(sampled.surface.triElement).toHaveLength(sampled.surface.indices.length / 3);
  await page.getByRole('button', { name: 'T', exact: true }).click();
  await expect(page.locator('.legend-field')).toHaveText('T');
  await page.getByRole('button', { name: 'Estimated spatial error', exact: true }).click();
  await expect(page.locator('.legend-field')).toHaveText('Estimated spatial error');
  await page.screenshot({ path: testInfo.outputPath('adaptive-heat.png') });
});
