import { expect, test } from './fixtures';
import { readFile } from 'node:fs/promises';

test('@cpu screenshot requests render exact pixels and restore the interactive camera and canvas', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('./');
  await page.waitForFunction(async () => typeof window.fem !== 'undefined' && Boolean(await window.fem.query.capabilities()));
  await page.evaluate(async () => {
    await window.fem.model.new({ name: 'image-size' });
    await window.fem.geometry.addBox({ name: 'box', size: ['2 m', '1 m', '1 m'] });
  });
  await expect(page.locator('.viewer canvas')).toBeVisible();
  await page.evaluate(() => window.fem.dispatch({ cmd: 'view.fit' }));
  for (const projection of ['perspective', 'orthographic']) {
    const readings = await page.evaluate(async (projection) => {
      await window.fem.dispatch({ cmd: 'view.setProjection', projection });
      const canvas = document.querySelector<HTMLCanvasElement>('.viewer canvas')!;
      const original = { width: canvas.width, height: canvas.height, camera: await window.fem.registry.query({ query: 'query.view' }), journal: await window.fem.query.journal() };
      const captures = [];
      for (const options of [{ width: 960, height: 540, legend: false }, { width: 640, height: 800, legend: true, title: 'Tall image' }, { width: 500, legend: false }]) {
        const { png } = await window.fem.registry.query({ query: 'query.screenshot', ...options }) as { png: string };
        const image = new Image();
        image.src = png;
        await image.decode();
        const sample = document.createElement('canvas');
        sample.width = image.width; sample.height = image.height;
        const ctx = sample.getContext('2d')!;
        ctx.drawImage(image, 0, 0);
        const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
        const colours = new Set<number>();
        for (let i = 0; i < pixels.length; i += 4 * 101) colours.add((pixels[i]! << 16) | (pixels[i + 1]! << 8) | pixels[i + 2]!);
        captures.push({ width: image.width, height: image.height, colours: colours.size, restored: canvas.width === original.width && canvas.height === original.height });
      }
      let rejected = false;
      try { await window.fem.registry.query({ query: 'query.screenshot', width: 1000000, height: 1 }); } catch { rejected = true; }
      const originalEncode = canvas.toDataURL;
      let encodeRejected = false;
      canvas.toDataURL = () => { throw new Error('simulated PNG encoding failure'); };
      try { await window.fem.registry.query({ query: 'query.screenshot', width: 900, height: 300, legend: false }); } catch { encodeRejected = true; } finally { canvas.toDataURL = originalEncode; }
      return { original, captures, rejected, encodeRejected, final: { width: canvas.width, height: canvas.height, camera: await window.fem.registry.query({ query: 'query.view' }), journal: await window.fem.query.journal() } };
    }, projection);
    expect(readings.captures.map(({ width, height }) => [width, height])).toEqual([[960, 540], [640, 800], [500, Math.round(500 * readings.original.height / readings.original.width)]]);
    expect(readings.captures.every((capture) => capture.restored && capture.colours > 10)).toBe(true);
    expect(readings.rejected).toBe(true);
    expect(readings.encodeRejected).toBe(true);
    expect(readings.final).toEqual(readings.original);
  }

  const download = page.waitForEvent('download');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'file.export', spec: { format: 'png', width: 712, height: 456, legend: false, title: 'Exported image' } }));
  const file = await download;
  const png = await readFile((await file.path())!);
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([712, 456]);
  await page.evaluate(() => window.fem.dispatch({ cmd: 'panel.toggle', panel: 'export', open: true }));
  // The modal remains mounted across a real viewer resize; its next Command must use the new
  // content box rather than the dimensions captured when it opened.
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect.poll(() => page.locator('.viewer canvas').evaluate((canvas) => canvas.clientWidth)).toBeLessThan(1000);
  const dimensions = await page.locator('.viewer canvas').evaluate((canvas) => [canvas.clientWidth * 2, canvas.clientHeight * 2]);
  const row = page.locator('.export-row').filter({ has: page.locator('.ext', { hasText: '.png' }) });
  for (const button of [row.getByRole('button', { name: '2×', exact: true }), row.getByRole('button', { name: 'export', exact: true })]) {
    const nextDownload = page.waitForEvent('download');
    await button.click();
    const next = await nextDownload;
    const bytes = await readFile((await next.path())!);
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual(dimensions);
  }
});


