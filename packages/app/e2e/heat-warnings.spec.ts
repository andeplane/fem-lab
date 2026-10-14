import { expect, test } from './fixtures';

test('@cpu prescribed temperatures drive the bundled heat example without a no-load warning', async ({ page }) => {
  await page.setViewportSize({ width: 1720, height: 1000 });
  await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'example.open', name: 'bar-transient-heat' }));
  const model = await page.evaluate(() => window.fem.query.model());
  expect(model.loads).toHaveLength(0);
  expect(model.constraints).toHaveLength(2);
  expect(model.warnings.map(warning => warning.code)).not.toContain('model.unloaded');
  await expect(page.locator('.banner').filter({ hasText: 'W-1400' })).toHaveCount(0);
  const loads = page.locator('.tree-group').filter({ has: page.locator('.group-label', { hasText: /^Loads$/ }) });
  await expect(loads).toHaveCount(1);
  // This benchmark is driven by boundary temperatures and intentionally has no Loads.
  await expect(loads.locator('.badge')).toHaveText('—');
  await expect(loads.locator('.badge.warn')).toHaveCount(0);
  const material = page.locator('#tree-materials-items .row').filter({ has: page.locator('.name', { hasText: /^slab$/ }) });
  await expect(material.locator('.summary')).toContainText('W/(m K)');
  await expect(material.locator('.summary')).toContainText('J/(kg K)');
  await material.locator('.row-main').click();
  await expect(page.locator('.props [data-field="k"] input')).toHaveValue(/W\/\(m K\)/);
  await expect(page.locator('.props [data-field="cp"] input')).toHaveValue(/J\/\(kg K\)/);
  const drawer = page.locator('.assistant');
  await expect(drawer).toHaveCount(0);
  await material.locator('[data-cmd="chat.insertMention"]').click();
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('.tokens .token')).toContainText('@material:slab');
  await expect(drawer.locator('textarea')).toBeFocused();
  await page.evaluate(() => window.fem.dispatch({ cmd: 'solve.run', step: 'transient', solver: 'cpu-direct' }));
  const result = await page.evaluate(() => window.fem.query.result());
  expect(result.extremes.find(extreme => extreme.field === 'temperature')?.max.value).toBeGreaterThan(0);
  await expect(page.locator('.banner')).toHaveCount(0);
  await expect(page.locator('.tree .badge.warn')).toHaveCount(0);
});

test('@cpu inherited heat drives a static bar without an explicit Load or false W-1400', async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
  for (const nx of [2, 4, 8]) {
    const solved = await page.evaluate(async divisions => {
      await window.fem.model.new({ name: `inherited-heat-${divisions}` });
      for (const command of [
        { cmd: 'geometry.addBox', name: 'bar', size: ['1 m', '100 mm', '100 mm'] },
        { cmd: 'material.add', name: 'solid', E: '1 GPa', nu: 0.3, alpha: '1e-5 1/K', k: '10 W/(m*K)' },
        { cmd: 'material.assign', material: 'solid', bodies: ['bar'] },
        { cmd: 'mesh.set', mesher: { kind: 'lattice', size: { nx: divisions, ny: 1, nz: 1 } } },
        { cmd: 'constraint.temperature', name: 'cold', on: 'bar.xmin', value: '293.15 K' },
        { cmd: 'constraint.temperature', name: 'hot', on: 'bar.xmax', value: '393.15 K' },
        { cmd: 'constraint.fix', name: 'root', on: 'bar.xmin' },
        { cmd: 'step.add', name: 'warm', procedure: 'heat-steady', constraints: ['cold', 'hot'], loads: [] },
        { cmd: 'step.add', name: 'expand', procedure: 'static', constraints: ['root'], loads: [], after: 'warm' },
      ]) await window.fem.dispatch(command);
      // Both Steps must precede the first solve: changing a Step definition would stale warm.
      await window.fem.solve.run({ step: 'warm', solver: 'cpu-direct' });
      const before = await window.fem.query.model();
      await window.fem.solve.run({ step: 'expand', solver: 'cpu-direct' });
      return {
        before,
        model: await window.fem.query.model(),
        heat: await window.fem.query.result({ step: 'warm' }),
        expansion: await window.fem.query.result({ step: 'expand' }),
      };
    }, nx);
    const ux = solved.expansion.extremes.find(extreme => extreme.field === 'displacement' && extreme.component === 0)!;
    // Integrate T(x)-293.15 = 100x K over one metre, then multiply by alpha = 1e-5 /K.
    expect(ux.max.unit).toBe('m');
    expect(Math.abs(ux.max.value - 0.0005)).toBeLessThanOrEqual(1e-12);
    expect(solved.expansion.stale).toBe(false);
    expect(solved.heat.stale).toBe(false);
    expect(solved.model.loads).toHaveLength(0);
    for (const model of [solved.before, solved.model]) {
      expect(model.warnings.filter(warning => warning.code === 'model.unloaded' && warning.step === 'expand')).toEqual([]);
    }
    await expect(page.locator('.banner').filter({ hasText: 'W-1400' })).toHaveCount(0);
    await expect(page.locator('button.solve')).toBeEnabled();
    await expect(page.locator('.error-card')).toHaveCount(0);
  }
});
