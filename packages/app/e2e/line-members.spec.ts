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
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
}

async function patch(page: Page, x: number, y: number): Promise<{ bright: number; maxSat: number; mean: [number, number, number] }> {
  return page.evaluate(({ x, y }) => {
    const canvas = document.querySelector('canvas')!;
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext('2d')!;
    context.drawImage(canvas, 0, 0);
    // The front orthographic camera targets (1, .33); the 2 x 1 m truss diagonal
    // fixes its viewport height. Probe a physical point, independent of strip height.
    const scale = canvas.height / (2 * Math.hypot(2, 1) * 0.7);
    const px = Math.round(canvas.width / 2 + (x - 1) * scale);
    const py = Math.round(canvas.height / 2 - (y - 0.33) * scale);
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
  return page.locator('canvas').boundingBox().then((rect) => {
    const scale = rect!.height / (2 * Math.hypot(2, 1) * 0.7);
    return { x: rect!.x + rect!.width / 2 + (x - 1) * scale, y: rect!.y + rect!.height / 2 - (y - 0.33) * scale };
  });
}

test('@cpu draws and colors two-bar line members while preserving visibility and picking', async ({ page }, info) => {
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
  // At the midpoint, reversing endpoint colors gives the same interpolated color.
  // The physical quarter points have distinct signed-uy and magnitude colors.
  const left = { x: 0.25, y: 0.25 };
  const right = { x: 1.75, y: 0.25 };
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
  const displacement = await page.evaluate(() => window.fem.query.field({ field: 'displacement' }));
  expect(displacement.unit).toBe('m');
  expect(displacement.components).toBe(3);
  expect(displacement.entityCount).toBe(3);
  const uy: number[] = [], magnitude: number[] = [];
  for (let node = 0; node < displacement.entityCount; node++) {
    const [ux, y, uz] = displacement.values.slice(node * 3, node * 3 + 3) as [number, number, number];
    expect(ux).toBeCloseTo(0, 12); expect(uz).toBeCloseTo(0, 12);
    uy.push(y); magnitude.push(Math.hypot(ux, y, uz));
  }
  // Each 45-degree member contributes (EA/L) sin²(45°), so δ = P√2/(EA).
  const delta = 10_000 * Math.SQRT2 / (200e9 * Math.PI * 0.02 ** 2);
  expect(Math.min(...uy)).toBeCloseTo(-delta, 12); expect(Math.max(...uy)).toBe(0);
  expect(Math.min(...magnitude)).toBe(0); expect(Math.max(...magnitude)).toBeCloseTo(delta, 12);
  await page.getByRole('button', { name: 'uy', exact: true }).click();
  await expect.poll(() => patch(page, left.x, left.y).then((p) => p.maxSat)).toBeGreaterThan(25);
  await expect.poll(() => patch(page, right.x, right.y).then((p) => p.maxSat)).toBeGreaterThan(25);
  const uyColours = await Promise.all([patch(page, left.x, left.y), patch(page, right.x, right.y)]);
  await page.getByRole('button', { name: '|u|', exact: true }).click();
  await expect(page.locator('.legend-field')).toHaveText('|u|');
  const samples = [];
  for (const [index, point] of [left, right].entries()) {
    const uyColour = uyColours[index]!;
    await expect.poll(async () => {
      const umagColour = await patch(page, point.x, point.y);
      return Math.abs(uyColour.mean[0] - umagColour.mean[0]) + Math.abs(uyColour.mean[1] - umagColour.mean[1]) + Math.abs(uyColour.mean[2] - umagColour.mean[2]);
    }).toBeGreaterThan(6);
    samples.push({ point, screen: await screen(page, point.x, point.y), uyColour, magnitudeColour: await patch(page, point.x, point.y) });
  }
  await info.attach('physical-line-color-probes', { body: JSON.stringify({ delta, uy, magnitude, samples }), contentType: 'application/json' });
  await info.attach('physical-line-colors', { body: await page.screenshot(), contentType: 'image/png' });

  await page.evaluate(() => window.fem.dispatch({ cmd: 'view.setVisible', bodies: ['truss'], on: false }));
  await expect.poll(() => patch(page, left.x, left.y).then((p) => p.bright)).toBe(0);
  await page.evaluate(() => window.fem.dispatch({ cmd: 'view.setVisible', bodies: ['truss'], on: true }));
  await expect.poll(() => patch(page, right.x, right.y).then((p) => p.bright)).toBeGreaterThan(0);

  await page.evaluate(() => window.fem.dispatch({ cmd: 'view.toggle', layer: 'edges', on: false }));
  await expect.poll(() => patch(page, right.x, right.y).then((p) => p.bright)).toBe(0);
  await page.evaluate(() => window.fem.dispatch({ cmd: 'view.toggle', layer: 'edges', on: true }));
  await expect.poll(() => patch(page, right.x, right.y).then((p) => p.maxSat)).toBeGreaterThan(25);
});
