import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Command } from '@femlab/registry';

async function load(page: Page, kind: string) {
  await page.addInitScript(() => {
    localStorage.setItem('femlab.tour.dismissed', '1');
    localStorage.setItem('femlab.autosave', 'off');
  });
  await page.goto('./');
  await page.waitForFunction(() => Boolean(window.fem));
  const commands = JSON.parse(readFileSync(path.resolve(import.meta.dirname, `../../../tools/fixtures/transient-${kind}.json`), 'utf8'));
  await page.evaluate(async (commands) => { for (const command of commands) await window.fem.dispatch(command as Command); }, commands);
  await expect(page.getByLabel('retained transient frame')).toBeVisible();
  return page.evaluate(() => window.fem.query.frames());
}

test.describe('@cpu retained transient playback', () => {
  test('thermal time selection changes contours and repeats the scientific probe at that frame', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const catalogue = await load(page, 'heat');
    const journal = await page.evaluate(() => window.fem.query.journal());
    await page.evaluate(async () => {
      await window.fem.dispatch({ cmd: 'view.playTransient', step: 'warm', playing: false, sample: { kind: 'time', time: '175 ms', sampling: 'exact' } } as never);
      await window.fem.dispatch({ cmd: 'panel.toggle', panel: 'results', open: true } as never);
    });
    await expect(page.getByLabel('retained transient frame')).toHaveValue('1');
    await expect(page.locator('.legend-sub')).toContainText('0.002917 min');
    await page.locator('[data-field="probe.at"]').fill('0.5 m, 0.05 m, 0.05 m');
    await page.locator('.sample [data-cmd="query.probe"]').click();
    await expect(page.locator('.probe-out')).toContainText('-273');
    await expect(page.locator('.probe-out')).toContainText('0.002917 min');
    const before = await page.locator('.legend .tick.top').textContent();
    await page.evaluate(() => window.fem.dispatch({ cmd: 'view.playTransient', step: 'warm', playing: false, sample: { kind: 'frame', index: 2 } } as never));
    await expect(page.getByLabel('retained transient frame')).toHaveValue('2');
    await expect(page.locator('.probe-out')).toContainText('0.005833 min');
    expect(await page.locator('.legend .tick.top').textContent()).not.toBe(before);
    expect(await page.evaluate(() => window.fem.query.journal())).toEqual(journal);
    await page.evaluate(async () => {
      await Promise.all([
        window.fem.dispatch({ cmd: 'view.playTransient', step: 'warm', playing: false, sample: { kind: 'frame', index: 0 } } as never),
        window.fem.dispatch({ cmd: 'view.playTransient', step: 'warm', playing: false, sample: { kind: 'frame', index: 2 } } as never),
      ]);
    });
    await expect(page.getByLabel('retained transient frame')).toHaveValue('2');
    expect(catalogue.frames[1]!.timeSi).toBe(0.175);
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('thermal-playback.png') });
  });

  test('explicit frames move the drawing; play, pause, speed and invalidation use the registry', async ({ page }, testInfo) => {
    const catalogue = await load(page, 'explicit-3d');
    const step = catalogue.step;
    await page.evaluate(async (step) => {
      await window.fem.dispatch({ cmd: 'view.setLegend', range: [-1, 1] } as never);
      await window.fem.dispatch({ cmd: 'view.setDeformScale', scale: 10000 } as never);
      await window.fem.dispatch({ cmd: 'view.playTransient', step, playing: false, sample: { kind: 'frame', index: 0 } } as never);
    }, step);
    const first = await page.locator('.viewer canvas').screenshot();
    const last = catalogue.frames.length - 1;
    await page.evaluate(({ step, index }) => window.fem.dispatch({ cmd: 'view.playTransient', step, playing: false, sample: { kind: 'frame', index } } as never), { step, index: last });
    const final = await page.locator('.viewer canvas').screenshot();
    await page.screenshot({ path: testInfo.outputPath('explicit-playback.png') });
    expect(final.equals(first)).toBe(false);
    const probe = await page.evaluate(({ step, index }) => window.fem.query.probe({ step, field: 'displacement', component: 1, at: ['0.5 m', '0.05 m', '0.05 m'], sample: { kind: 'frame', index } }), { step, index: last });
    expect(probe.value.value).toBeCloseTo(-4.905 * catalogue.frames[last]!.timeSi ** 2 * 1000, 9);
    const journal = await page.evaluate(() => window.fem.query.journal());
    await page.evaluate((step) => window.fem.dispatch({ cmd: 'view.playTransient', step, playing: true, speed: 0.001 } as never), step);
    await expect(page.locator('.deform-bar button[data-cmd="view.playTransient"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('.deform-bar button[data-cmd="view.playTransient"]').click();
    await expect(page.locator('.deform-bar button[data-cmd="view.playTransient"]')).toHaveAttribute('aria-pressed', 'false');
    await page.getByLabel('transient playback speed').selectOption('2');
    expect(await page.evaluate(() => window.fem.query.journal())).toEqual(journal);
    await page.evaluate((step) => window.fem.dispatch({ cmd: 'view.playTransient', step, playing: true, speed: 10 } as never), step);
    await expect(page.getByLabel('retained transient frame')).toHaveValue(String(last));
    await expect(page.locator('.deform-bar button[data-cmd="view.playTransient"]')).toHaveAttribute('aria-pressed', 'false');
    await page.evaluate(() => window.fem.dispatch({ cmd: 'material.add', name: 'mat', E: '2 GPa', nu: 0.3, rho: '1 kg/m^3' } as never));
    await expect(page.getByLabel('retained transient frame')).toHaveCount(0);
  });

  test('scrub cancellation restores the starting frame without a committed command', async ({ page }) => {
    await load(page, 'heat');
    await page.evaluate(() => window.fem.dispatch({ cmd: 'view.playTransient', step: 'warm', playing: false, sample: { kind: 'frame', index: 0 } } as never));
    await page.evaluate(() => window.fem.dispatch({ cmd: 'panel.toggle', panel: 'console', open: true } as never));
    const committed = page.locator('.crow').filter({ hasText: 'view.playTransient' });
    const before = await committed.count();
    const slider = page.getByLabel('retained transient frame');
    await slider.evaluate((element) => {
      (element as HTMLInputElement).value = '1'; element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(slider).toHaveValue('1');
    await slider.press('Escape');
    await expect(slider).toHaveValue('0');
    await expect(committed).toHaveCount(before);
    await slider.evaluate((element) => { (element as HTMLInputElement).value = '1'; element.dispatchEvent(new Event('input', { bubbles: true })); });
    await expect(slider).toHaveValue('1');
    await slider.dispatchEvent('pointercancel');
    await expect(slider).toHaveValue('0');
    await expect(committed).toHaveCount(before);
    const journal = await page.evaluate(() => window.fem.query.journal());
    await slider.evaluate((element) => {
      (element as HTMLInputElement).value = '2'; element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(slider).toHaveValue('2');
    await expect(committed).toHaveCount(before + 1);
    expect(await page.evaluate(() => window.fem.query.journal())).toEqual(journal);
  });
});