test('@cpu animation selects the requested mode and scrubs real geometry through the registry', async ({ page }) => {
  const source = JSON.parse(await readFile(new URL('../../../crates/engine/benches/journals/cantilever-modal.json', import.meta.url), 'utf8')) as { cmd: Record<string, unknown> }[];
  const commands = source.map(({ cmd }) => cmd.cmd === 'mesh.set' ? { ...cmd, mesher: { kind: 'lattice', size: { nx: 4, ny: 1, nz: 1 } } } : cmd.cmd === 'step.add' ? { ...cmd, nModes: 2 } : cmd);
  await page.goto('./');
  await page.waitForFunction(async () => typeof window.fem !== 'undefined' && Boolean(await window.fem.query.capabilities()));
  await page.evaluate(async (commands) => { for (const cmd of commands) await window.fem.dispatch(cmd as { cmd: string }); }, commands);
  await expect(page.locator('.deform-bar')).toBeVisible();
  const original = await page.evaluate(() => window.fem.query.journal());
  const images = await page.evaluate(async () => {
    const images: string[] = [];
    for (const frame of [0, 25, 75]) {
      await window.fem.dispatch({ cmd: 'view.animate', step: 'modes', mode: 2, playing: false, speed: 0.5, frame });
      const { png } = await window.fem.registry.query({ query: 'query.screenshot', width: 600, height: 400, legend: false }) as { png: string };
      images.push(png);
    }
    return images;
  });
  expect(new Set(images).size).toBe(3);
  await expect(page.locator('.deform-bar input.phase')).toHaveValue('75');
  await expect(page.locator('.deform-bar button[data-cmd="view.animate"]')).toHaveAttribute('title', 'sweep mode 2');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'view.animate', step: 'modes', mode: 2, playing: true, speed: 2 }));
  await expect(page.locator('.deform-bar button[data-cmd="view.animate"]')).toHaveAttribute('title', 'pause');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'view.animate', step: 'modes', mode: 2, playing: false, frame: 25 }));
  expect(await page.evaluate(() => window.fem.query.journal())).toEqual(original);
  expect(await page.evaluate(async () => { try { await window.fem.dispatch({ cmd: 'view.animate', step: 'modes', mode: 99, playing: true }); return false; } catch { return true; } })).toBe(true);
  await expect(page.locator('.deform-bar input.phase')).toHaveValue('25');
  await page.evaluate(() => {
    const observed = window as unknown as { phaseCommands: unknown[] };
    observed.phaseCommands = [];
    const dispatch = window.fem.registry.dispatch.bind(window.fem.registry);
    window.fem.registry.dispatch = async (cmd) => {
      if (cmd.cmd === 'view.animate') observed.phaseCommands.push(cmd);
      return dispatch(cmd);
    };
  });
  const phase = (await page.locator('.deform-bar input.phase').boundingBox())!;
  await page.mouse.move(phase.x + phase.width * 0.25, phase.y + phase.height / 2);
  await page.mouse.down();
  await page.mouse.move(phase.x + phase.width * 0.8, phase.y + phase.height / 2, { steps: 5 });
  expect(await page.evaluate(() => (window as unknown as { phaseCommands: unknown[] }).phaseCommands.length)).toBe(0);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as unknown as { phaseCommands: unknown[] }).phaseCommands.length)).toBe(1);
  expect(await page.evaluate(() => window.fem.query.journal())).toEqual(original);

  // Native cancellation restores the acknowledged phase without a Command.
  const acknowledgedPhase = await page.locator('.deform-bar input.phase').inputValue();
  await page.evaluate(() => { (window as unknown as { phaseCommands: unknown[] }).phaseCommands = []; });
  await page.mouse.move(phase.x + phase.width * 0.2, phase.y + phase.height / 2);
  await page.mouse.down();
  await page.mouse.move(phase.x + phase.width * 0.7, phase.y + phase.height / 2, { steps: 4 });
  await page.locator('.deform-bar input.phase').dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', isPrimary: true });
  await page.mouse.up();
  await expect(page.locator('.deform-bar input.phase')).toHaveValue(acknowledgedPhase);
  expect(await page.evaluate(() => (window as unknown as { phaseCommands: unknown[] }).phaseCommands)).toEqual([]);

  // A newer mode Command invalidates the old pointer gesture. Releasing that old pointer must
  // not pause or scrub the newly selected mode.
  await page.mouse.move(phase.x + phase.width * 0.2, phase.y + phase.height / 2);
  await page.mouse.down();
  await page.mouse.move(phase.x + phase.width * 0.7, phase.y + phase.height / 2, { steps: 4 });
  await page.evaluate(() => window.fem.dispatch({ cmd: 'view.animate', step: 'modes', mode: 1, playing: true, speed: 2 }));
  await page.mouse.up();
  await expect(page.locator('.deform-bar button[data-cmd="view.animate"]')).toHaveAttribute('title', 'pause');
  expect(await page.evaluate(() => (window as unknown as { phaseCommands: unknown[] }).phaseCommands)).toEqual([
    { cmd: 'view.animate', step: 'modes', mode: 1, playing: true, speed: 2 },
  ]);
});
