// Design brief §5.5: a Journal row selects its still-live object, keyboard focus and hover
// highlight it, and these host-only interactions leave the Journal byte-for-byte unchanged.
import { expect, test, type Page } from '@playwright/test';

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
  await page.waitForFunction(async () => Boolean(await window.fem.query.capabilities()), undefined, { timeout: 60_000 });
}

test.describe('@cpu Journal object interactions', () => {
  test('pointer and keyboard select/highlight live targets without changing the Journal', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
    await page.goto('./');
    await ready(page);
    await page.evaluate(async () => {
      await window.fem.model.new({ name: 'journal-interactions' });
      await window.fem.geometry.addBox({ name: 'beam', size: ['1 m', '100 mm', '100 mm'] });
      await window.fem.geometry.addBox({ name: 'deleted', size: ['100 mm', '100 mm', '100 mm'], at: ['2 m', '0 m', '0 m'] });
      await window.fem.geometry.remove({ name: 'deleted' });
    });

    const canvas = page.locator('.viewer canvas');
    await expect(canvas).toBeVisible();
    await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>('.viewer canvas')!.toDataURL().length > 1_000);
    const beforeJournal = await page.evaluate(() => window.fem.query.journal());
    const beam = page.locator('.jrow[data-target-ref="body:beam"]');
    const select = beam.locator('.jrow-main');
    await expect(select).toHaveAttribute('data-cmd', 'selection.set');

    const base = await canvas.screenshot();
    await beam.hover();
    await expect(beam.locator('.jcopy')).toHaveCSS('opacity', '1');
    const hovered = await canvas.screenshot();
    expect(hovered.equals(base)).toBe(false);

    await page.locator('.topbar').hover();
    const cleared = await canvas.screenshot();
    expect(cleared.equals(base)).toBe(true);

    await select.focus();
    const focused = await canvas.screenshot();
    expect(focused.equals(base)).toBe(false);
    await select.press('Enter');
    await beam.locator('.jcopy').focus();
    await expect.poll(async () => (await page.evaluate(() => window.fem.registry.query({ query: 'query.selection' })) as { refs: string[] }).refs).toEqual(['body:beam']);
    const selected = await canvas.screenshot();
    expect(selected.equals(base)).toBe(false);

    const deletedAdd = page.locator('.jrow', { hasText: 'geometry.addBox' }).filter({ hasText: 'deleted' });
    const deletedRemove = page.locator('.jrow', { hasText: 'geometry.remove' }).filter({ hasText: 'deleted' });
    await expect(deletedAdd.locator('.jrow-main')).toBeDisabled();
    await expect(deletedRemove.locator('.jrow-main')).toBeDisabled();
    await expect(deletedAdd.locator('.jcopy')).toHaveAttribute('data-cmd', 'clipboard.copy');

    expect(await page.evaluate(() => window.fem.query.journal())).toEqual(beforeJournal);
  });
});
