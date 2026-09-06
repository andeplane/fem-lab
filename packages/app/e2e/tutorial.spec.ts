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

  // Issues #38 and #46, end to end: a person who never reads a Command name should be able to
  // finish the tutorial by clicking whatever the spotlight is on and typing whatever the card
  // and the form's own placeholders tell them.
  test('builds the cantilever by the highlighted controls alone, card never over Properties', async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
    await page.goto('./');
    await ready(page);

    await page.locator('button[data-cmd="panel.toggle"]', { hasText: 'Start a tutorial' }).click();
    await page.locator('.tutorial-pick', { hasText: 'Cantilever beam' }).click();
    await expect(page.locator('.tutorial-progress')).toHaveText('step 1 of 11');

    const card = page.locator('.tutorial-panel');
    const target = page.locator('[data-tutorial-target]').first();
    const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean =>
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

    for (let guard = 0; guard < 30; guard++) {
      const before = ((await page.locator('.tutorial-progress').textContent()) ?? '').trim();
      if (before === 'step 11 of 11') break;
      const has = await target
        .waitFor({ state: 'attached', timeout: 5_000 })
        .then(() => true)
        .catch(() => false);
      expect(has, `a highlighted control on ${before}`).toBe(true);
      await expect(target).toBeVisible();

      // #46's regression gate: the card sits beside the control, never over the panel it is
      // talking about and never over the control itself.
      const cb = (await card.boundingBox())!;
      const tb = (await target.boundingBox())!;
      // On step 1 the start screen is still up and there is no Properties panel to miss.
      const propsPanel = page.locator('aside.props');
      const props = (await propsPanel.count()) ? await propsPanel.boundingBox() : null;
      if (props) expect(overlaps(cb, props), `card over Properties on ${before}`).toBe(false);
      expect(overlaps(cb, tb), `card over its own target on ${before}`).toBe(false);
      await expect(page.locator('.tutorial-spot')).toHaveCount(1);

      const inForm = await target.evaluate((el) => Boolean(el.closest('.props')));
      if (inForm) {
        // Every text and quantity input carries the value it wants as its own placeholder; a
        // reference field is chips, so its value is picked from the candidates on offer.
        const inputs = page.locator('.props .field input[placeholder]:not([placeholder=""])');
        for (let i = 0; i < (await inputs.count()); i++) {
          const want = await inputs.nth(i).getAttribute('placeholder');
          if (want) await inputs.nth(i).fill(want);
        }
        const values: Record<string, string> = await page.evaluate(() => {
          const dl = document.querySelector('.tutorial-values');
          const dt = [...(dl?.querySelectorAll('dt') ?? [])].map((e) => e.textContent?.trim() ?? '');
          const dd = [...(dl?.querySelectorAll('dd') ?? [])].map((e) => e.textContent?.trim() ?? '');
          return Object.fromEntries(dt.map((k, i) => [k, dd[i] ?? '']));
        });
        for (const [key, want] of Object.entries(values)) {
          const chip = page.locator(`.props [data-field="${key}"] .chip-cand`, { hasText: want }).first();
          if (await chip.count()) await chip.click();
        }
        // an enum is a segmented control, so its value is the option the card names
        const said = Object.values(values).join(' ');
        const segs = page.locator('.props .field button[aria-pressed]');
        for (let i = 0; i < (await segs.count()); i++) {
          const label = ((await segs.nth(i).textContent()) ?? '').trim();
          if (label && new RegExp(`(^|[^\\w])${label}([^\\w]|$)`).test(said)) await segs.nth(i).click();
        }
        await page.locator('.props .apply').click();
      } else if (await target.evaluate((el) => el.matches('.palette-field'))) {
        const cmd = ((await page.locator('.tutorial-where code').textContent()) ?? '').trim();
        await target.click();
        await page.locator('.palette input').fill(cmd);
        await page.keyboard.press('Enter');
      } else {
        await target.click();
      }

      // the step advanced, or the click opened the form and the spotlight moved into it
      await page.waitForFunction(
        (prev) => {
          const p = document.querySelector('.tutorial-progress')?.textContent?.trim();
          if (p !== prev.step) return true;
          return Boolean(document.querySelector('[data-tutorial-target]')?.closest('.props')) !== prev.inForm;
        },
        { step: before, inForm },
        { timeout: 120_000 },
      );
    }

    // the closing step is the beam-theory read, with the Model solved behind it
    await expect(page.locator('.tutorial-progress')).toHaveText('step 11 of 11');
    await expect(page.locator('button.solve')).toHaveText(/Solved/, { timeout: 60_000 });
    // a read-only step points at nothing, so the card docks again
    await expect(page.locator('.tutorial-spot')).toHaveCount(0);
    await page.locator('.tutorial-btn.primary', { hasText: 'Next' }).click();
    await expect(page.locator('.tutorial-title')).toContainText('done');
    expect(errors).toEqual([]);
  });
});
