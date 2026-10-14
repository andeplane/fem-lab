import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from './fixtures';

// A hand-authored typed source, not an Abaqus-parser/file-picker claim.
const source = JSON.parse(readFileSync(path.join(import.meta.dirname, '../../../crates/engine/tests/fixtures/imported/sparse-tet.json'), 'utf8'));

async function brightPixels(page: Page): Promise<number> {
  return page.locator('canvas').first().evaluate(canvas => {
    const source = canvas as HTMLCanvasElement;
    const copy = document.createElement('canvas'); copy.width = source.width; copy.height = source.height;
    const context = copy.getContext('2d')!; context.drawImage(source, 0, 0);
    const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
    let visible = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i]! > 60 && pixels[i + 1]! > 60 && pixels[i + 2]! > 60) visible++;
    return visible;
  });
}

test('@cpu imported authored source previews, edits losslessly and reopens without source I/O', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1720, height: 1000 });
  await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined');
  await page.evaluate(async command => {
    await window.fem.dispatch({ cmd: 'project.new', name: 'authored source' });
    await window.fem.dispatch(command);
    await window.fem.dispatch({ cmd: 'view.setTheme', theme: 'dark' });
    await window.fem.dispatch({ cmd: 'view.toggle', layer: 'grid', on: false });
    await window.fem.dispatch({ cmd: 'view.toggle', layer: 'axes', on: false });
    await window.fem.dispatch({ cmd: 'view.fit' });
  }, source);
  await expect(page.locator('.tree')).toContainText('part');
  await expect(page.locator('.tree')).toContainText('part.nset_COINCIDENT');
  await expect(page.locator('.tree')).toContainText('part.elset_ALL');
  const before = await page.evaluate(() => window.fem.query.model());
  const mesh = await page.evaluate(() => window.fem.query.mesh());
  expect(mesh.nodes).toBe(4);
  expect(mesh.elements).toBe(1);
  expect(mesh.sourceLabels).toEqual({ nodes: [10, 77, 88, 301], elements: [409], unusedNodes: [999] });
  const sourceSet = await page.evaluate(() => window.fem.query.set({ name: 'part.nset_COINCIDENT' }));
  expect(sourceSet.sourceNodeLabels).toEqual([10, 999]);
  expect(sourceSet.unusedSourceNodeLabels).toEqual([999]);
  expect(sourceSet.count).toBe(2);
  // Actual rendered pixels must show the unsolved tetrahedron, not only a transport count.
  await expect.poll(() => brightPixels(page)).toBeGreaterThan(1000);
  const shown = await brightPixels(page);
  await page.evaluate(() => window.fem.dispatch({ cmd: 'view.setVisible', bodies: ['part'], on: false }));
  await expect.poll(() => brightPixels(page)).toBeLessThan(shown - 1000);
  await page.evaluate(() => window.fem.dispatch({ cmd: 'view.setVisible', bodies: ['part'], on: true }));
  await expect.poll(() => brightPixels(page)).toBeGreaterThan(shown - 1000);
  await page.locator('.tree .row-main').filter({ has: page.locator('.name', { hasText: /^mesh$/ }) }).click();
  await expect(page.locator('.props .panel-sub')).toHaveText('mesh.set');
  await page.locator('.props .apply').click();
  await expect.poll(() => page.evaluate(() => window.fem.query.model())).toMatchObject({ hash: before.hash });
  // Save is a FEM Lab model/Journal, so the typed fixture is unnecessary on reopen.
  // Use the existing file.save download, not a second source-import host.
  const downloadPromise = page.waitForEvent('download');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'file.save', to: 'download', name: 'source.femlab.json' }));
  const download = await downloadPromise;
  const savedPath = await download.path();
  expect(savedPath).not.toBeNull();
  const json = readFileSync(savedPath!, 'utf8');
  expect(JSON.parse(json).model.mesh.mesher.nodes).toHaveLength(5);
  await page.evaluate(async json => {
    await window.fem.dispatch({ cmd: 'model.new', name: 'replacement' });
    await window.fem.dispatch({ cmd: 'file.open', json });
  }, json);
  await expect.poll(() => page.evaluate(() => window.fem.query.model())).toMatchObject({ hash: before.hash });
  expect((await page.evaluate(() => window.fem.query.mesh())).sourceLabels).toEqual(mesh.sourceLabels);
});
