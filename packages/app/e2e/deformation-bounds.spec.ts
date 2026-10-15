import { expect, test } from '@playwright/test';

test('@cpu displaced triangles remain pickable outside their original bounds', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined');
  const displacement = await page.evaluate(async () => {
    await window.fem.model.new({ name: 'deformation-bounds' });
    await window.fem.geometry.addBox({ name: 'beam', size: ['1 m', '0.1 m', '0.1 m'] });
    await window.fem.material.add({ name: 'steel', E: '210 GPa', nu: 0.3 });
    await window.fem.material.assign({ material: 'steel', bodies: ['beam'] });
    await window.fem.mesh.set({ mesher: { kind: 'lattice', size: { nx: 4, ny: 1, nz: 1 } }, order: 1 });
    await window.fem.constraint.fix({ name: 'root', on: 'beam.xmin' });
    await window.fem.load.traction({ name: 'tip', on: 'beam.xmax', total: ['0 N', '0 N', '-1 kN'] });
    await window.fem.step.add({ name: 'static', procedure: 'static', constraints: ['root'], loads: ['tip'] });
    await window.fem.solve.run({ step: 'static' });
    await window.fem.dispatch({ cmd: 'view.setDeformScale', scale: 0 });
    await window.fem.dispatch({ cmd: 'view.setProjection', projection: 'orthographic' });
    await window.fem.dispatch({ cmd: 'view.setCamera', position: [0.5, -3, 0.05], target: [0.5, 0.05, 0.05], up: [0, 0, 1] });
    for (const layer of ['edges', 'grid', 'axes']) await window.fem.dispatch({ cmd: 'view.toggle', layer, on: false });
    const u: number[] = [];
    for (const component of [0, 1, 2]) {
      const probe = await window.fem.query.probe({ field: 'displacement', component, at: ['0.9 m', '0 m', '0.05 m'] });
      u.push(probe.value.value);
    }
    return u;
  });
  const rect = (await page.locator('.viewer canvas').boundingBox())!;
  const pixelsPerMetre = rect.height / (2 * Math.sqrt(1.02) * 0.7);
  const screen = (x: number, z: number, targetZ = 0.05) => ({ x: rect.x + rect.width / 2 + (x - 0.5) * pixelsPerMetre, y: rect.y + rect.height / 2 - (z - targetZ) * pixelsPerMetre });
  // Prime renderer and raycaster bounds before moving anything.
  const original = screen(0.9, 0.05);
  await page.mouse.click(original.x, original.y);
  await expect(page.locator('.probe')).toContainText(/node \d+/);
  const scale = 0.6 / Math.abs(displacement[2]!);
  expect(Number.isFinite(scale)).toBe(true);
  for (const factor of [1, 0.5, 1]) {
    await page.evaluate(scale => window.fem.dispatch({ cmd: 'view.setDeformScale', scale }), scale * factor);
    // Camera framing must still use the original extent, not the exaggerated bounds.
    await page.evaluate(() => window.fem.dispatch({ cmd: 'view.setCamera', position: [0.5, -3, -0.2], target: [0.5, 0.05, -0.2], up: [0, 0, 1] }));
    const moved = screen(0.9 + scale * factor * displacement[0]!, 0.05 + scale * factor * displacement[2]!, -0.2);
    await page.mouse.click(moved.x, moved.y);
    await expect(page.locator('.probe')).toContainText(/node \d+/);
    await expect.poll(() => page.evaluate(() => window.fem.registry.query({ query: 'query.selection' }))).toMatchObject({ faces: ['beam.ymin'], bodies: ['beam'] });
    await page.evaluate(() => window.fem.dispatch({ cmd: 'selection.clear' }));
  }
  await page.evaluate(async scale => {
    await window.fem.dispatch({ cmd: 'view.setVisible', bodies: ['beam'], on: false });
    await window.fem.dispatch({ cmd: 'view.setVisible', bodies: ['beam'], on: true });
    await window.fem.dispatch({ cmd: 'view.setDeformScale', scale });
  }, scale);
  // Freeze animation timing, then sample both signs of the displacement wave.
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
  await page.evaluate(() => window.fem.dispatch({ cmd: 'view.animate', step: 'static', playing: true }));
  for (const [milliseconds, sign] of [[250, 1], [500, -1]]) {
    await page.clock.runFor(milliseconds!);
    const targetZ = sign === 1 ? -0.2 : 0.3;
    await page.evaluate(z => window.fem.dispatch({ cmd: 'view.setCamera', position: [0.5, -3, z], target: [0.5, 0.05, z], up: [0, 0, 1] }), targetZ);
    const moved = screen(0.9 + sign! * scale * displacement[0]!, 0.05 + sign! * scale * displacement[2]!, targetZ);
    await page.mouse.click(moved.x, moved.y);
    await expect(page.locator('.probe')).toContainText(/node \d+/);
    await expect.poll(() => page.evaluate(() => window.fem.registry.query({ query: 'query.selection' }))).toMatchObject({ faces: ['beam.ymin'], bodies: ['beam'] });
    await page.evaluate(() => window.fem.dispatch({ cmd: 'selection.clear' }));
  }
  await page.evaluate(() => window.fem.dispatch({ cmd: 'view.animate', step: 'static', playing: false }));
});
