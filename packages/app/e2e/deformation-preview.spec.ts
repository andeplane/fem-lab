import { expect, test } from './fixtures';

test('@cpu deformation previews while dragging and commits once on release', async ({ page }) => {
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'file.openExample', name: 'cantilever' }));
  const slider = page.getByRole('slider', { name: 'exaggeration', exact: true });
  await expect(slider).toBeVisible();
  await page.evaluate(() => window.fem.dispatch({ cmd: 'view.setDeformScale', scale: 100 }));
  const journal = await page.evaluate(() => window.fem.query.journal());
  const before = await page.evaluate(() => window.fem.registry.query({ query: 'query.screenshot', legend: false }));
  await page.evaluate(() => {
    const registry = Object.getPrototypeOf(window.fem.registry) as typeof window.fem.registry;
    const dispatch = registry.dispatch;
    (window as unknown as { scaleCommands: unknown[] }).scaleCommands = [];
    registry.dispatch = async function (command) {
      if (command.cmd === 'view.setDeformScale') (window as unknown as { scaleCommands: unknown[] }).scaleCommands.push(command);
      return dispatch.call(this, command);
    };
  });
  const box = (await slider.boundingBox())!;
  await page.mouse.move(box.x + box.width / 4, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2, { steps: 6 });
  const scale = Number(await slider.inputValue());
  expect(scale).toBeGreaterThan(200);
  expect(await page.evaluate(() => (window as unknown as { scaleCommands: unknown[] }).scaleCommands)).toEqual([]);
  const during = await page.evaluate(() => window.fem.registry.query({ query: 'query.screenshot', legend: false }));
  expect(during).not.toEqual(before);
  // The legend displays four significant figures; the native range keeps the full value.
  const shown = Number(/×([\d.e+-]+)/.exec((await page.locator('.legend-sub').textContent())!)![1]);
  expect(shown).toBeCloseTo(scale, 1);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as unknown as { scaleCommands: unknown[] }).scaleCommands)).toEqual([{ cmd: 'view.setDeformScale', scale }]);
  expect(await page.evaluate(() => window.fem.query.journal())).toEqual(journal);
  expect((await page.evaluate(() => window.fem.query.result({}))).stale).toBe(false);
  // One Command per native keypress, matching the acknowledged range value. Chromium chooses
  // the keyboard increment when any numeric scale is representable on the track.
  await slider.press('ArrowLeft');
  const afterKey = Number(await slider.inputValue());
  expect(afterKey).toBeLessThan(scale);
  await expect.poll(() => page.evaluate(() => (window as unknown as { scaleCommands: unknown[] }).scaleCommands)).toEqual([
    { cmd: 'view.setDeformScale', scale },
    { cmd: 'view.setDeformScale', scale: afterKey },
  ]);
});
