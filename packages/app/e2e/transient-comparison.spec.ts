import type { ResultComparisonState } from '@femlab/registry';
import { expect, test, type Page } from './fixtures';

async function boot(page: Page) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => { localStorage.setItem('femlab.tour.dismissed', '1'); localStorage.setItem('femlab.autosave', 'off'); });
  await page.goto('./'); await page.waitForFunction(() => Boolean(window.fem));
}
const state = (page: Page) => page.evaluate(() => window.fem.registry.query({ query: 'query.resultComparison' })) as Promise<ResultComparisonState>;
async function colorful(page: Page, pane: string) {
  return page.locator(`[data-comparison-pane="${pane}"] canvas`).evaluate(element => {
    const source = element as HTMLCanvasElement, canvas = document.createElement('canvas'); canvas.width = source.width; canvas.height = source.height;
    const context = canvas.getContext('2d')!; context.drawImage(source, 0, 0);
    const bytes = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 0; i < bytes.length; i += 4) if (Math.max(bytes[i]!, bytes[i + 1]!, bytes[i + 2]!) - Math.min(bytes[i]!, bytes[i + 1]!, bytes[i + 2]!) > 20) count++;
    return count;
  });
}

test('@cpu sampled thermal comparison resolves independent unequal schedules and primary fields with actual scientific times', async ({ page }, info) => {
  test.setTimeout(120_000); await boot(page);
  const ids = await page.evaluate(async () => {
    await window.fem.model.new({ name: 'retained transient heat comparison' });
    await window.fem.model.setUnits({ units: { temperature: 'degC', time: 's' } });
    await window.fem.geometry.addBox({ name: 'bar', size: ['1 m', '0.1 m', '0.1 m'] });
    await window.fem.material.add({ name: 'thermal', rho: '2 kg/m^3', cp: '3 J/(kg*K)', k: '6 W/(m*K)' });
    await window.fem.material.assign({ material: 'thermal', bodies: ['bar'] });
    await window.fem.constraint.temperature({ name: 'ramp', on: 'bar.xmin', value: '1 K' });
    await window.fem.load.heatSource({ name: 'source', bodies: ['bar'], q: '6 W/m^3' });
    await window.fem.mesh.set({ mesher: { kind: 'lattice', size: { nx: 2, ny: 1, nz: 1 } }, order: 1 });
    await window.fem.step.add({ name: 'warm', procedure: 'heat-transient', constraints: ['ramp'], loads: ['source'], dt: '0.2 s', tEnd: '1 s', initial: '300 K', theta: 0.5, outputEvery: 2, amplitude: { kind: 'table', t: ['0 s', '1 s'], value: [300, 301] } });
    await window.fem.solve.run({ step: 'warm', solver: 'cpu-direct' });
    const left = (await window.fem.query.result()).resultId;
    await window.fem.mesh.set({ mesher: { kind: 'lattice', size: { nx: 4, ny: 1, nz: 1 } }, order: 2 });
    await window.fem.step.add({ name: 'warm', procedure: 'heat-transient', constraints: ['ramp'], loads: ['source'], dt: '0.4 s', tEnd: '0.9 s', initial: '300 K', theta: 0.5, outputEvery: 1, amplitude: { kind: 'table', t: ['0 s', '0.9 s'], value: [300, 300.9] } });
    await window.fem.solve.run({ step: 'warm', solver: 'cpu-direct' });
    return { left, right: (await window.fem.query.result()).resultId };
  });
  const journal = await page.evaluate(() => window.fem.query.journal());
  await page.getByLabel('left Result', { exact: true }).selectOption(ids.left);
  await page.getByLabel('right Result', { exact: true }).selectOption(ids.right);
  await page.getByLabel('left sample selection', { exact: true }).selectOption('frame');
  await page.getByLabel('right sample selection', { exact: true }).selectOption('time');
  await page.getByLabel('left retained frame', { exact: true }).selectOption('1');
  await page.getByLabel('right physical time', { exact: true }).fill('450 ms');
  await page.getByLabel('right time sampling', { exact: true }).selectOption('nearest');
  await page.locator('.comparison-actions .apply').click();
  await expect(page.locator('[data-comparison-pane]')).toHaveCount(2);
  const pair = await state(page);
  expect(pair.left!.sample!.frame.timeSi).toBeCloseTo(0.4, 14); expect(pair.right!.sample!.frame.timeSi).toBeCloseTo(0.3, 14);
  expect(pair.left!.canDeform).toBe(false); expect(pair.right!.canDeform).toBe(false);
  expect(pair.left!.legend!.max.value).toBeCloseTo(27.25, 8); expect(pair.right!.legend!.max.value).toBeCloseTo(27.15, 8);
  await expect(page.locator('[data-comparison-pane="left"] .comparison-pane-title')).toContainText('frame 1');
  await expect(page.locator('[data-comparison-pane="right"] .comparison-pane-title')).toContainText('0.3 s');
  await expect(page.locator('[data-cmd="view.setDeformScale"]')).toHaveCount(0);
  await expect.poll(() => colorful(page, 'left')).toBeGreaterThan(200); await expect.poll(() => colorful(page, 'right')).toBeGreaterThan(200);
  await page.getByLabel('comparison presentation').selectOption('difference');
  await page.getByLabel('difference target mesh').selectOption('right');
  await page.locator('.comparison-actions .apply').click();
  await expect(page.locator('[data-comparison-pane="difference"]')).toHaveCount(1);
  const comparison = await state(page);
  expect(comparison.difference!.legend!.min.unit).toBe('degC'); expect(comparison.difference!.legend!.min.value).toBeCloseTo(0.1, 8);
  const scientific = await page.evaluate(ids => window.fem.query.difference({ left: { resultId: ids.left, field: 'temperature', component: 0, sample: { kind: 'frame', index: 1 } }, right: { resultId: ids.right, field: 'temperature', component: 0, sample: { kind: 'time', time: '450 ms', sampling: 'nearest' } }, onto: 'right' }), ids);
  for (const value of scientific.values) expect(value).toBeCloseTo(0.1, 8);
  const pick = await page.evaluate(ids => window.fem.dispatch({ cmd: 'view.pickComparison', pane: 'difference', resultId: ids.right, at: [{ value: 1, unit: 'm' }, { value: 0.1, unit: 'm' }, { value: 0.1, unit: 'm' }] }), ids);
  expect(pick).toMatchObject({ value: { unit: 'K' }, samples: { left: { resultId: ids.left, frame: { index: 1 } }, right: { resultId: ids.right, frame: { index: 1 } } } });
  expect(await page.evaluate(() => window.fem.query.journal())).toEqual(journal);
  await page.screenshot({ path: info.outputPath('sampled-unequal-thermal-difference.png') });
  await info.attach('sampled-unequal-thermal-difference', { path: info.outputPath('sampled-unequal-thermal-difference.png'), contentType: 'image/png' });
});

