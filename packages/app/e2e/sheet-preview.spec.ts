import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const commands = JSON.parse(readFileSync(path.join(import.meta.dirname, '../../../crates/engine/tests/fixtures/sheet-preview.json'), 'utf8'));
const meshCommands = JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures/sheet-static.json'), 'utf8'));

async function selected(page: Page, x: number, y: number, face: string, showsFace = true): Promise<void> {
  await page.evaluate(() => window.fem.dispatch({ cmd: 'selection.clear' }));
  await page.mouse.click(x, y);
  await expect.poll(() => page.evaluate(() => window.fem.registry.query({ query: 'query.selection' }))).toMatchObject({ faces: [face], bodies: ['plate'] });
  if (showsFace) await expect(page.locator('.probe')).toContainText(face);
  await expect(page.locator('.probe')).toContainText(/node \d+/);
}

async function selectedNear(page: Page, x: number, y: number, face: string): Promise<{ x: number; y: number }> {
  for (const dy of [0, -4, 4, -8, 8, -12, 12]) {
    await page.evaluate(() => window.fem.dispatch({ cmd: 'selection.clear' }));
    await page.mouse.click(x, y + dy);
    await page.waitForFunction(
      async face => ((await window.fem.registry.query({ query: 'query.selection' })) as { faces: string[] }).faces.includes(face),
      face,
      { timeout: 300 },
    ).catch(() => undefined);
    const selection = (await page.evaluate(() => window.fem.registry.query({ query: 'query.selection' }))) as { faces: string[]; bodies: string[] };
    if (selection.faces.includes(face)) {
      expect(selection.bodies).toContain('plate');
      await expect(page.locator('.probe')).toContainText(/node \d+/);
      return { x, y: y + dy };
    }
  }
  throw new Error(`could not pick ${face} near the displaced boundary`);
}

