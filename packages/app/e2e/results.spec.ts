// Design states 4–7 end to end: open the cantilever example, solve it, read the Results tab
// against the Benchmark B1 number, export a VTU, edit the load and watch the Result go stale.
// The reference is `crates/engine/benches/cases/cantilever-hex8-im.json`: a tip deflection of
// 0.1919619 mm from Timoshenko, which a 25 mm lattice of incompatible-modes hexes meets to 2 %.
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const SHOTS = path.join(import.meta.dirname, 'screenshots');
const TIMOSHENKO_MM = 0.1919619;

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
  await page.waitForFunction(async () => Boolean(await window.fem.query.capabilities()), undefined, { timeout: 60_000 });
}

async function shot(page: Page, name: string): Promise<void> {
  if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
}

test.describe('@cpu solving the cantilever and reading its Result', () => {
  test.setTimeout(240_000);

  test('Solve → Results → export → stale → Re-solve', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
    await page.goto('./');
    await ready(page);

    // 1 · the example, from the gallery, exactly as a person opens it.
    await page.locator('button[data-cmd="panel.toggle"]', { hasText: 'Open an example' }).click();
    await page.locator('button[title="file.openExample cantilever"]').click();
    await expect(page.locator('.workspace')).toBeVisible();

    // 2 · the example's Journal ends on solve.run, so it opens solved: the button says so.
    await expect(page.locator('button.solve')).toHaveText(/Solved · rev \d+/, { timeout: 180_000 });
    await expect(page.locator('button.solve')).toHaveClass(/solved/);

    // The fresh Result owns a visible Journal boundary. Undoing its producing solve removes the
    // provenance marker even though the engine still has the cached Result; redo restores it.
    await page.locator('.tab', { hasText: 'journal' }).click();
    const boundary = page.locator('.boundary');
    await expect(boundary).toHaveCount(1);
    const firstBoundary = Number(await boundary.locator('..').locator('.jrow .no').textContent());
    await page.evaluate(() => window.fem.journal.undo({ steps: 1 }));
    await expect(boundary).toHaveCount(0);
    await page.evaluate(() => window.fem.journal.redo({ steps: 1 }));
    await expect(boundary).toHaveCount(1);
    expect(Number(await boundary.locator('..').locator('.jrow .no').textContent())).toBe(firstBoundary);
    await page.locator('.tab', { hasText: 'results' }).click();

    // 3 · the Results tab opened itself and the viewer switched to contours (design "Solve completion").
    await expect(page.locator('.tab.active')).toContainText('results');
    await expect(page.locator('button[data-cmd="view.setMode"][aria-pressed="true"]')).toHaveText('results');
    await expect(page.locator('.legend')).toBeVisible();
    await expect(page.locator('.deform-bar')).toBeVisible();

    // 4 · the tip deflection, within 2 % of the beam formula.
    const uz = await page.evaluate(async () => {
      const r = (await window.fem.query.result()) as unknown as { extremes: { field: string; component: number; min: { value: number; unit: string } }[] };
      return r.extremes.find((e) => e.field === 'displacement' && e.component === 2)!.min;
    });
    expect(uz.unit).toBe('mm');
    expect(Math.abs(Math.abs(uz.value) - TIMOSHENKO_MM) / TIMOSHENKO_MM).toBeLessThan(0.02);
    // and the same number is on screen, in the Extremes table.
    await expect(page.locator('.rtable', { hasText: 'displacement' })).toContainText(String(Number(uz.value.toPrecision(4))));

    // 5 · the balance line: the reactions carry exactly the applied load.
    await expect(page.locator('.surface.pass')).toContainText('Σ reactions = −Σ loads · 0.0000 %');
    await shot(page, '10-solved');

    // 6 · a screenshot of the viewer, with the legend burned into the PNG.
    const png = (await page.evaluate(async () => (await window.fem.registry.query({ query: 'query.screenshot', width: 900 })) as { png: string })).png;
    expect(png.startsWith('data:image/png;base64,')).toBe(true);
    expect(png.length).toBeGreaterThan(5000);

    // 7 · export a VTU from the Export modal and see the file arrive.
    await page.locator('button[data-cmd="panel.toggle"]', { hasText: 'Export' }).click();
    await expect(page.locator('.export-modal')).toBeVisible();
    await shot(page, '11-export');
    const download = page.waitForEvent('download');
    await page.locator('.export-row', { hasText: 'VTK unstructured grid' }).locator('button[data-cmd="file.export"]').click();
    expect((await download).suggestedFilename()).toMatch(/\.vtu$/);
    await page.keyboard.press('Escape');

    // 8 · edit the load: the Result survives, dimmed, and says it is stale.
    await page.evaluate(() => window.fem.load.traction({ name: 'tip', on: 'beam.xmax', total: ['0 N', '0 N', '-2 kN'] }));
    await expect(page.locator('.stale-banner')).toContainText('Result is stale');
    await expect(page.locator('button.solve')).toHaveText('Re-solve');
    await page.locator('.tab', { hasText: 'journal' }).click();
    await expect(boundary).toHaveCount(1);
    expect(Number(await boundary.locator('..').locator('.jrow .no').textContent())).toBe(firstBoundary);
    const staleSeqs = await page.locator('.jrow.stale .no').allTextContents();
    expect(staleSeqs.length).toBeGreaterThan(0);
    expect(staleSeqs.every((seq) => Number(seq) > firstBoundary)).toBe(true);
    await shot(page, '12-stale');

    // 9 · Re-solve, from the banner, and the staleness clears.
    await page.locator('.stale-banner button[data-cmd="solve.run"]').click();
    await expect(page.locator('button.solve')).toHaveText(/Solved · rev \d+/, { timeout: 180_000 });
    await expect(page.locator('.stale-banner')).toHaveCount(0);
    const doubled = await page.evaluate(async () => {
      const r = (await window.fem.query.result()) as unknown as { extremes: { field: string; component: number; min: { value: number } }[] };
      return r.extremes.find((e) => e.field === 'displacement' && e.component === 2)!.min.value;
    });
    await page.locator('.tab', { hasText: 'journal' }).click();
    await expect(boundary).toHaveCount(1);
    const secondBoundary = Number(await boundary.locator('..').locator('.jrow .no').textContent());
    expect(secondBoundary).toBeGreaterThan(firstBoundary);
    await expect(page.locator('.jrow.stale')).toHaveCount(0);
    // Undoing the second solve leaves its cached Result in the engine. Its producing line is
    // gone, so the marker disappears instead of being falsely attached to the first solve.
    await page.evaluate(() => window.fem.journal.undo({ steps: 1 }));
    await expect(boundary).toHaveCount(0);
    await page.evaluate(() => window.fem.journal.redo({ steps: 1 }));
    await expect(boundary).toHaveCount(1);
    expect(Number(await boundary.locator('..').locator('.jrow .no').textContent())).toBe(secondBoundary);
    // Twice the load on a linear model is twice the deflection.
    expect(Math.abs(doubled / uz.value - 2)).toBeLessThan(0.01);
    expect(errors).toEqual([]);
  });

  test('the Checks tab reads the mesh and the cost before any solve', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
    await page.goto('./');
    await ready(page);
    await page.evaluate(() => window.fem.dispatch({ cmd: 'file.openExample', name: 'cantilever' }));
    await page.locator('.tab', { hasText: 'checks' }).click();
    await expect(page.locator('.checks')).toContainText('min scaled Jacobian');
    await expect(page.locator('.checks')).toContainText('degrees of freedom');
    await expect(page.locator('.surface.pass')).toContainText('Nothing blocks a solve');
    await shot(page, '13-checks');
  });
});
