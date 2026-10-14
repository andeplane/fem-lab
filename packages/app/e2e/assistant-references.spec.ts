import { parseMentions } from '@femlab/registry';
import { expect, test } from './fixtures';

test('@cpu tree references open the Assistant on first use and after collapse', async ({ page }) => {
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined');
  await page.evaluate(async () => {
    await window.fem.dispatch({ cmd: 'project.new', name: 'references' });
    await window.fem.geometry.addBox({ name: 'beam', size: ['1 m', '100 mm', '100 mm'] });
    await window.fem.material.add({ name: 'steel', E: '210 GPa', nu: 0.3 });
  });
  const drawer = page.locator('.assistant');
  await expect(drawer).toHaveCount(0);
  const reference = page.locator('#tree-geometry-items .row').filter({ has: page.locator('.name', { hasText: /^beam$/ }) }).locator('[data-cmd="chat.insertMention"]');
  await reference.click();
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('.tokens .token')).toContainText('@body:beam');
  await expect(drawer.locator('textarea')).toBeFocused();

  await page.evaluate(() => window.fem.dispatch({ cmd: 'panel.toggle', panel: 'assistant', open: false }));
  await expect(drawer).toBeHidden();
  await reference.click();
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('.tokens .token')).toHaveCount(1);
  await expect(drawer.locator('textarea')).toBeFocused();

  // The callable host Command must retain the same behavior as its UI controls.
  await page.evaluate(() => window.fem.dispatch({ cmd: 'panel.toggle', panel: 'assistant', open: false }));
  await expect(drawer).toBeHidden();
  await page.evaluate(() => window.fem.dispatch({ cmd: 'chat.insertMention', ref: 'material:steel' }));
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('.tokens .token')).toHaveCount(2);
  await expect(drawer.locator('.tokens')).toContainText('@material:steel');
  await expect(drawer.locator('textarea')).toBeFocused();
});

test('@cpu Mesh and Result references resolve engine context and retain the clicked solve identity', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1720, height: 1000 });
  await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined');
  const before = await page.evaluate(async () => {
    await window.fem.dispatch({ cmd: 'example.open', name: 'cantilever-modal' });
    return { result: await window.fem.query.result(), mesh: await window.fem.query.mesh(), model: await window.fem.query.model() };
  });
  const drawer = page.locator('.assistant');
  await expect(drawer).toHaveCount(0);
  await page.locator('#tree-mesh-items [data-cmd="chat.insertMention"]').click();
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('textarea')).toBeFocused();
  const meshToken = drawer.locator('.tokens [data-ref="mesh:mesh"]');
  await expect(meshToken).toHaveCount(1);
  expect(parseMentions(`@${await meshToken.getAttribute('data-ref')}`).chips).toEqual([{ ref: 'mesh:mesh', kind: 'mesh', name: 'mesh' }]);
  const mesh = await page.evaluate(() => window.fem.query.mesh());
  expect(mesh.nodes).toBeGreaterThan(0);
  expect(mesh.elements).toBeGreaterThan(0);
  expect(mesh).toEqual(before.mesh);
  expect(before.model.meshSettings).not.toBeNull();

  await page.evaluate(() => window.fem.dispatch({ cmd: 'panel.toggle', panel: 'assistant', open: false }));
  await expect(drawer).toBeHidden();
  const mode = page.locator('#tree-results-items .row').filter({ has: page.locator('.name', { hasText: /^mode 2$/ }) });
  await mode.locator('[data-cmd="chat.insertMention"]').click();
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('textarea')).toBeFocused();
  const resultToken = drawer.locator('.tokens [data-ref^="result:"]');
  await expect(resultToken).toHaveCount(1);
  await expect(resultToken).toContainText(before.result.step);
  const chips = parseMentions(`@${await resultToken.getAttribute('data-ref')}`).chips;
  expect(chips).toEqual([{ ref: `result:id:${before.result.resultId}`, kind: 'result', name: `id:${before.result.resultId}` }]);
  const clicked = await page.evaluate((id) => window.fem.query.result({ resultId: id }), chips[0]!.name.slice('id:'.length));
  expect(clicked.resultId).toBe(before.result.resultId);
  expect(clicked.step).toBe(before.result.step);
  expect(clicked.revision).toBe(before.result.revision);

  // A later solve of the same Step must not redirect the chip to its replacement Result.
  const latest = await page.evaluate(async (step) => {
    await window.fem.solve.run({ step, solver: 'cpu-direct' });
    return window.fem.query.result({ step });
  }, before.result.step);
  expect(latest.resultId).not.toBe(before.result.resultId);
  const retainedChips = parseMentions(`@${await resultToken.getAttribute('data-ref')}`).chips;
  expect(retainedChips).toEqual(chips);
  const retained = await page.evaluate((id) => window.fem.query.result({ resultId: id }), retainedChips[0]!.name.slice('id:'.length));
  expect(retained.resultId).toBe(before.result.resultId);
  expect(retained.revision).toBe(before.result.revision);
  await expect(page.locator('.error-card')).toHaveCount(0);
});
