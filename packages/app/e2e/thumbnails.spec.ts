// CI builds the app once, then this supported-Chromium pass generates every gallery image from
// the real viewer. It replays the real Model and Mesh Commands but omits solves, so a thumbnail
// never presents invented result contours as physics.
import { expect, test } from './fixtures';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const journalsDir = path.join(root, 'crates/engine/benches/journals');
const thumbnailsDir = path.join(root, 'packages/app/public/examples/thumbnails');
const names = readdirSync(journalsDir)
  .filter((name) => name.endsWith('.json') && !name.endsWith('.meta.json'))
  .map((name) => name.slice(0, -'.json'.length))
  .sort();

test('@thumbnails render every example through the viewer', async ({ page }, info) => {
  test.setTimeout(240_000);
  rmSync(thumbnailsDir, { recursive: true, force: true });
  mkdirSync(thumbnailsDir, { recursive: true });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });

  for (const name of names) {
    const entries = JSON.parse(readFileSync(path.join(journalsDir, `${name}.json`), 'utf8')) as { cmd: { cmd: string } & Record<string, unknown> }[];
    const commands = entries.map((entry) => entry.cmd).filter((cmd) => cmd.cmd !== 'solve.run' && cmd.cmd !== 'study.converge');
    await page.evaluate(async (input) => {
      for (const cmd of input) await window.fem.dispatch(cmd);
      await window.fem.dispatch({ cmd: 'view.setMode', mode: 'geometry' });
      await window.fem.dispatch({ cmd: 'view.setProjection', projection: 'orthographic' });
      await window.fem.dispatch({ cmd: 'view.toggle', layer: 'grid', on: false });
      await window.fem.dispatch({ cmd: 'view.toggle', layer: 'axes', on: false });
      const canvas = document.querySelector<HTMLCanvasElement>('.viewer canvas')!;
      Object.assign(canvas.style, { width: '320px', height: '180px' });
      for (const overlay of document.querySelectorAll<HTMLElement>('.viewer > :not(canvas)')) overlay.style.display = 'none';
      // The app's ResizeObserver watches the canvas' parent, not the canvas, so styling the
      // canvas alone never reaches Viewer.resize and the drawing buffer keeps its old size.
      // The app also listens for window resize, which is the honest way to ask for one.
      window.dispatchEvent(new Event('resize'));
    }, commands);
    await page.waitForFunction(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('.viewer canvas');
      return canvas?.clientWidth === 320 && canvas.clientHeight === 180 && canvas.width === 320 && canvas.height === 180;
    });
    await page.evaluate(async () => {
      await window.fem.dispatch({ cmd: 'view.preset', view: 'iso' });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    const png = await page.locator('.viewer canvas').screenshot({ path: path.join(thumbnailsDir, `${name}.png`) });
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(320);
    expect(png.readUInt32BE(20)).toBe(180);
    const visibility = await page.locator('.viewer canvas').evaluate(element => {
      const canvas = element as HTMLCanvasElement, gl = canvas.getContext('webgl2')!;
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const measure = (bytes: Uint8Array | Uint8ClampedArray) => {
        let count = 0, minX = canvas.width, maxX = -1, minY = canvas.height, maxY = -1;
        for (let i = 0; i < bytes.length; i += 4) {
          // Grid and axes are disabled. Dark background/edges cannot pass as a visible Body.
          if (Math.max(bytes[i]!, bytes[i + 1]!, bytes[i + 2]!) <= 65) continue;
          const x = i / 4 % canvas.width, y = Math.floor(i / 4 / canvas.width);
          count++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
        return { count, minX, maxX, minY, maxY };
      };
      const blank = document.createElement('canvas'); blank.width = canvas.width; blank.height = canvas.height;
      const context = blank.getContext('2d')!; context.fillStyle = '#0d0f13'; context.fillRect(0, 0, blank.width, blank.height);
      return { body: measure(pixels), blank: measure(context.getImageData(0, 0, blank.width, blank.height).data) };
    });
    await info.attach(`${name}-visibility`, { body: JSON.stringify({ pngBytes: png.length, ...visibility }), contentType: 'application/json' });
    // PNG compression is unrelated to visibility (#624). A correctly framed thin column can
    // compress below 1 kB; a real blank image must fail the same physical-pixel criterion.
    expect(visibility.blank.count).toBe(0);
    expect(visibility.body.count).toBeGreaterThan(100);
    expect(visibility.body.maxX - visibility.body.minX).toBeGreaterThan(4);
    expect(visibility.body.maxY - visibility.body.minY).toBeGreaterThan(4);
    expect(visibility.body.minX).toBeGreaterThan(0); expect(visibility.body.maxX).toBeLessThan(319);
    expect(visibility.body.minY).toBeGreaterThan(0); expect(visibility.body.maxY).toBeLessThan(179);
  }

  expect(readdirSync(thumbnailsDir).sort()).toEqual(names.map((name) => `${name}.png`).sort());
});