test('@cpu unmeshed transformed Sheet outlines are visible and named outer/hole edges are pickable', async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
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
  // Hiding the edge layer must survive rebuilding a previously hidden Body and its mode.
  await page.evaluate(async () => {
    await window.fem.dispatch({ cmd: 'view.toggle', layer: 'edges', on: false });
    await window.fem.dispatch({ cmd: 'view.setVisible', bodies: ['plate'], on: true });
    await window.fem.dispatch({ cmd: 'view.setMode', mode: 'mesh' });
  });
  await page.mouse.click(outer.x, outer.y);
  await expect.poll(() => page.evaluate(() => window.fem.registry.query({ query: 'query.selection' }))).toMatchObject({ refs: [] });
  await page.evaluate(() => window.fem.dispatch({ cmd: 'view.toggle', layer: 'edges' }));
  await page.mouse.click(outer.x, outer.y);
  await expect.poll(() => page.evaluate(() => window.fem.registry.query({ query: 'query.selection' }))).toMatchObject({ faces: ['plate.right'] });
  await page.evaluate(() => window.fem.dispatch({ cmd: 'selection.clear' }));
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

test('@cpu meshed Sheet boundaries survive order, visibility and Results transitions', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
  await page.evaluate(async (fixture) => {
    for (const cmd of fixture) await window.fem.dispatch(cmd);
    await window.fem.dispatch({ cmd: 'view.setMode', mode: 'mesh' });
    await window.fem.dispatch({ cmd: 'view.setProjection', projection: 'orthographic' });
    await window.fem.dispatch({ cmd: 'view.setCamera', position: [2, 9, 20], target: [2, 9, 0], up: [0, 1, 0] });
    await window.fem.dispatch({ cmd: 'view.toggle', layer: 'grid', on: false });
    await window.fem.dispatch({ cmd: 'view.toggle', layer: 'axes', on: false });
  }, meshCommands);

  const canvas = page.locator('canvas').first();
  const rect = (await canvas.boundingBox())!;
  const pixelsPerMetre = rect.height / (2 * Math.sqrt(52) * 0.7);
  const screen = (x: number, y: number) => ({ x: rect.x + rect.width / 2 + (x - 2) * pixelsPerMetre, y: rect.y + rect.height / 2 - (y - 9) * pixelsPerMetre });
  const outer = screen(2, 11);
  const hole = screen(2, 8);
  const interior = screen(4.25, 9);

  await selected(page, outer.x, outer.y, 'plate.right');
  await selected(page, hole.x, hole.y, 'plate.hole');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'selection.clear' }));
  await page.mouse.click(interior.x, interior.y);
  await expect.poll(() => page.evaluate(() => window.fem.registry.query({ query: 'query.selection' }))).toMatchObject({ refs: [] });
  await expect(page.locator('.probe')).toContainText(/plate · node \d+/);

  await page.evaluate(() => window.fem.mesh.set({ mesher: { kind: 'free', of: 'plate', size: '0.5 m' }, order: 2 }));
  await selected(page, outer.x, outer.y, 'plate.right');
  await selected(page, hole.x, hole.y, 'plate.hole');

  await page.evaluate(async () => {
    await window.fem.solve.run({ step: 'static' });
    await window.fem.dispatch({ cmd: 'view.setDeformScale', scale: 0 });
  });
  await expect(page.locator('button[data-cmd="view.setMode"][aria-pressed="true"]')).toHaveText('results');
  // This first hit makes three.js cache the undeformed outline bounds. Moving the boundary
  // outside those bounds must refresh both culling and raycast caches.
  await selected(page, hole.x, hole.y, 'plate.hole', false);
  const [ux, uy] = await page.evaluate(async () => {
    const component = async (n: number) => {
      const p = (await window.fem.query.probe({ field: 'displacement', component: n, at: ['2 m', '11 m', '0 m'] })) as unknown as {
        value: { value: number; unit: string };
      };
      const si = (await window.fem.query.convert({ quantity: `${p.value.value} ${p.value.unit}`, to: 'm' })) as unknown as { value: number };
      return si.value;
    };
    return [await component(0), await component(1)];
  });
  const scale = -1_050_000;
  const moved = screen(2 + scale * ux, 11 + scale * uy);
  await page.evaluate(scale => window.fem.dispatch({ cmd: 'view.setDeformScale', scale }), scale);
  const pickedMoved = await selectedNear(page, moved.x, moved.y, 'plate.right');
  await expect(page.locator('.probe')).not.toContainText('plate.right');

  await page.evaluate(() => window.fem.dispatch({ cmd: 'view.setMode', mode: 'mesh' }));
  await selected(page, pickedMoved.x, pickedMoved.y, 'plate.right', false);
  await page.evaluate(async () => {
    await window.fem.dispatch({ cmd: 'selection.clear' });
    await window.fem.dispatch({ cmd: 'view.setVisible', bodies: ['plate'], on: false });
  });
  await page.mouse.click(pickedMoved.x, pickedMoved.y);
  await expect.poll(() => page.evaluate(() => window.fem.registry.query({ query: 'query.selection' }))).toMatchObject({ refs: [] });
  await expect(page.locator('.probe')).toHaveText('');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'view.setVisible', bodies: ['plate'], on: true }));
  await selected(page, pickedMoved.x, pickedMoved.y, 'plate.right', false);
  await page.evaluate(async () => {
    await window.fem.dispatch({ cmd: 'view.setMode', mode: 'results' });
    await window.fem.dispatch({ cmd: 'view.setDeformScale', scale: 0 });
  });
  await page.evaluate(() => window.fem.dispatch({ cmd: 'selection.clear' }));
  await page.mouse.click(interior.x, interior.y);
  await expect.poll(() => page.evaluate(() => window.fem.registry.query({ query: 'query.selection' }))).toMatchObject({ refs: [] });
  await expect(page.locator('.probe')).toContainText(/node \d+/);
  await expect(page.locator('.probe')).not.toContainText('plate ·');
  expect(errors).toEqual([]);
});
