import type { DifferenceField, ResultComparisonState, ResultSummary } from '@femlab/registry';
import { expect, test, type Page } from './fixtures';

async function boot(page: Page) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => { localStorage.setItem('femlab.tour.dismissed', '1'); localStorage.setItem('femlab.autosave', 'off'); });
  await page.goto('./'); await page.waitForFunction(() => Boolean(window.fem));
}
async function axialPair(page: Page): Promise<{ left: string; right: string }> {
  return page.evaluate(async () => {
    await window.fem.model.new({ name: 'retained axial comparison' });
    await window.fem.model.setUnits({ units: { length: 'mm', stress: 'MPa', force: 'N' } });
    await window.fem.geometry.addBox({ name: 'bar', size: ['1 m', '100 mm', '100 mm'] });
    await window.fem.material.add({ name: 'solid', E: '1 GPa', nu: 0 });
    await window.fem.material.assign({ material: 'solid', bodies: ['bar'] });
    await window.fem.constraint.fix({ name: 'root', on: 'bar.xmin' });
    await window.fem.load.traction({ name: 'tip', on: 'bar.xmax', total: ['100 N', '0 N', '0 N'] });
    await window.fem.mesh.set({ mesher: { kind: 'lattice', size: '100 mm' }, order: 1 });
    await window.fem.step.add({ name: 'axial', procedure: 'static', constraints: ['root'], loads: ['tip'] });
    await window.fem.solve.run({ step: 'axial', solver: 'cpu-direct' });
    const left = (await window.fem.query.result()).resultId;
    await window.fem.material.add({ name: 'solid', E: '2 GPa', nu: 0 });
    await window.fem.mesh.set({ mesher: { kind: 'lattice', size: '50 mm' }, order: 1 });
    await window.fem.solve.run({ step: 'axial', solver: 'cpu-direct' });
    return { left, right: (await window.fem.query.result()).resultId };
  });
}
const read = (page: Page) => page.evaluate(() => window.fem.registry.query({ query: 'query.resultComparison' })) as Promise<ResultComparisonState>;
async function raster(page: Page, pane: string) {
  return page.locator(`[data-comparison-pane="${pane}"] canvas`).evaluate(element => {
    const source = element as HTMLCanvasElement, copy = document.createElement('canvas'); copy.width = source.width; copy.height = source.height;
    const ctx = copy.getContext('2d')!; ctx.drawImage(source, 0, 0);
    const bytes = ctx.getImageData(0, 0, copy.width, copy.height).data;
    let count = 0, minX = copy.width, maxX = 0, minY = copy.height, maxY = 0;
    for (let i = 0; i < bytes.length; i += 4) {
      const max = Math.max(bytes[i]!, bytes[i + 1]!, bytes[i + 2]!), min = Math.min(bytes[i]!, bytes[i + 1]!, bytes[i + 2]!);
      if (max < 50 || max - min < 20) continue;
      const x = i / 4 % copy.width, y = Math.floor(i / 4 / copy.width); count++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    return { count, minX, maxX, minY, maxY, width: copy.width, height: copy.height, png: source.toDataURL() };
  });
}
async function cleanView(page: Page) {
  await page.evaluate(async () => {
    await window.fem.dispatch({ cmd: 'view.toggle', layer: 'grid', on: false });
    await window.fem.dispatch({ cmd: 'view.toggle', layer: 'axes', on: false });
    await window.fem.dispatch({ cmd: 'view.setDeformScale', scale: 0 });
    await window.fem.dispatch({ cmd: 'view.setProjection', projection: 'orthographic' });
    await window.fem.dispatch({ cmd: 'view.setCamera', position: [0.5, 0.05, 4], target: [0.5, 0.05, 0], up: [0, 1, 0], zoom: 1 });
  });
}

test('@cpu independent retained panes preserve physics, surfaces, legends, scoped picking, hidden bodies and synchronized cameras', async ({ page }, info) => {
  test.setTimeout(180_000); await boot(page); const ids = await axialPair(page);
  const before = await page.evaluate(() => window.fem.query.journal());
  await page.getByLabel('left Result', { exact: true }).selectOption(ids.left);
  await page.getByLabel('right Result', { exact: true }).selectOption(ids.right);
  await page.getByLabel('left field', { exact: true }).selectOption('ux');
  await page.getByLabel('right field', { exact: true }).selectOption('vonMises');
  await page.locator('.comparison-actions .apply').click();
  await expect(page.locator('[data-comparison-pane]')).toHaveCount(2); await cleanView(page);
  const state = await read(page);
  expect(state.left!.operand).toEqual({ resultId: ids.left, field: 'displacement', component: 0 });
  expect(state.right!.operand).toEqual({ resultId: ids.right, field: 'vonMises', component: 0 });
  // Independent closed forms: PL/EA =0.01 mm and P/A =0.01 MPa, unaffected by mesh density.
  expect(state.left!.legend!.max.unit).toBe('mm'); expect(state.left!.legend!.max.value).toBeCloseTo(0.01, 7);
  expect(state.right!.legend!.max.unit).toBe('MPa'); expect(state.right!.legend!.max.value).toBeCloseTo(0.01, 7);
  expect(state.left!.summary.stale).toBe(true); expect(state.right!.summary.stale).toBe(false);
  const surfaces = await page.evaluate(async ids => [await window.fem.query.surface({ resultId: ids.left }), await window.fem.query.surface({ resultId: ids.right })], ids);
  expect(surfaces[0]!.nodeCount).not.toBe(surfaces[1]!.nodeCount);
  await expect.poll(async () => (await raster(page, 'left')).count).toBeGreaterThan(200);
  await expect.poll(async () => (await raster(page, 'right')).count).toBeGreaterThan(200);
  for (const name of ['left', 'right']) {
    const image = await raster(page, name); expect(image.maxX - image.minX).toBeGreaterThan(image.width * 0.2);
    expect(image.minX).toBeGreaterThan(2); expect(image.maxX).toBeLessThan(image.width - 2);
  }
  await page.evaluate(async ids => {
    await Promise.all([
      window.fem.dispatch({ cmd: 'view.setComparisonLegend', pane: 'left', resultId: ids.left, range: [{ value: 0, unit: 'mm' }, { value: 0.02, unit: 'mm' }], colormap: 'turbo' }),
      window.fem.dispatch({ cmd: 'view.setComparisonLegend', pane: 'right', resultId: ids.right, range: [{ value: 0, unit: 'MPa' }, { value: 0.03, unit: 'MPa' }] }),
    ]);
  }, ids);
  expect((await read(page)).left!.legend!.max.value).toBe(0.02); expect((await read(page)).right!.legend!.max.value).toBe(0.03);
  const selection = await page.evaluate(() => window.fem.registry.query({ query: 'query.selection' }));
  const image = await raster(page, 'left'), rect = (await page.locator('[data-comparison-pane="left"] canvas').boundingBox())!;
  await page.mouse.click(rect.x + (image.minX + image.maxX) / 2 / image.width * rect.width, rect.y + (image.minY + image.maxY) / 2 / image.height * rect.height);
  await expect.poll(async () => (await read(page)).left!.pick?.resultId).toBe(ids.left);
  expect(await page.evaluate(() => window.fem.registry.query({ query: 'query.selection' }))).toEqual(selection);
  await page.locator('[data-comparison-pane="left"] [data-cmd="view.setComparisonVisible"]').click();
  expect((await read(page)).left!.hiddenBodies).toEqual(['bar']); expect((await read(page)).right!.hiddenBodies).toEqual([]);
  await expect.poll(async () => (await raster(page, 'left')).count).toBe(0);
  expect((await raster(page, 'right')).count).toBeGreaterThan(200);
  await page.locator('[data-comparison-pane="left"] [data-cmd="view.setComparisonVisible"]').click();
  const cameraBefore = await page.evaluate(() => window.fem.registry.query({ query: 'query.view' }));
  const leftBefore = (await raster(page, 'left')).png, rightBefore = (await raster(page, 'right')).png;
  const rightRect = (await page.locator('[data-comparison-pane="right"] canvas').boundingBox())!;
  await page.mouse.move(rightRect.x + rightRect.width * 0.4, rightRect.y + rightRect.height * 0.55); await page.mouse.down();
  await page.mouse.move(rightRect.x + rightRect.width * 0.5, rightRect.y + rightRect.height * 0.4, { steps: 10 }); await page.mouse.up();
  expect(await page.evaluate(() => window.fem.registry.query({ query: 'query.view' }))).not.toEqual(cameraBefore);
  expect((await raster(page, 'left')).png).not.toBe(leftBefore); expect((await raster(page, 'right')).png).not.toBe(rightBefore);
  expect(await page.evaluate(() => window.fem.query.journal())).toEqual(before);
  await page.screenshot({ path: info.outputPath('retained-two-meshes-two-materials.png') });
  await page.evaluate(() => window.fem.load.traction({ name: 'tip', on: 'bar.xmax', total: ['200 N', '0 N', '0 N'] }));
  expect((await read(page)).left!.summary.stale).toBe(true); expect((await read(page)).right!.summary.stale).toBe(true);
  await page.evaluate(() => window.fem.solve.run({ step: 'axial', solver: 'cpu-direct' }));
  expect((await read(page)).configuration).toEqual(state.configuration);
  expect((await read(page)).left!.legend!.max.value).toBe(0.02); expect((await read(page)).right!.legend!.max.value).toBe(0.03);
  await page.getByRole('button', { name: 'Single Result', exact: true }).click();
  await expect(page.locator('[data-comparison-pane]')).toHaveCount(0); await expect(page.locator('.legend')).toBeVisible();
});

test('@cpu engine differences retain the target mesh, missing coverage and identity through geometry/mesh/results and eviction', async ({ page }, info) => {
  test.setTimeout(180_000); await boot(page); const ids = await axialPair(page);
  await page.evaluate(ids => window.fem.dispatch({ cmd: 'view.compareResults', mode: 'difference', left: { resultId: ids.left, field: 'displacement', component: 0 }, right: { resultId: ids.right, field: 'displacement', component: 0 }, onto: 'right' }), ids);
  await cleanView(page);
  const state = await read(page); expect(state.difference!.operand.resultId).toBe(ids.right);
  expect(state.difference!.legend!.max.value).toBeCloseTo(0.005, 7); expect(state.coverage!.insideNodes).toBe(state.coverage!.totalNodes); expect(state.interpolated).toBe(true);
  await page.evaluate(() => window.fem.geometry.addBox({ name: 'bar', size: ['2 m', '100 mm', '100 mm'] }));
  for (const mode of ['geometry', 'mesh', 'results'] as const) {
    await page.evaluate(mode => window.fem.dispatch({ cmd: 'view.setMode', mode }), mode);
    expect((await read(page)).configuration).toEqual(state.configuration);
    await expect(page.locator('[data-comparison-pane="difference"]')).toHaveCount(mode === 'results' ? 1 : 0);
  }
  await page.evaluate(() => window.fem.solve.run({ step: 'axial', solver: 'cpu-direct' }));
  const latest = await page.evaluate(() => window.fem.query.result()) as ResultSummary;
  expect((await read(page)).configuration).toEqual(state.configuration);
  const input = { mode: 'difference', left: { resultId: ids.left, field: 'displacement', component: 0 }, right: { resultId: latest.resultId, field: 'displacement', component: 0 }, onto: 'right' };
  await page.evaluate(input => window.fem.dispatch({ cmd: 'view.compareResults', ...input }), input);
  await page.evaluate(async () => {
    await window.fem.dispatch({ cmd: 'view.fit' });
    await window.fem.dispatch({ cmd: 'view.setCamera', position: [1, 0.05, 4], target: [1, 0.05, 0], up: [0, 1, 0], zoom: 1 });
  });
  const partial = await read(page); expect(partial.coverage!.outsideNodes.length).toBeGreaterThan(0);
  const scientific = await page.evaluate(input => window.fem.query.difference({ left: input.left, right: input.right, onto: 'right' }), input) as DifferenceField;
  expect(scientific.values.filter(value => value === null).length).toBe(partial.coverage!.outsideNodes.length);
  expect(partial.difference!.legend!.max.value).toBeCloseTo(0.005, 7);
  const pick = await page.evaluate(resultId => window.fem.dispatch({ cmd: 'view.pickComparison', pane: 'difference', resultId, at: [{ value: 2, unit: 'm' }, { value: 0.1, unit: 'm' }, { value: 0.1, unit: 'm' }], body: 'bar' }), latest.resultId);
  expect(pick).toMatchObject({ resultId: latest.resultId, difference: true, value: null });
  await expect(page.locator('.probe')).toContainText('unavailable coverage');
  await page.screenshot({ path: info.outputPath('difference-missing-coverage.png') });
  await page.evaluate(async () => { for (let i = 0; i < 8; i++) await window.fem.solve.run({ step: 'axial', solver: 'cpu-direct' }); });
  const unavailable = await read(page); expect(unavailable.configuration).toEqual(input); expect(unavailable.difference!.error?.code).toBe('not-found');
  await expect(page.locator('.comparison-pane-title')).toContainText('unavailable or evicted');
  expect((await raster(page, 'difference')).count).toBe(0);
  await page.evaluate(() => window.fem.dispatch({ cmd: 'project.new', name: 'replacement session' }));
  expect((await read(page)).configuration.mode).toBe('single'); expect((await read(page)).catalogue.records).toEqual([]);
});
