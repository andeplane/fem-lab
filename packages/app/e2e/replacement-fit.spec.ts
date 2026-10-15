import type { CameraState } from '../src/viewer/viewer';
import { expect, test, type Page } from './fixtures';

const camera = (page: Page): Promise<CameraState> => page.evaluate(() => window.fem.registry.query({ query: 'query.view' })) as Promise<CameraState>;

async function expectFramed(page: Page) {
  const model = await page.evaluate(() => window.fem.query.model());
  const box = model.bodies[0]!.bbox;
  // This example displays lengths in mm; the camera coordinates are always in SI metres.
  expect(box.map(value => value.unit)).toEqual(Array(6).fill('mm'));
  const metres = box.map(value => value.value * 0.001);
  const diagonal = Math.hypot(...[0,1,2].map(axis => metres[axis + 3]! - metres[axis]!));
  await expect(page.locator('.legend')).toBeVisible();
  for (const layer of ['grid', 'axes', 'loads', 'constraints', 'sets']) await page.evaluate(layer => window.fem.dispatch({ cmd: 'view.toggle', layer, on: false }), layer);
  const journal = await page.evaluate(() => window.fem.query.journal());
  // Read the actual WebGL drawing buffer, so DOM legends and sidebar text cannot satisfy it.
  const drawing = () => page.locator('.viewer canvas').evaluate(element => {
    const canvas = element as HTMLCanvasElement;
    const bounds = canvas.getBoundingClientRect(), parent = canvas.parentElement!;
    const legend = parent.querySelector('.legend')!.getBoundingClientRect();
    const chrome = parent.querySelector('.viewer-chrome')!.getBoundingClientRect();
    const deformation = parent.querySelector('.deform-bar')?.getBoundingClientRect();
    const safe = { left: bounds.left + 12, right: legend.left - 12,
      top: chrome.bottom + 12, bottom: Math.min(bounds.bottom - 36, (deformation?.top ?? bounds.bottom) - 12) };
    const gl = canvas.getContext('webgl2')!;
    const rgba = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,rgba);
    let lo = canvas.width, hi = -1, outsideSafe = 0, count = 0;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const offset = (y * canvas.width + x) * 4;
      const channels = [rgba[offset]!, rgba[offset + 1]!, rgba[offset + 2]!];
      if (Math.max(...channels) > 45 && Math.max(...channels) - Math.min(...channels) > 32) {
        lo = Math.min(lo,x); hi = Math.max(hi,x); count++;
        const px = bounds.left + (x + 0.5) * bounds.width / canvas.width;
        const py = bounds.top + (canvas.height - y - 0.5) * bounds.height / canvas.height;
        if (px < safe.left || px > safe.right || py < safe.top || py > safe.bottom) outsideSafe++;
      }
    }
    return { coloredWidth: (hi - lo + 1) / canvas.width, outsideSafe, count, safe };
  });
  await expect.poll(async () => (await drawing()).coloredWidth).toBeGreaterThan(0.45);
  await expect.poll(async () => (await drawing()).outsideSafe).toBe(0);
  const view = await camera(page), picture = await drawing();
  // Position/target remain in SI, while the target may offset the shape clear of controls.
  expect(Math.hypot(...view.position.map((value, axis) => value - view.target[axis]!))).toBeLessThan(diagonal * 2);
  expect(picture.count).toBeGreaterThan(1000);
  expect(await page.evaluate(() => window.fem.query.journal())).toEqual(journal);
  return { camera: view, bbox: box, ...picture };
}

test('@cpu replacement fits real heat bounds once and edits/re-solves preserve the camera', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => { localStorage.setItem('femlab.tour.dismissed', '1'); localStorage.setItem('femlab.autosave', 'off'); });
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'file.openExample', name: 'bar-transient-heat' }));
  const example = await expectFramed(page);
  await page.screenshot({ path: testInfo.outputPath('heat-open-fitted.png') });
  await page.evaluate(() => window.fem.dispatch({ cmd: 'view.setCamera', position: [0.15,0.1,0.15], target: [0.05,0.0025,0.0025] }));
  const manual = await camera(page);
  await page.evaluate(() => window.fem.material.add({ name: 'slab', E: '210 GPa', nu: 0.3, rho: '7200 kg/m^3', k: '35 W/(m K)', cp: '500 J/(kg K)' }));
  expect(await camera(page)).toEqual(manual);
  await page.evaluate(() => window.fem.solve.run({ step: 'transient' }));
  expect(await camera(page)).toEqual(manual);
  const saved = await page.evaluate(() => window.fem.dispatch({ cmd: 'project.save' })) as { id: string };
  await page.evaluate(() => window.fem.dispatch({ cmd: 'project.new', name: 'replacement-fit-empty' }));
  await page.evaluate(id => window.fem.dispatch({ cmd: 'project.open', id }), saved.id);
  const project = await expectFramed(page);
  await page.screenshot({ path: testInfo.outputPath('project-open-fitted.png') });
  await testInfo.attach('rendered-bounds', { body: JSON.stringify({ example, project }, null, 2), contentType: 'application/json' });
});
