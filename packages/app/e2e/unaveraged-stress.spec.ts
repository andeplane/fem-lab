import { expect, test } from './fixtures';

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
  console.log(`unaveraged truss contour: ${saturated} saturated canvas pixels`);
  await page.screenshot({ path: testInfo.outputPath('unaveraged-roof-truss.png') });
});
