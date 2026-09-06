import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const commands = JSON.parse(readFileSync(path.join(import.meta.dirname, '../../../crates/engine/tests/fixtures/sheet-preview.json'), 'utf8'));

test('@cpu unmeshed transformed Sheet outlines are visible and named outer/hole edges are pickable', async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
  await page.goto('./');
  await page.waitForFunction(async () => typeof window.fem !== 'undefined' && Boolean(await window.fem.query.capabilities()), undefined, { timeout: 60_000 });
  await page.evaluate(async (commands) => {
    for (const cmd of commands) await window.fem.dispatch(cmd);
    await window.fem.dispatch({ cmd: 'view.setProjection', projection: 'orthographic' });
    await window.fem.dispatch({ cmd: 'view.setCamera', position: [2, 9, 20], target: [2, 9, 0], up: [0, 1, 0] });
    await window.fem.dispatch({ cmd: 'view.toggle', layer: 'grid', on: false });
    await window.fem.dispatch({ cmd: 'view.toggle', layer: 'axes', on: false });
  }, commands);
  const canvas = page.locator('canvas').first();
  const rect = (await canvas.boundingBox())!;
  // Exact transformed rectangle is [-1,5] × [7,11]; camera framing uses its diagonal.
  const pixelsPerMetre = rect.height / (2 * Math.sqrt(52) * 0.7);
  const screen = (x: number, y: number) => ({ x: rect.x + rect.width / 2 + (x - 2) * pixelsPerMetre, y: rect.y + rect.height / 2 - (y - 9) * pixelsPerMetre });
  const outer = screen(2, 11);
  // Read the rendered canvas, not the transport: an absent outline must fail visibility.
  await expect.poll(async () => canvas.evaluate((c, p) => {
    const source = c as HTMLCanvasElement;
    const copy = document.createElement('canvas'); copy.width = source.width; copy.height = source.height;
    const ctx = copy.getContext('2d')!; ctx.drawImage(source, 0, 0);
    const scale = source.width / source.clientWidth;
    const data = ctx.getImageData(Math.round(p.x * scale) - 3, Math.round(p.y * scale) - 3, 7, 7).data;
    return Array.from(data).filter((v, i) => i % 4 !== 3 && v > 100).length;
  }, { x: outer.x - rect.x, y: outer.y - rect.y })).toBeGreaterThan(3);
  for (const [x, y, name] of [[2, 11, 'plate.right'], [5, 9, 'plate.bottom'], [2, 7, 'plate.left'], [-1, 9, 'plate.top'], [2, 8, 'plate.hole']] as const) {
    await page.mouse.click(screen(x, y).x, screen(x, y).y);
    await expect.poll(() => page.evaluate(() => window.fem.registry.query({ query: 'query.selection' }))).toMatchObject({ faces: [name], bodies: ['plate'] });
    await expect(page.locator('.probe')).toContainText(name);
  }
  await page.evaluate(() => window.fem.dispatch({ cmd: 'selection.clear' }));
  await page.mouse.click(screen(2, 9).x, screen(2, 9).y);
  await expect.poll(() => page.evaluate(() => window.fem.registry.query({ query: 'query.selection' }))).toMatchObject({ refs: [] });
  await expect(page.locator('.probe')).toHaveText('');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'view.setVisible', bodies: ['plate'], on: false }));
  await page.mouse.click(outer.x, outer.y);
  await expect.poll(() => page.evaluate(() => window.fem.registry.query({ query: 'query.selection' }))).toMatchObject({ refs: [] });
  await page.evaluate(async () => {
    await window.fem.dispatch({ cmd: 'view.setVisible', bodies: ['plate'], on: true });
    await window.fem.dispatch({ cmd: 'view.setProjection', projection: 'perspective' });
    await window.fem.dispatch({ cmd: 'view.setCamera', position: [2, 9, 40], target: [2, 9, 0], up: [0, 1, 0] });
  });
  const perspectivePixelsPerMetre = rect.height / (80 * Math.tan(19 * Math.PI / 180));
  // Four pixels away still picks at this much wider view; tolerance is screen-sized.
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2 - 2 * perspectivePixelsPerMetre - 4);
  await expect.poll(() => page.evaluate(() => window.fem.registry.query({ query: 'query.selection' }))).toMatchObject({ faces: ['plate.right'], bodies: ['plate'] });
  const journal = await page.evaluate(() => window.fem.query.journal()) ;
  expect(journal.entries.map(e => e.cmd)).toEqual(commands);
});
