import { expect, test, type Page } from './fixtures';

const commands = [
  { cmd: 'model.new', name: 'two-bar' },
  { cmd: 'geometry.addLine', name: 'truss', points: [['0 m', '0 m', '0 m'], ['2 m', '0 m', '0 m'], ['1 m', '1 m', '0 m']], members: [[0, 2], [1, 2]], divisions: 1 },
  { cmd: 'material.add', name: 'steel', E: '200 GPa', nu: 0.3, rho: '7850 kg/m^3' },
  { cmd: 'material.assign', material: 'steel', bodies: ['truss'] },
  { cmd: 'section.add', name: 'rod', shape: { kind: 'circle', radius: '20 mm' } },
  { cmd: 'section.assign', section: 'rod', bodies: ['truss'] },
  { cmd: 'mesh.set', mesher: { kind: 'lattice', size: '1 m' }, order: 1 },
  { cmd: 'geometry.nameRegion', name: 'plane', where: { kind: 'bbox', min: ['-10 mm', '-10 mm', '-10 mm'], max: ['2010 mm', '1010 mm', '10 mm'] } },
  { cmd: 'constraint.fix', name: 'flat', on: 'plane', dofs: ['uz'] },
  { cmd: 'constraint.fix', name: 'left', on: 'truss.p0' },
  { cmd: 'constraint.fix', name: 'right', on: 'truss.p1' },
  { cmd: 'load.force', name: 'hang', on: 'truss.p2', total: ['0 kN', '-10 kN', '0 kN'] },
  { cmd: 'step.add', name: 'static', procedure: 'static', constraints: ['flat', 'left', 'right'], loads: ['hang'], output: ['displacement', 'stress'] },
];

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(async () => typeof window.fem !== 'undefined' && Boolean(await window.fem.query.capabilities()), undefined, { timeout: 60_000 });
}

async function patch(page: Page, x: number, y: number): Promise<{ bright: number; maxSat: number; mean: [number, number, number] }> {
  return page.evaluate(({ x, y }) => {
    const canvas = document.querySelector('canvas')!;
    const rect = canvas.getBoundingClientRect();
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext('2d')!;
    context.drawImage(canvas, 0, 0);
    const scale = canvas.width / rect.width;
    const px = Math.round(x * rect.width * scale);
    const py = Math.round(y * rect.height * scale);
    const data = context.getImageData(px - 5, py - 5, 11, 11).data;
    let bright = 0;
    let maxSat = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    for (let i = 0; i < data.length; i += 4) {
      const hi = Math.max(data[i]!, data[i + 1]!, data[i + 2]!);
      const lo = Math.min(data[i]!, data[i + 1]!, data[i + 2]!);
      if (hi > 70) {
        bright++;
        sumR += data[i]!;
        sumG += data[i + 1]!;
        sumB += data[i + 2]!;
      }
      maxSat = Math.max(maxSat, hi - lo);
    }
    return { bright, maxSat, mean: bright === 0 ? [0, 0, 0] : [sumR / bright, sumG / bright, sumB / bright] };
  }, { x, y });
}

function screen(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.locator('canvas').boundingBox().then((rect) => ({ x: rect!.x + x * rect!.width, y: rect!.y + y * rect!.height }));
}

test('@cpu draws and colors two-bar line members while preserving visibility and picking', async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
  await page.goto('./');
  await ready(page);
  await page.evaluate(async (journal) => {
    for (const command of journal) await window.fem.dispatch(command);
    await window.fem.dispatch({ cmd: 'view.setProjection', projection: 'orthographic' });
    await window.fem.dispatch({ cmd: 'view.setCamera', position: [1, 0.33, 8], target: [1, 0.33, 0], up: [0, 1, 0] });
    await window.fem.dispatch({ cmd: 'view.toggle', layer: 'grid', on: false });
    await window.fem.dispatch({ cmd: 'view.toggle', layer: 'axes', on: false });
  }, commands);

  await expect(page.locator('.tree .name', { hasText: 'truss' })).toBeVisible();
  // With the front orthographic camera, these are the midpoints of the two known members.
  const left = { x: 0.4055, y: 0.446 };
  const right = { x: 0.5945, y: 0.446 };
  await expect.poll(() => patch(page, left.x, left.y).then((p) => p.bright)).toBeGreaterThan(0);
  const geometryLeft = await patch(page, left.x, left.y);
  const geometryRight = await patch(page, right.x, right.y);
  expect(geometryLeft.bright).toBeGreaterThan(0);
  expect(geometryRight.bright).toBeGreaterThan(0);
  expect(geometryLeft.maxSat).toBeLessThan(50);
  expect(geometryRight.maxSat).toBeLessThan(50);

  await page.evaluate(() => window.fem.dispatch({ cmd: 'selection.clear' }));
  const hit = await screen(page, left.x, left.y);
  await page.mouse.click(hit.x, hit.y);
  await expect(page.locator('.probe')).toContainText('truss');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'selection.clear' }));

  await page.evaluate(() => window.fem.dispatch({ cmd: 'solve.run', step: 'static' }));
  await page.evaluate(() => window.fem.dispatch({ cmd: 'view.setDeformScale', scale: 0 }));
  await page.getByRole('button', { name: 'uy', exact: true }).click();
  await expect.poll(() => patch(page, left.x, left.y).then((p) => p.maxSat)).toBeGreaterThan(25);
  await expect.poll(() => patch(page, right.x, right.y).then((p) => p.maxSat)).toBeGreaterThan(25);
  const uyColour = await patch(page, left.x, left.y);
  await page.getByRole('button', { name: '|u|', exact: true }).click();
  await expect(page.locator('.legend-field')).toHaveText('|u|');
  await expect.poll(async () => {
    const umagColour = await patch(page, left.x, left.y);
    return Math.abs(uyColour.mean[0] - umagColour.mean[0]) + Math.abs(uyColour.mean[1] - umagColour.mean[1]) + Math.abs(uyColour.mean[2] - umagColour.mean[2]);
  }).toBeGreaterThan(6);

  await page.evaluate(() => window.fem.dispatch({ cmd: 'view.setVisible', bodies: ['truss'], on: false }));
  await expect.poll(() => patch(page, left.x, left.y).then((p) => p.bright)).toBe(0);
  await page.evaluate(() => window.fem.dispatch({ cmd: 'view.setVisible', bodies: ['truss'], on: true }));
  await expect.poll(() => patch(page, right.x, right.y).then((p) => p.bright)).toBeGreaterThan(0);

  await page.evaluate(() => window.fem.dispatch({ cmd: 'view.toggle', layer: 'edges', on: false }));
  await expect.poll(() => patch(page, right.x, right.y).then((p) => p.bright)).toBe(0);
  await page.evaluate(() => window.fem.dispatch({ cmd: 'view.toggle', layer: 'edges', on: true }));
  await expect.poll(() => patch(page, right.x, right.y).then((p) => p.maxSat)).toBeGreaterThan(25);
});
