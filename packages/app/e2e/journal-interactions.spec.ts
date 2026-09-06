// Design brief §5.5: a Journal row selects its still-live object, keyboard focus and hover
// highlight it, and these host-only interactions leave the Journal byte-for-byte unchanged.
import { expect, test, type Page } from './fixtures';

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
  await page.waitForFunction(async () => Boolean(await window.fem.query.capabilities()), undefined, { timeout: 60_000 });
}

test.describe('@cpu Journal object interactions', () => {
  test('pointer and keyboard select/highlight live targets without changing the Journal', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
    await page.goto('./');
    await ready(page);
    await page.evaluate(async () => {
      await window.fem.model.new({ name: 'journal-interactions' });
      await window.fem.geometry.addBox({ name: 'beam', size: ['1 m', '100 mm', '100 mm'] });
      await window.fem.geometry.nameFace({ name: 'bearing', of: 'beam', where: { kind: 'normal', normal: [0, 0, 1] } });
      await window.fem.geometry.nameFace({ name: 'bearing_alias', of: 'beam', where: { kind: 'normal', normal: [0, 0, 1] } });
      await window.fem.mesh.set({ mesher: { kind: 'lattice', size: '50 mm' }, order: 1 });
      await window.fem.load.pressure({ name: 'cap', on: 'bearing', value: '2 MPa' });
      // This post-mesh edit forces the surface to rebuild; the named predicates must be
      // resolved again rather than surviving only in the first surface response.
      await window.fem.geometry.addBox({ name: 'deleted', size: ['100 mm', '100 mm', '100 mm'], at: ['2 m', '0 m', '0 m'] });
      await window.fem.geometry.remove({ name: 'deleted' });
    });

    const canvas = page.locator('.viewer canvas');
    await expect(canvas).toBeVisible();
    await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>('.viewer canvas')!.toDataURL().length > 1_000);
    const beforeJournal = await page.evaluate(() => window.fem.query.journal());
    const beam = page.locator('.jrow[data-target-ref="body:beam"]');
    const select = beam.locator('.jrow-main');
    await expect(select).toHaveAttribute('data-cmd', 'selection.set');

    const base = await canvas.screenshot();
    await beam.hover();
    await expect(beam.locator('.jcopy')).toHaveCSS('opacity', '1');
    const hovered = await canvas.screenshot();
    expect(hovered.equals(base)).toBe(false);

    await page.locator('.topbar').hover();
    const cleared = await canvas.screenshot();
    expect(cleared.equals(base)).toBe(true);

    await select.focus();
    const focused = await canvas.screenshot();
    expect(focused.equals(base)).toBe(false);
    await select.press('Enter');
    await beam.locator('.jcopy').focus();
    await expect.poll(async () => (await page.evaluate(() => window.fem.registry.query({ query: 'query.selection' })) as { refs: string[] }).refs).toEqual(['body:beam']);
    const selected = await canvas.screenshot();
    expect(selected.equals(base)).toBe(false);

    await page.evaluate(() => window.fem.registry.dispatch({ cmd: 'selection.clear' }));
    await expect.poll(async () => (await canvas.screenshot()).equals(base)).toBe(true);
    const namedSet = page.locator('.jrow[data-target-ref="set:bearing"]');
    await namedSet.hover();
    const namedHighlight = await canvas.screenshot();
    expect(namedHighlight.equals(base)).toBe(false);
    await page.locator('.topbar').hover();
    expect((await canvas.screenshot()).equals(base)).toBe(true);
    await page.locator('.jrow[data-target-ref="set:bearing_alias"]').hover();
    expect((await canvas.screenshot()).equals(namedHighlight)).toBe(true);
    await page.locator('.topbar').hover();

    const load = page.locator('.jrow[data-target-ref="load:cap"]');
    await load.locator('.jrow-main').focus();
    expect((await canvas.screenshot()).equals(base)).toBe(false);
    await load.locator('.jrow-main').press('Enter');
    await expect
      .poll(async () => await page.evaluate(() => window.fem.registry.query({ query: 'query.selection' })))
      .toMatchObject({ refs: ['load:cap'], bodies: [], faces: [], sets: [] });
    await expect(page.locator('.props .panel-sub')).toHaveText('load.pressure');

    // Removing the focused Journal from the DOM clears its transient highlight. The semantic
    // load selection remains, but it has no drawable body/face masquerading as the selection.
    await page.evaluate(() => window.fem.dispatch({ cmd: 'panel.toggle', panel: 'script', open: true }));
    await expect(page.locator('.script')).toBeVisible();
    const afterUnmount = await canvas.screenshot();
    await page.evaluate(() => window.fem.registry.dispatch({ cmd: 'view.highlight' }));
    expect((await canvas.screenshot()).equals(afterUnmount)).toBe(true);
    await page.evaluate(() => window.fem.dispatch({ cmd: 'panel.toggle', panel: 'journal', open: true }));

    const deletedAdd = page.locator('.jrow', { hasText: 'geometry.addBox' }).filter({ hasText: 'deleted' });
    const deletedRemove = page.locator('.jrow', { hasText: 'geometry.remove' }).filter({ hasText: 'deleted' });
    await expect(deletedAdd.locator('.jrow-main')).toBeDisabled();
    await expect(deletedRemove.locator('.jrow-main')).toBeDisabled();
    await expect(deletedAdd.locator('.jcopy')).toHaveAttribute('data-cmd', 'clipboard.copy');

    expect(await page.evaluate(() => window.fem.query.journal())).toEqual(beforeJournal);
  });
});
