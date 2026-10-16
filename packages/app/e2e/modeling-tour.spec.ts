import { expect, test, type Page } from './fixtures';

const next = (page: Page) => page.locator('.tour-callout').getByRole('button', { name: 'Next', exact: true });
async function start(page: Page): Promise<void> {
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
  await expect(page.locator('.tour-callout')).toHaveCount(0);
  await page.getByRole('button', { name: 'Start modeling — free' }).click();
  await expect(page.locator('#modeling-tour-title')).toHaveText('Add geometry');
}
async function reopen(page: Page): Promise<void> {
  await page.locator('.topbar [title="Guided tutorials"]').click();
  await page.locator('.tutorial-panel [data-cmd="tour.show"]').click();
  await expect(page.locator('#modeling-tour-title')).toHaveText('Add geometry');
}

// This is anonymous local modeling. Treat an auth or AI request as a regression.
function watchExternalWork(page: Page): string[] {
  const requests: string[] = [];
  page.on('request', request => {
    if (/identitytoolkit|\/chat\/completions|\/account(?:\/|$)|checkout\.stripe/.test(request.url())) requests.push(request.url().split('?')[0]!);
  });
  return requests;
}

test.describe('@cpu modeling tour', () => {
  test.setTimeout(180_000);

  test('first local entry guides eight stages, preserves work and dismissal, and hands off to a real cantilever solve', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const external = watchExternalWork(page);
    await start(page);
    const initial = await page.evaluate(() => window.fem.query.journal());
    const titles = ['Add geometry', 'Define and assign a Material', 'Choose a Mesh', 'Restrain the intended motion', 'Apply a Load', 'Define an analysis Step', 'Solve the Step', 'Read and check Results'];
    for (const title of titles) {
      await expect(page.locator('#modeling-tour-title')).toHaveText(title);
      if (title !== titles.at(-1)) await next(page).click();
    }
    await page.locator('.tour-callout').getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.locator('#modeling-tour-title')).toHaveText('Solve the Step');
    expect((await page.evaluate(() => window.fem.query.journal())).entries).toEqual(initial.entries);
    await page.locator('.tour-callout').getByRole('button', { name: 'Continue on my own' }).click();
    await expect(page.locator('.tour-callout')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('femlab.tour.dismissed'))).toBe('1');

    // Reopening is a visible registry action even for people who dismissed the old tour.
    await reopen(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('.tour-callout')).toHaveCount(0);
    await expect(page.locator('.topbar [title="Guided tutorials"]')).toBeFocused();
    await reopen(page);
    for (let i = 0; i < 7; i++) await next(page).click();
    await page.screenshot({ path: '/tmp/femlab-tour-778-desktop.png' });
    await page.locator('.tour-callout').getByRole('button', { name: 'Build the cantilever tutorial' }).click();
    await expect(page.locator('.tour-callout')).toHaveCount(0);
    await expect(page.locator('.tutorial-progress')).toHaveText('step 1 of 11');
    expect((await page.evaluate(() => window.fem.query.journal())).entries).toEqual(initial.entries);
    for (let step = 1; step <= 10; step++) {
      await expect(page.locator('.tutorial-progress')).toHaveText(`step ${step} of 11`);
      await page.locator('.tutorial-panel').getByRole('button', { name: 'Do it for me' }).click();
    }
    await expect(page.locator('.tutorial-progress')).toHaveText('step 11 of 11');
    await expect(page.locator('button.solve')).toHaveText(/Solved · rev 10/, { timeout: 60_000 });
    await expect(page.locator('.tutorial-theory')).toBeVisible();
    const solved = await page.evaluate(() => window.fem.query.journal());
    // A tool can invoke the registered handoff directly, without a preceding tour.show.
    await page.evaluate(() => window.fem.dispatch({ cmd: 'tour.startCantilever' }));
    await expect(page.locator('.tutorial-progress')).toHaveText('step 1 of 11');
    expect((await page.evaluate(() => window.fem.query.journal())).entries).toEqual(solved.entries);
    expect(external).toEqual([]);
    await page.locator('.tutorial-close').click();
    await page.reload();
    await page.waitForFunction(() => typeof window.fem !== 'undefined');
    await expect(page.locator('.tour-callout')).toHaveCount(0);
  });

  test('at 390px keeps dismissal and highlighted controls usable without covering Properties', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await start(page);
    const card = page.locator('.tour-callout');
    for (let step = 0; step < 8; step++) {
      await expect(card).toBeVisible();
      const close = card.getByRole('button', { name: 'Dismiss modeling tour' });
      await close.click({ trial: true });
      await expect(page.locator('[data-tutorial-target]')).toHaveCount(1);
      const highlighted = page.locator('[data-tutorial-target]');
      const target = (await highlighted.boundingBox())!, callout = (await card.boundingBox())!;
      expect(target.y + target.height <= callout.y || target.y >= callout.y + callout.height - 1, `target not covered at stop ${step}`).toBe(true);
      expect(target.x).toBeGreaterThanOrEqual(0);
      expect(target.x + target.width).toBeLessThanOrEqual(391);
      expect(target.y).toBeGreaterThanOrEqual(0);
      expect(target.y).toBeLessThan(844);
      if (step === 0) {
        // The tour never creates a body itself or blocks the actual Add/form controls.
        await highlighted.click();
        await expect(page.locator('.props')).toBeVisible();
        await page.locator('.props input:not([type=checkbox])').first().click();
        await expect(page.locator('.props input:not([type=checkbox])').first()).toBeFocused();
        expect((await page.evaluate(() => window.fem.query.model())).bodies).toHaveLength(0);
        await page.screenshot({ path: '/tmp/femlab-tour-778-390.png' });
      }
      if (step < 7) await next(page).click();
    }
    await card.getByRole('button', { name: 'Continue on my own' }).click();
    await expect(card).toHaveCount(0);
    await reopen(page);
    await card.getByRole('button', { name: 'Dismiss modeling tour' }).click();
    await expect(card).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('femlab.tour.dismissed'))).toBe('1');
  });
});
