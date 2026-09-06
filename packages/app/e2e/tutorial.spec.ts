// The tutorial runner, mounted: the panel opens from the top bar, "do it for me" performs the
// step through the app's own dispatch (so the tree and the viewer catch up), and a step done by
// hand through `window.fem` satisfies the runner exactly the same way — the Journal is the only
// thing it watches.
import { expect, test, type Page } from '@playwright/test';

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
  await page.waitForFunction(async () => Boolean(await window.fem.query.capabilities()), undefined, { timeout: 60_000 });
}

test.describe('@cpu the guided tutorial', () => {
  test.setTimeout(120_000);

  test('completes its first steps by button and by window.fem alike', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
    await page.goto('./');
    await ready(page);

    // The start screen offers it, so the tutorial starts before any Model exists — which is
    // also what makes step 1 (`model.new`) a step and not something already satisfied.
    await page.locator('button[data-cmd="panel.toggle"]', { hasText: 'Start a tutorial' }).click();
    await page.locator('.tutorial-pick', { hasText: 'Cantilever beam' }).click();
    await expect(page.locator('.tutorial-progress')).toHaveText('step 1 of 11');

    // 1 · by button: "do it for me" runs the step's Command through the app's dispatch, so the
    // Journal grows and the tree redraws — not just the panel.
    await page.locator('.tutorial-btn.primary', { hasText: 'Do it for me' }).click();
    await expect(page.locator('.tutorial-progress')).not.toHaveText('step 1 of 11');
    const step = await page.locator('.tutorial-progress').textContent();
    await expect(page.locator('.jrow').last()).toContainText('model.new');

    // 2 · by hand: the same runner advances on a Command the person issued themselves.
    await page.evaluate(() => window.fem.model.setUnits({ units: { length: 'mm', force: 'kN', stress: 'MPa' } }));
    await expect(page.locator('.tutorial-progress')).not.toHaveText(step!);
    await expect(page.locator('.jrow')).toHaveCount(2);
    await expect(page.locator('.jrow').last()).toContainText('model.setUnits');
    await expect(page.locator('.tutorial-step-title')).toHaveText('Add the beam');
  });

  test('runs the whole cantilever tutorial with "Do it for me" and ends solved', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
    await page.goto('./');
    await ready(page);
    await page.locator('button[data-cmd="panel.toggle"]', { hasText: 'Start a tutorial' }).click();
    await page.locator('.tutorial-pick', { hasText: 'Cantilever beam' }).click();
    await expect(page.locator('.tutorial-progress')).toHaveText('step 1 of 11');
    for (let step = 1; step <= 10; step++) {
      await expect(page.locator('.tutorial-progress')).toHaveText(`step ${step} of 11`);
      const doIt = page.locator('.tutorial-btn.primary', { hasText: 'Do it for me' });
      await expect(doIt).toBeEnabled();
      await doIt.click();
    }
    // the last step is the beam-theory check: read-only, and the Model is solved by then
    await expect(page.locator('.tutorial-progress')).toHaveText('step 11 of 11');
    await expect(page.locator('button.solve')).toHaveText(/Solved · rev 10/, { timeout: 60_000 });
    await expect(page.locator('.jrow')).toHaveCount(0); // the Results tab is open, not the Journal
    await page.locator('.tutorial-btn.primary', { hasText: 'Next' }).click();
    await expect(page.locator('.tutorial-title')).toContainText('done');
    expect(errors).toEqual([]);
  });

  test('a stale saved position with no Model starts the tutorial over', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('femlab.tour.dismissed', '1');
      localStorage.setItem('femlab.tutorial.cantilever', '3');
    });
    await page.goto('./#tutorial=cantilever/3');
    await ready(page);
    await page.locator('button[data-cmd="panel.toggle"]', { hasText: 'Start a tutorial' }).click();
    await expect(page.locator('.tutorial-progress')).toHaveText('step 1 of 11');
    await expect(page.locator('.tutorial-step-title')).toHaveText('Start a Model');
  });
});
