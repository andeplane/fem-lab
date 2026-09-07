import { expect, test } from '@playwright/test';

test('@cpu public example.open and gallery alias replay the same Journal and preserve dirty failures', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
  await page.goto('./');
  await page.waitForFunction(async () => typeof window.fem !== 'undefined' && Boolean(await window.fem.query.capabilities()));
  const dirty = page.getByRole('img', { name: 'Unsaved changes' });
  const name = page.getByRole('textbox', { name: 'Model name', exact: true });
  const original = await page.evaluate(async () => {
    const project = await window.fem.dispatch({ cmd: 'project.new', name: 'keep this project' }) as { id: string };
    await window.fem.dispatch({ cmd: 'geometry.addBox', name: 'original', size: ['1 m', '2 m', '3 m'] });
    await window.fem.dispatch({ cmd: 'project.save' });
    return { id: project.id, journal: await window.fem.query.journal() };
  });
  const expected = await page.evaluate(async () => {
    const entries = await (await fetch('examples/cantilever.json')).json();
    const opened = await window.fem.dispatch({ cmd: 'example.open', name: 'cantilever' });
    return { entries, opened, journal: await window.fem.query.journal() };
  });
  expect(expected.opened).toEqual({ name: 'cantilever', commands: expected.entries.length });
  expect(expected.journal.entries).toHaveLength(expected.entries.length);
  await expect(name).toHaveValue('cantilever');
  await expect(dirty).toBeHidden();
  await page.evaluate(() => window.fem.dispatch({ cmd: 'project.save' }));
  await page.evaluate((id) => window.fem.dispatch({ cmd: 'project.open', id }), original.id);
  expect((await page.evaluate(() => window.fem.query.journal())).entries).toEqual(original.journal.entries);
  await expect(name).toHaveValue('keep this project');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'file.openExample', name: 'cantilever' }));
  expect((await page.evaluate(() => window.fem.query.journal())).entries).toEqual(expected.journal.entries);
  await expect(dirty).toBeHidden();
  await page.route('**/examples/cantilever.json', route => route.fulfill({ json: [
    { cmd: { cmd: 'model.new', name: 'partial example' } },
    { cmd: { cmd: 'material.assign', material: 'missing', bodies: ['missing'] } },
  ] }));
  const error = await page.evaluate(async () => {
    try { await window.fem.dispatch({ cmd: 'example.open', name: 'cantilever' }); return null; }
    catch (error) { return String(error); }
  });
  expect(error).not.toBeNull();
  await expect(name).toHaveValue('partial example');
  await expect(dirty).toBeVisible();
  await expect(page.locator('.theory-panel')).toHaveCount(0);
  await page.unroute('**/examples/cantilever.json');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'example.open', name: 'cantilever' }));
  await expect(dirty).toBeHidden();
});
