import { expect, test, type Page } from '@playwright/test';

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
  await page.waitForFunction(async () => Boolean(await window.fem.query.capabilities()), undefined, { timeout: 60_000 });
}

test.describe('@cpu autosave Journal revisions', () => {
  test('lists same-prefix revisions and reopens selected saved results state', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('femlab.tour.dismissed', '1');
      indexedDB.deleteDatabase('femlab');
    });
    await page.goto('./');
    await ready(page);

    await page.evaluate(() => window.fem.model.new({ name: 'history-seed' }));
    await page.evaluate(() => window.fem.dispatch({ cmd: 'file.openExample', name: 'cantilever' }));
    await expect(page.locator('.workspace')).toBeVisible();
    await expect(page.locator('button.solve')).toHaveText(/Solved · rev \d+/, { timeout: 180_000 });
    const solvedCommands = (await page.evaluate(() => window.fem.query.journal())).entries.length;
    await page.evaluate(() => window.fem.geometry.addBox({ name: 'after-solve-a', size: ['10 mm', '10 mm', '10 mm'] }));
    await page.evaluate(() => window.fem.geometry.addBox({ name: 'after-solve-b', size: ['20 mm', '10 mm', '10 mm'] }));
    await expect.poll(async () => ((await page.evaluate(() => window.fem.registry.query({ query: 'query.autosaveHistory' }))) as { revisions: unknown[] }).revisions.length).toBeGreaterThan(1);

    const history = (await page.evaluate(() => window.fem.registry.query({ query: 'query.autosaveHistory' }))) as unknown as {
      revisions: { id: string; name: string; commands: number }[];
    };
    const solved = history.revisions.find((revision) => revision.commands === solvedCommands);
    const beforeSolve = history.revisions.find((revision) => revision.name === 'history-seed');
    expect(solved).toBeDefined();
    expect(beforeSolve).toBeDefined();
    const solvedRevision = solved!;
    const seedRevision = beforeSolve!;
    const samePrefix = history.revisions.filter((revision) => revision.name === 'cantilever');
    expect(samePrefix.length).toBeGreaterThan(1);
    expect(new Set(samePrefix.map((revision) => revision.id)).size).toBe(samePrefix.length);

    await page.locator('.tab', { hasText: 'history' }).click();
    await expect(page.locator('.bottom-body')).toContainText('Saved Journal revisions');
    await expect(page.locator(`button[title="file.restore ${seedRevision.id}"]`)).toBeVisible();
    await page.locator(`button[title="file.restore ${seedRevision.id}"]`).click();
    await expect.poll(async () => (await page.evaluate(() => window.fem.query.journal())).entries.length).toBe(seedRevision.commands);
    await expect.poll(async () => page.evaluate(async () => {
      try {
        return await window.fem.query.result();
      } catch {
        return null;
      }
    })).toBeNull();

    await page.evaluate((id) => window.fem.dispatch({ cmd: 'file.restore', id }), solvedRevision.id);
    await expect.poll(async () => (await page.evaluate(() => window.fem.query.journal())).entries.length).toBe(solvedRevision.commands);
    await expect.poll(async () => Boolean(await page.evaluate(() => window.fem.query.result()))).toBe(true);
  });
});
