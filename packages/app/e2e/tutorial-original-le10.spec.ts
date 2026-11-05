import { expect, test } from './fixtures';
import { readFileSync } from 'node:fs';
import type { Tutorial } from '../src/tutorial/types';

const tutorial = JSON.parse(readFileSync(new URL('../tutorials/le10-original.json', import.meta.url), 'utf8')) as Tutorial;

test('@cpu completes original line-supported LE10 visibly and distinguishes the support physics', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const deadline = Date.now() + 180_000;
  const remaining = () => Math.max(1, deadline - Date.now());
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    localStorage.setItem('femlab.tour.dismissed', '1');
    localStorage.setItem('femlab.autosave', 'off');
  });
  await page.goto('./');
  await page.waitForFunction(() => Boolean(window.fem), undefined, { timeout: 60_000 });
  await page.locator('.start button[data-cmd="panel.toggle"]', { hasText: 'Tutorials' }).click();
  await page.locator('.tutorial-pick-title', { hasText: tutorial.title }).click();
  let committedCount = 0;
  for (const [index, step] of tutorial.steps.entries()) {
    await expect(page.locator('.tutorial-progress')).toHaveText(`step ${index + 1} of ${tutorial.steps.length}`);
    await expect(page.locator('.tutorial-step-title')).toHaveText(step.title);
    if (step.doIt) {
      await page.locator('.tutorial-btn.primary', { hasText: 'Do it for me' }).click();
      if (!step.doIt.cmd.startsWith('view.')) {
        committedCount++;
        await page.waitForFunction(async ({ count, cmd }) => {
          const journal = await window.fem.query.journal();
          return journal.entries.length === count && journal.entries.at(-1)?.cmd.cmd === cmd;
        }, { count: committedCount, cmd: step.doIt.cmd }, { timeout: remaining() });
      }
      // Imported geometry certification and solving are real asynchronous work. Wait for
      // this runner's action to settle before applying the ordinary 5 s UI assertions.
      await page.waitForFunction(() => {
        const button = document.querySelector<HTMLButtonElement>('.tutorial-btn.primary');
        return button !== null && !button.disabled && button.textContent !== 'Doing it…';
      }, undefined, { timeout: remaining() });
      if (step.doIt.cmd === 'mesh.set') {
        await expect(page.locator('.tree .summary', { hasText: 'imported · hex20 · full' })).toBeVisible();
      }
      if (step.doIt.cmd === 'solve.run') {
        await page.waitForFunction(async () => {
          try {
            const result = await window.fem.query.result({ step: 'static' });
            return result.step === 'static' && !result.stale;
          } catch { return false; }
        }, undefined, { timeout: remaining() });
      }
    }
    if (step.expect === null) {
      if (step.theory) {
        await expect(page.locator('.tutorial-theory .katex').first()).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('le10-original-solved.png') });
      }
      await page.locator('.tutorial-btn.primary', { hasText: 'Next' }).click();
    }
  }
  await expect(page.locator('.tutorial-title')).toHaveText(`${tutorial.title} — done`);
  const commands = tutorial.steps.flatMap(s => s.doIt && !s.doIt.cmd.startsWith('view.') ? [s.doIt] : []);
  const journal = await page.evaluate(() => window.fem.query.journal());
  expect(journal.entries.map(e => e.cmd)).toEqual(commands);
  const stress = await page.evaluate(() => window.fem.query.probe({ step: 'static', field: 'stress', component: 1, at: ['2 m', '0 m', '0.6 m'] }));
  expect(stress.value.unit).toBe('MPa');
  expect(Math.abs(stress.value.value - -5.38) / 5.38).toBeLessThan(0.02);
  for (const z of ['0 m', '0.6 m']) {
    const free = await page.evaluate(z => window.fem.query.probe({ step: 'static', field: 'displacement', component: 2, at: ['3.25 m', '0 m', z] }), z);
    expect(free.value.unit).toBe('m');
    expect(Math.abs(free.value.value)).toBeGreaterThan(1e-8);
  }
  const mid = await page.evaluate(() => window.fem.query.probe({ step: 'static', field: 'displacement', component: 2, at: ['3.25 m', '0 m', '0.3 m'] }));
  expect(Math.abs(mid.value.value)).toBeLessThan(1e-12);
  const result = await page.evaluate(() => window.fem.query.result({ step: 'static' }));
  expect(result.balance).toBeLessThan(1e-9);
  await expect(page.locator('button.solve')).toHaveText(/Solved/);
  await testInfo.attach('le10-original-numerical-receipt', {
    body: JSON.stringify({ stress: stress.value, balance: result.balance, solveMs: result.timeMs }),
    contentType: 'application/json',
  });
});

test('@cpu renders the original LE10 guide on the public documentation route', async ({ page }) => {
  await page.goto('docs/examples-tutorials/#le10-original-mid-plane-line-support');
  // Static headings include a visible '#' permalink before their authored title.
  await expect(page.locator('#le10-original-mid-plane-line-support')).toContainText('LE10: original mid-plane line support');
  await expect(page.locator('main')).toContainText('uz is held only on its z = 0.3 m mid-plane line');
  await expect(page.locator('main a[href="https://www.simscale.com/docs/validation-cases/thick-plate-under-pressure/"]')).toBeVisible();
});
