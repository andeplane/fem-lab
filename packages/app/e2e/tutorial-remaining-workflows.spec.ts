import { expect, test } from './fixtures';
import axisymmetricHeat from '../tutorials/axisymmetric-transient-heat.json';
import eighthThermalStress from '../tutorials/eighth-thermal-stress.json';
import le10 from '../tutorials/le10-full-face.json';

for (const tutorial of [axisymmetricHeat, eighthThermalStress, le10]) {
  test(`@cpu completes ${tutorial.id} through the visible guided runner and checks its solved quantity`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.addInitScript(() => {
      localStorage.setItem('femlab.tour.dismissed', '1');
      localStorage.setItem('femlab.autosave', 'off');
    });
    await page.goto('./');
    await page.waitForFunction(() => Boolean(window.fem), undefined, { timeout: 60_000 });
    await page.locator('.start button[data-cmd="panel.toggle"]', { hasText: 'Tutorials' }).click();
    await page.locator('.tutorial-pick-title', { hasText: tutorial.title }).click();
    for (const [index, step] of tutorial.steps.entries()) {
      await expect(page.locator('.tutorial-progress')).toHaveText(`step ${index + 1} of ${tutorial.steps.length}`);
      await expect(page.locator('.tutorial-step-title')).toHaveText(step.title);
      if ('doIt' in step && step.doIt) {
        const button = page.locator('.tutorial-btn.primary', { hasText: 'Do it for me' });
        await expect(button).toBeEnabled();
        await button.click();
        if (step.expect === null) await expect(button).toBeEnabled();
      }
      if (step.expect === null) {
        if ('theory' in step) {
          await expect(page.locator('.tutorial-theory .katex').first()).toBeVisible();
          await page.screenshot({ path: testInfo.outputPath(`${tutorial.id}-solved.png`) });
        }
        await page.locator('.tutorial-btn.primary', { hasText: 'Next' }).click();
      }
    }
    await expect(page.locator('.tutorial-title')).toHaveText(`${tutorial.title} — done`);
    const journal = await page.evaluate(() => window.fem.query.journal());
    const engineSteps = tutorial.steps.flatMap(step => 'doIt' in step && step.doIt && step.doIt.cmd !== 'view.fit' ? [step.doIt] : []);
    expect(journal.entries.map(entry => entry.cmd)).toEqual(engineSteps);
    await expect(page.locator('button.solve')).toHaveText(/Solved/);

    if (tutorial.id === 'axisymmetric-transient-heat') {
      const reading = await page.evaluate(() => window.fem.query.probe({ step: 'warm-up', field: 'temperature', at: ['0.1 m', '0.3 m', '0 m'] }));
      expect(reading.value.unit).toBe('degC');
      expect(Math.abs(reading.value.value - 186.48527933)).toBeLessThan(0.3);
      const frames = await page.evaluate(() => window.fem.query.frames({ step: 'warm-up' }));
      expect(frames.frames.at(-1)!.timeSi).toBe(190);
    } else if (tutorial.id === 'eighth-thermal-stress') {
      for (const [component, expected] of [0.475, 0.5075, 0.5075].entries()) {
        const reading = await page.evaluate(component => window.fem.query.probe({ step: 'expand-and-compress', field: 'displacement', component, at: ['0.5 m', '0.5 m', '0.5 m'] }), component);
        expect(reading.value.unit).toBe('mm');
        expect(reading.value.value).toBeCloseTo(expected, 7);
      }
    } else {
      const reading = await page.evaluate(() => window.fem.query.probe({ step: 'static', field: 'stress', component: 1, at: ['2 m', '0 m', '0.6 m'] }));
      expect(reading.value.unit).toBe('MPa');
      expect(Math.abs(reading.value.value - -5.25) / 5.25).toBeLessThan(0.02);
    }
  });
}
