import { expect, test } from './fixtures';

test.describe('@cpu uncommitted geometry drafts', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
    await page.goto('./');
    await page.waitForFunction(() => typeof window.fem !== 'undefined');
    await page.evaluate(() => window.fem.model.new({ name: 'draft-browser-proof' }));
  });
  test('shows a movable dashed draft, preserves camera and commits exactly once', async ({ page }, testInfo) => {
    const before = await page.evaluate(() => window.fem.query.document());
    const camera = await page.evaluate(() => window.fem.registry.query({ query: 'query.view' }));
    await page.evaluate(() => window.fem.dispatch({ cmd: 'form.open', command: 'geometry.addBox', args: { name: 'placed', size: ['1 m', '100 mm', '100 mm'] } }));
    await expect(page.getByText('Draft · not added', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.fem.query.document())).toEqual(before);
    expect(await page.evaluate(() => window.fem.registry.query({ query: 'query.view' }))).toEqual(camera);
    await page.evaluate(() => window.fem.dispatch({ cmd: 'view.fit' }));
    const fitted = await page.evaluate(() => window.fem.registry.query({ query: 'query.view' }));
    const image = await page.locator('.viewer canvas').evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL());
    await page.locator('[data-field="at"] input').first().fill('2 m');
    await expect(page.getByText('Draft · not added', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.fem.registry.query({ query: 'query.view' }))).toEqual(fitted);
    expect(await page.evaluate(() => window.fem.query.document())).toEqual(before);
    await page.evaluate(() => window.fem.dispatch({ cmd: 'view.fit' }));
    expect(await page.locator('.viewer canvas').evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL())).not.toBe(image);
    await page.screenshot({ path: testInfo.outputPath('placed-dashed-draft.png') });
    await page.getByRole('button', { name: 'Add body', exact: true }).click();
    await expect(page.getByText('Draft · not added', { exact: true })).toHaveCount(0);
    await expect.poll(() => page.evaluate(async () => (await window.fem.query.model()).bodies.length)).toBe(1);
    const journal = await page.evaluate(() => window.fem.query.journal());
    expect(journal.entries).toHaveLength(before.file.journal.entries.length + 1);
    expect(journal.entries.at(-1)?.cmd).toMatchObject({ cmd: 'geometry.addBox', name: 'placed', at: ['2 m', '0 m', '0 m'] });
  });
  test('clears invalid or cancelled drafts and leaves a new Model empty', async ({ page }) => {
    const journal = await page.evaluate(() => window.fem.query.journal());
    await page.evaluate(() => window.fem.dispatch({ cmd: 'form.open', command: 'geometry.add', args: { name: 'round', shape: { kind: 'cylinder', radius: '200 mm', height: '1 m' } } }));
    await expect(page.getByText('Draft · not added', { exact: true })).toBeVisible();
    await page.locator('[data-field="shape.radius"] input').fill('20 s');
    await expect(page.getByText('Draft unavailable', { exact: true })).toBeVisible();
    await expect(page.locator('.geometry-draft-note')).toContainText('unit.dimension');
    expect(await page.evaluate(() => window.fem.query.journal())).toEqual(journal);
    await page.locator('[data-field="shape.radius"] input').fill('250 mm');
    await expect(page.getByText('Draft · not added', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel draft', exact: true }).click();
    await expect(page.locator('.geometry-draft-note')).toHaveCount(0);
    expect(await page.evaluate(() => window.fem.query.journal())).toEqual(journal);
    await page.evaluate(() => window.fem.model.new({ name: 'clean-next-model' }));
    await expect.poll(() => page.evaluate(async () => (await window.fem.query.model()).bodies.length)).toBe(0);
  });
});

test('@cpu first workspace entry through geometry never invents a starter draft over the committed body', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('femlab.tour.dismissed', '1'); localStorage.setItem('femlab.autosave', 'off'); });
  await page.goto('./');
  await page.waitForFunction(() => Boolean(window.fem));
  await page.evaluate(() => window.fem.geometry.addBox({ name: 'first-body', size: ['1 mm', '2 mm', '3 mm'] }));
  await expect(page.locator('.shell')).toBeVisible();
  // Let Preact's after-paint startup effect run before asserting its absence of work.
  await page.evaluate(async () => { for (let i = 0; i < 2; i++) await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0))); });
  await expect(page.locator('.props .panel-sub')).toHaveCount(0);
  await expect(page.locator('.geometry-draft-note')).toHaveCount(0);
  const journal = await page.evaluate(() => window.fem.query.journal());
  expect(journal.entries).toHaveLength(1);
  expect((await page.evaluate(() => window.fem.query.model())).bodies.map(body => body.name)).toEqual(['first-body']);
  // A deliberate form.open remains available after that first committed Body.
  await page.evaluate(() => window.fem.dispatch({ cmd: 'form.open', command: 'geometry.addBox', args: { name: 'second-body', size: ['2 mm', '2 mm', '2 mm'] } }));
  await expect(page.getByText('Draft · not added', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.fem.query.journal())).toEqual(journal);
});
