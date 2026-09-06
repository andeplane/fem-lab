import { expect, test, type Page } from '@playwright/test';

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
  await page.waitForFunction(async () => Boolean(await window.fem.query.capabilities()), undefined, { timeout: 60_000 });
}

test.describe('@cpu accessibility and small screens', () => {
  test('traps dialog focus and restores it to each opener', async ({ page }) => {
    await page.goto('./');
    await ready(page);

    const examplesOpener = page.getByRole('button', { name: /Open an example/ });
    await examplesOpener.focus();
    await examplesOpener.press('Enter');
    const examples = page.getByRole('dialog', { name: 'Examples and benchmarks' });
    await expect(examples).toBeVisible();
    await expect(examples.locator('button').first()).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(examples.locator('button').last()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(examples).toHaveCount(0);
    await expect(examplesOpener).toBeFocused();

    await page.evaluate(() => window.fem.model.new({ name: 'a11y' }));
    await expect(page.locator('.shell')).toBeVisible();
    const paletteOpener = page.getByTitle('Search commands (⌘K)');
    await paletteOpener.click();
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    await expect(palette.locator('input')).toBeFocused();
    await palette.locator('input').press('Shift+Tab');
    await expect(palette.locator('button').last()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);
    await expect(paletteOpener).toBeFocused();

    const exportOpener = page.getByRole('button', { name: 'Export', exact: true });
    await exportOpener.click();
    const exportDialog = page.getByRole('dialog', { name: 'Export' });
    await expect(exportDialog).toBeVisible();
    await expect(exportDialog.locator('button:not([disabled])').first()).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(exportDialog.locator('button:not([disabled])').last()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(exportDialog).toHaveCount(0);
    await expect(exportOpener).toBeFocused();
  });

  test('keeps the viewer first and usable at phone and tablet widths', async ({ page }) => {
    await page.goto('./');
    await ready(page);
    await page.evaluate(() => window.fem.model.new({ name: 'small-screen' }));
    await expect(page.locator('.shell')).toBeVisible();

    for (const width of [320, 375, 768]) {
      await page.setViewportSize({ width, height: 900 });
      const layout = await page.evaluate(() => {
        const workspace = document.querySelector('.workspace')!.getBoundingClientRect();
        const centre = document.querySelector('.centre')!.getBoundingClientRect();
        const tree = document.querySelector('.panel.tree')!.getBoundingClientRect();
        const props = document.querySelector('.panel.props')!.getBoundingClientRect();
        return {
          display: getComputedStyle(document.querySelector('.workspace')!).display,
          scrollWidth: document.documentElement.scrollWidth,
          centreTop: centre.top,
          workspaceTop: workspace.top,
          treeTop: tree.top,
          centreBottom: centre.bottom,
          propsTop: props.top,
        };
      });
      expect(layout.display).toBe('flex');
      expect(layout.scrollWidth).toBeLessThanOrEqual(width);
      expect(layout.centreTop).toBe(layout.workspaceTop);
      expect(layout.treeTop).toBeGreaterThanOrEqual(layout.centreBottom - 1);
      expect(layout.propsTop).toBeGreaterThanOrEqual(layout.treeTop);
    }
  });

  test('announces solving progress and errors to assistive technology', async ({ page }) => {
    await page.goto('./');
    await ready(page);
    await page.evaluate(async () => {
      await window.fem.model.new({ name: 'announcements' });
      await window.fem.geometry.addBox({ name: 'beam', size: ['1 m', '100 mm', '100 mm'] });
      await window.fem.material.add({ name: 'steel', E: '210 GPa', nu: 0.3 });
      await window.fem.material.assign({ material: 'steel', bodies: ['beam'] });
      await window.fem.mesh.set({ mesher: { kind: 'lattice', size: '25 mm' }, order: 1 });
      await window.fem.constraint.fix({ name: 'root', on: 'beam.xmin' });
      await window.fem.load.traction({ name: 'tip', on: 'beam.xmax', total: ['0 N', '0 N', '-1 kN'] });
      await window.fem.step.add({ name: 'static', procedure: 'static', constraints: ['root'], loads: ['tip'] });
    });
    await expect(page.locator('.shell')).toBeVisible();
    const solve = page.evaluate(() => window.fem.solve.run({ step: 'static', solver: 'cpu-direct' }).catch(() => undefined));
    const progress = page.locator('.solving-card');
    await expect(progress).toBeVisible({ timeout: 10_000 });
    await expect(progress).toHaveAttribute('role', 'status');
    await expect(progress).toHaveAttribute('aria-live', 'polite');
    await solve;
    await page.evaluate(() => window.fem.dispatch({ cmd: 'solve.run', step: 'missing', solver: 'cpu-direct' }).catch(() => undefined));
    await expect(page.locator('[role="alert"][aria-live="assertive"]').first()).toBeVisible();
    await expect(page.locator('[role="alert"][aria-atomic="true"]')).toHaveCount(2);
  });

  test('disables motion when the user requests reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('./');
    await ready(page);
    const duration = await page.evaluate(() => {
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      document.body.append(spinner);
      const value = getComputedStyle(spinner).animationDuration;
      spinner.remove();
      return value;
    });
    expect(parseFloat(duration)).toBeLessThanOrEqual(0.001);
  });
});
