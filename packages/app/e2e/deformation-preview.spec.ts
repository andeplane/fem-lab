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
    const dispatch = window.fem.registry.dispatch.bind(window.fem.registry);
    (window as unknown as { scaleCommands: unknown[] }).scaleCommands = [];
    window.fem.registry.dispatch = async (command) => {
      if (command.cmd === 'view.setDeformScale') (window as unknown as { scaleCommands: unknown[] }).scaleCommands.push(command);
      return dispatch(command);
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
  await expect(page.locator('.legend-sub')).toContainText(`×${scale}`);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as unknown as { scaleCommands: unknown[] }).scaleCommands)).toEqual([{ cmd: 'view.setDeformScale', scale }]);
  expect(await page.evaluate(() => window.fem.query.journal())).toEqual(journal);
  expect((await page.evaluate(() => window.fem.query.result({}))).stale).toBe(false);
  // One Command per keypress, a step down. The step is read off the slider rather than assumed:
  // the track grows with the drawn scale (#42), so it is not always 10.
  const stepSize = Number(await slider.getAttribute('step'));
  await slider.press('ArrowLeft');
  await expect.poll(() => page.evaluate(() => (window as unknown as { scaleCommands: unknown[] }).scaleCommands)).toEqual([
    { cmd: 'view.setDeformScale', scale },
    { cmd: 'view.setDeformScale', scale: scale - stepSize },
  ]);
});
