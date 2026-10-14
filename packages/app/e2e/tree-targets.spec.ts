import { expect, test, type Page } from './fixtures';

async function faceColour(page: Page): Promise<number[]> {
  return page.locator('canvas').evaluate(canvas => {
    const source = canvas as HTMLCanvasElement;
    const copy = document.createElement('canvas'); copy.width = source.width; copy.height = source.height;
    const context = copy.getContext('2d')!; context.drawImage(source, 0, 0);
    // The explicit camera looks at the interior of bar.xmax, so this patch measures the
    // target face itself, independently of the tree's selected class or Properties text.
    const pixels = context.getImageData(Math.floor(source.width / 2) - 8, Math.floor(source.height / 2) - 8, 16, 16).data;
    const rgb = [0, 0, 0];
    for (let i = 0; i < pixels.length; i += 4) for (let channel = 0; channel < 3; channel++) rgb[channel]! += pixels[i + channel]!;
    return rgb.map(value => Math.round(value / 256));
  });
}
const difference = (a: number[], b: number[]) => a.reduce((total, value, i) => total + Math.abs(value - b[i]!), 0);

test('@cpu heat constraint selection tints its real face and hover restores selection without journalling', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined');
  await page.evaluate(async () => {
    await window.fem.dispatch({ cmd: 'example.open', name: 'bar-transient-heat' });
    await window.fem.dispatch({ cmd: 'view.setMode', mode: 'geometry' });
    await window.fem.dispatch({ cmd: 'view.setProjection', projection: 'perspective' });
    await window.fem.dispatch({ cmd: 'view.setCamera', position: [0.12, 0.0125, 0.0125], target: [0.1, 0.0025, 0.0025], up: [0, 0, 1] });
    await window.fem.dispatch({ cmd: 'view.toggle', layer: 'grid', on: false });
    await window.fem.dispatch({ cmd: 'view.toggle', layer: 'axes', on: false });
    await window.fem.dispatch({ cmd: 'selection.clear' });
    await window.fem.dispatch({ cmd: 'view.hover' });
  });
  await page.mouse.move(0, 0);
  const journal = await page.evaluate(() => window.fem.query.journal());
  const normal = await faceColour(page);
  const driven = page.locator('.tree .row-main[title="Edit driven"]');
  await driven.click();
  await page.mouse.move(0, 0);
  await expect(page.locator('.props .panel-sub')).toHaveText('constraint.temperature');
  await expect(page.locator('.props [data-field="on"] .chip-set')).toContainText('bar.xmax');
  await expect.poll(() => page.evaluate(() => window.fem.registry.query({ query: 'query.selection' }))).toMatchObject({ sets: ['bar.xmax'] });
  await expect.poll(async () => difference(await faceColour(page), normal)).toBeGreaterThan(12);
  const selected = await faceColour(page);
  await page.screenshot({ path: testInfo.outputPath('heat-face-selected.png') });

  await driven.hover();
  await expect.poll(async () => difference(await faceColour(page), selected)).toBeGreaterThan(5);
  expect(await page.evaluate(() => window.fem.registry.query({ query: 'query.selection' }))).toMatchObject({ sets: ['bar.xmax'] });
  await page.mouse.move(0, 0);
  await expect.poll(() => faceColour(page)).toEqual(selected);

  // An AI can use the same preview Command; clearing it restores the persistent selection.
  await page.evaluate(() => window.fem.dispatch({ cmd: 'view.hover', bodies: ['bar'] }));
  await expect.poll(async () => difference(await faceColour(page), selected)).toBeGreaterThan(5);
  await page.evaluate(() => window.fem.dispatch({ cmd: 'view.hover' }));
  await expect.poll(() => faceColour(page)).toEqual(selected);
  expect(await page.evaluate(() => window.fem.query.journal())).toEqual(journal);
});
