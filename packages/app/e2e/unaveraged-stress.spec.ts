import { expect, test, type Page } from './fixtures';

async function memberPatch(page: Page, x: number, y: number) {
  return page.locator('canvas').evaluate((canvas, point) => {
    const source = canvas as HTMLCanvasElement;
    const copy = document.createElement('canvas');
    copy.width = source.width;
    copy.height = source.height;
    const context = copy.getContext('2d')!;
    context.drawImage(source, 0, 0);
    // The explicit front orthographic camera centres (6, 1). The 12 × 2 m model's
    // enclosing diagonal fixes its viewport height; sample the middle of a named chord.
    const scale = source.height / (2 * Math.hypot(12, 2) * 0.7);
    const px = Math.round(source.width / 2 + (point.x - 6) * scale);
    const py = Math.round(source.height / 2 - (point.y - 1) * scale);
    const pixels = context.getImageData(px - 4, py - 4, 9, 9).data;
    let count = 0, saturation = 0;
    const total = [0, 0, 0];
    for (let i = 0; i < pixels.length; i += 4) {
      const high = Math.max(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!);
      const low = Math.min(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!);
      saturation = Math.max(saturation, high - low);
      if (high > 70) {
        count++;
        total[0]! += pixels[i]!; total[1]! += pixels[i + 1]!; total[2]! += pixels[i + 2]!;
      }
    }
    return { count, saturation, mean: total.map(value => count ? value / count : 0) };
  }, { x, y });
}

async function clickMember(page: Page, x: number, y: number) {
  const rect = (await page.locator('canvas').boundingBox())!;
  const scale = rect.height / (2 * Math.hypot(12, 2) * 0.7);
  await page.mouse.click(rect.x + rect.width / 2 + (x - 6) * scale, rect.y + rect.height / 2 - (y - 1) * scale);
}

test('@cpu selects unaveraged member stress on the steel roof truss', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined');
  await page.evaluate(async () => {
    await window.fem.dispatch({ cmd: 'example.open', name: 'steel-roof-truss' });
    await window.fem.dispatch({ cmd: 'view.setDeformScale', scale: 0 });
    await window.fem.dispatch({ cmd: 'view.setProjection', projection: 'orthographic' });
    await window.fem.dispatch({ cmd: 'view.setCamera', position: [6, 1, 20], target: [6, 1, 0], up: [0, 1, 0] });
    await window.fem.dispatch({ cmd: 'view.toggle', layer: 'grid', on: false });
    await window.fem.dispatch({ cmd: 'view.toggle', layer: 'axes', on: false });
    await window.fem.dispatch({ cmd: 'selection.clear' });
  });
  const chips = page.locator('.legend .field-chip');
  await expect(chips.filter({ hasText: 'unaveraged' })).toHaveCount(6);
  await page.locator('.legend').getByRole('button', { name: 'σxx unaveraged', exact: true }).click();
  await expect(page.locator('.legend-field')).toHaveText('σxx unaveraged');
  await expect(page.locator('.legend-unit')).toHaveText('MPa');
  const summary = await page.evaluate(async () => {
    const result = await window.fem.query.result();
    const field = await window.fem.query.field({ field: 'stressUnaveraged' });
    return { extreme: result.extremes.find(item => item.field === 'stressUnaveraged' && item.component === 0)!, per: field.per };
  });
  // The tutorial's load-path explanation independently states 60.7 MPa tension in the
  // mid-span bottom chord and −68.3 MPa compression in the top chord.
  expect(summary.extreme.max.unit).toBe('MPa');
  expect(summary.extreme.max.value).toBeCloseTo(60.7, 1);
  expect(summary.extreme.min.value).toBeCloseTo(-68.3, 1);
  expect(summary.per).toBe('elementNode');
  const row = page.locator('.rtable tbody tr').filter({ hasText: 'σxx unaveraged' });
  await expect(row).toContainText('60.7');
  await expect(row).toContainText('MPa');
  const saturated = await page.locator('canvas').evaluate(canvas => {
    const source = canvas as HTMLCanvasElement;
    const copy = document.createElement('canvas');
    copy.width = source.width;
    copy.height = source.height;
    const context = copy.getContext('2d')!;
    context.drawImage(source, 0, 0);
    const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const high = Math.max(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!);
      const low = Math.min(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!);
      if (high > 70 && high - low > 25) count++;
    }
    return count;
  });
  expect(saturated).toBeGreaterThan(100);
  const bottom = await memberPatch(page, 5, 0);
  const top = await memberPatch(page, 5, 2);
  expect(bottom.count).toBeGreaterThan(0);
  expect(top.count).toBeGreaterThan(0);
  expect(bottom.saturation).toBeGreaterThan(25);
  expect(top.saturation).toBeGreaterThan(25);
  expect(bottom.mean.reduce((difference, value, i) => difference + Math.abs(value - top.mean[i]!), 0)).toBeGreaterThan(100);
  await clickMember(page, 5, 0);
  await expect(page.locator('.probe')).toContainText('60.7');
  await clickMember(page, 5, 2);
  await expect(page.locator('.probe')).toContainText('-68.29');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'selection.clear' }));
  await page.evaluate(() => window.fem.dispatch({ cmd: 'view.setVisible', bodies: ['truss'], on: false }));
  expect((await memberPatch(page, 5, 0)).count).toBe(0);
  await page.evaluate(() => window.fem.dispatch({ cmd: 'view.setVisible', bodies: ['truss'], on: true }));
  expect((await memberPatch(page, 5, 0)).saturation).toBeGreaterThan(25);
  // Editing a load keeps the selected solve's contour and line identities on screen.
  await page.evaluate(() => window.fem.dispatch({ cmd: 'load.force', name: 'purlins', on: 'top-joints', total: ['0 kN', '-120 kN', '0 kN'] }));
  await expect(page.locator('.stale-banner')).toBeVisible();
  await expect(page.locator('.legend-field')).toHaveText('σxx unaveraged');
  expect((await memberPatch(page, 5, 0)).saturation).toBeGreaterThan(25);
  await page.evaluate(() => window.fem.dispatch({ cmd: 'journal.undo', steps: 1 }));
  await expect(page.locator('.stale-banner')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('unaveraged-roof-truss.png') });
});