test('@cpu sampled explicit comparison colors and deforms the same actual retained free-fall frame', async ({ page }, info) => {
  test.setTimeout(120_000); await boot(page);
  const ids = await page.evaluate(async () => {
    await window.fem.model.new({ name: 'retained explicit comparison' });
    await window.fem.model.setUnits({ units: { length: 'mm', time: 'ms' } });
    await window.fem.geometry.addBox({ name: 'bar', size: ['1 m', '0.1 m', '0.1 m'] });
    await window.fem.material.add({ name: 'solid', E: '1 MPa', nu: 0.25, rho: '2 kg/m^3' });
    await window.fem.material.assign({ material: 'solid', bodies: ['bar'] });
    await window.fem.load.gravity({ name: 'g', g: ['0 m/s^2', '-9.81 m/s^2', '0 m/s^2'] });
    await window.fem.mesh.set({ mesher: { kind: 'lattice', size: { nx: 2, ny: 1, nz: 1 } }, order: 1 });
    await window.fem.step.add({ name: 'fall', procedure: 'explicit', constraints: [], loads: ['g'], tEnd: '1.3 ms', dtFactor: 0.5, outputEvery: 3 });
    await window.fem.solve.run({ step: 'fall', solver: 'cpu-direct' });
    const left = (await window.fem.query.result()).resultId;
    await window.fem.mesh.set({ mesher: { kind: 'lattice', size: { nx: 4, ny: 1, nz: 1 } }, order: 2 });
    await window.fem.step.add({ name: 'fall', procedure: 'explicit', constraints: [], loads: ['g'], tEnd: '1.7 ms', dtFactor: 0.9, outputEvery: 2 });
    await window.fem.solve.run({ step: 'fall', solver: 'cpu-direct' });
    return { left, right: (await window.fem.query.result()).resultId };
  });
  const journal = await page.evaluate(() => window.fem.query.journal());
  const frames = await page.evaluate(async ids => [await window.fem.query.frames({ resultId: ids.left }), await window.fem.query.frames({ resultId: ids.right })], ids);
  const rightIndex = frames[1]!.frames.length - 1;
  await page.evaluate(async ({ ids, rightIndex }) => {
    await window.fem.dispatch({ cmd: 'view.compareResults', mode: 'sideBySide', left: { resultId: ids.left, field: 'displacement', component: 1, sample: { kind: 'frame', index: 1 } }, right: { resultId: ids.right, field: 'displacement', component: 1, sample: { kind: 'frame', index: rightIndex } } });
    await window.fem.dispatch({ cmd: 'view.setDeformScale', scale: 1000 });
  }, { ids, rightIndex });
  const pair = await state(page);
  const lt = pair.left!.sample!.frame.timeSi, rt = pair.right!.sample!.frame.timeSi;
  expect(pair.left!.canDeform).toBe(true); expect(pair.right!.canDeform).toBe(true);
  expect(pair.left!.legend!.min.unit).toBe('mm'); expect(pair.right!.legend!.min.unit).toBe('mm');
  expect(pair.left!.legend!.min.value).toBeCloseTo(-4.905 * lt * lt * 1000, 10);
  expect(pair.right!.legend!.min.value).toBeCloseTo(-4.905 * rt * rt * 1000, 10);
  const leftPick = await page.evaluate(ids => window.fem.dispatch({ cmd: 'view.pickComparison', pane: 'left', resultId: ids.left, at: [{ value: 1, unit: 'm' }, { value: 0.1, unit: 'm' }, { value: 0.1, unit: 'm' }] }), ids);
  expect(leftPick).toMatchObject({ value: { unit: 'm' }, samples: { left: { resultId: ids.left, frame: { index: 1 } } } });
  await expect.poll(() => colorful(page, 'left')).toBeGreaterThan(200); await expect.poll(() => colorful(page, 'right')).toBeGreaterThan(200);
  const difference = await page.evaluate(({ ids, rightIndex }) => window.fem.query.difference({ left: { resultId: ids.left, field: 'displacement', component: 1, sample: { kind: 'frame', index: 1 } }, right: { resultId: ids.right, field: 'displacement', component: 1, sample: { kind: 'frame', index: rightIndex } }, onto: 'right' }), { ids, rightIndex });
  for (const value of difference.values) expect(value).toBeCloseTo(-4.905 * (lt * lt - rt * rt), 12);
  expect(await page.evaluate(() => window.fem.query.journal())).toEqual(journal);
  await page.screenshot({ path: info.outputPath('sampled-explicit-frame-comparison.png') });
  await info.attach('sampled-explicit-frame-comparison', { path: info.outputPath('sampled-explicit-frame-comparison.png'), contentType: 'image/png' });
});
