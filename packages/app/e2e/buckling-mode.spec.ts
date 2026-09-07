import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from './fixtures';

const CASE = JSON.parse(readFileSync(path.join(import.meta.dirname, '../../../crates/femlab/benches/cases/euler-column-fixed-free-hex20.json'), 'utf8')) as {
  journal: Record<string, unknown>[];
};

async function ready(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
  await page.goto('./');
  await page.waitForFunction(async () => typeof window.fem !== 'undefined' && Boolean(await window.fem.query.capabilities()), undefined, { timeout: 60_000 });
}

test('@cpu solves the Euler fixed-free buckling benchmark and animates mode 1', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await ready(page);
  await page.evaluate(async (commands) => {
    for (const command of commands) await window.fem.dispatch(command as never);
  }, CASE.journal.filter((command) => command.cmd !== 'solve.run'));

  await page.locator('button.solve').click();
  await expect(page.locator('button.solve')).toHaveText(/Solved · rev \d+/, { timeout: 180_000 });

  const result = await page.evaluate(async () => await window.fem.query.result()) as unknown as { bucklingFactors?: number[] };
  expect(result.bucklingFactors?.[0]).toBeCloseTo(17.3996, 3);
  expect(result.bucklingFactors).toHaveLength(2);

  const table = page.locator('.rtable', { hasText: 'load factor λ' });
  await expect(table.locator('tbody tr')).toHaveCount(2);
  await expect(table.locator('tbody tr').first()).toContainText('λ 17.4');
  await expect(page.locator('.tree [data-cmd="view.showField"]', { hasText: 'Mode 1 · λ 17.4' })).toHaveCount(1);
  await table.locator('tbody tr').first().locator('[data-cmd="view.showField"]').click();
  await expect(page.locator('.legend-field')).toHaveText('Mode 1 · λ 17.4');
  await expect(page.locator('.legend-unit')).toHaveText('mm');

  const play = page.locator('.deform-bar button[data-cmd="view.animate"]');
  await expect(play).toBeVisible();
  await play.click();
  await expect(play).toHaveText('❚❚');
  await expect(play).toHaveAttribute('aria-pressed', 'true');
});
