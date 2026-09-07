import { expect, test as base, type Page } from '@playwright/test';

const test = base.extend<{ pageErrors: void }>({
  pageErrors: [async ({ context }, use) => {
    const errors: string[] = [];
    const observe = (page: Page) => page.on('pageerror', (error) => errors.push(error.message));
    context.pages().forEach(observe);
    context.on('page', observe);
    await use();
    expect(errors).toEqual([]);
  }, { auto: true }],
});

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
}

async function storedAutosaves(page: Page): Promise<{ name: string; id?: string }[]> {
  return page.evaluate(() => new Promise<{ name: string; id?: string }[]>((resolve, reject) => {
    const open = indexedDB.open('femlab');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const request = db.transaction('revisions', 'readonly').objectStore('revisions').get('last');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        resolve(Array.isArray(request.result) ? request.result : request.result ? [request.result] : []);
        db.close();
      };
    };
  }));
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

  test('restoring history forks a project and preserves the saved newer Journal', async ({ page }) => {
    await page.goto('./');
    await ready(page);
    await page.evaluate(() => window.fem.dispatch({ cmd: 'project.new', name: 'original' }));
    const revisions = await page.evaluate(async () => (await window.fem.registry.query({ query: 'query.autosaveHistory' })) as { revisions: { id: string; commands: number }[] });
    const old = revisions.revisions[0]!;
    await page.evaluate(() => window.fem.geometry.addBox({ name: 'later-body', size: ['1 m', '1 m', '1 m'] }));
    const newer = await page.evaluate(() => window.fem.query.journal());
    const original = await page.evaluate(() => window.fem.dispatch({ cmd: 'project.save' })) as unknown as { id: string };
    await expect.poll(async () => (await storedAutosaves(page)).some((revision) => revision.id === old.id)).toBe(true);
    await page.evaluate(() => window.fem.dispatch({ cmd: 'file.autosave', on: false }));
    const historyBefore = await page.evaluate(() => window.fem.registry.query({ query: 'query.autosaveHistory' }));
    await page.evaluate((id) => window.fem.dispatch({ cmd: 'file.restore', id }), old.id);
    expect(await page.evaluate(() => window.fem.registry.query({ query: 'query.autosaveHistory' }))).toEqual(historyBefore);
    expect((await page.evaluate(() => window.fem.query.journal())).entries).toHaveLength(old.commands);
    const restored = await page.evaluate(() => window.fem.dispatch({ cmd: 'project.save' })) as unknown as { id: string };
    expect(restored.id).not.toBe(original.id);
    await page.reload();
    await ready(page);
    await page.evaluate((id) => window.fem.dispatch({ cmd: 'project.open', id }), original.id);
    expect(await page.evaluate(() => window.fem.query.journal())).toEqual(newer);
  });

  test('atomically merges concurrent autosaves from two browser tabs', async ({ page }) => {
    await page.goto('./');
    await ready(page);
    await page.evaluate(() => new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('femlab');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    }));
    await page.reload();
    await ready(page);
    const peer = await page.context().newPage();
    await peer.goto('./');
    await ready(peer);
    await Promise.all([
      page.evaluate(() => window.fem.model.new({ name: 'tab-a' })),
      peer.evaluate(() => window.fem.model.new({ name: 'tab-b' })),
    ]);
    await expect.poll(async () => (await storedAutosaves(page)).filter((revision) => revision.name === 'tab-a' || revision.name === 'tab-b').length).toBe(2);
    const saved = (await storedAutosaves(page)).filter((revision) => revision.name === 'tab-a' || revision.name === 'tab-b');
    expect(saved.map((revision) => revision.name).sort()).toEqual(['tab-a', 'tab-b']);
    expect(new Set(saved.map((revision) => revision.id)).size).toBe(2);
    await peer.close();
  });

  test('restores both IDs when two browser tabs save identical Journal content', async ({ page }) => {
    await page.goto('./');
    await ready(page);
    await page.evaluate(() => new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('femlab');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    }));
    await page.reload();
    await ready(page);
    const peer = await page.context().newPage();
    await peer.goto('./');
    await ready(peer);
    await Promise.all([
      page.evaluate(() => window.fem.model.new({ name: 'same-content' })),
      peer.evaluate(() => window.fem.model.new({ name: 'same-content' })),
    ]);
    await expect.poll(async () => (await storedAutosaves(page)).filter((revision) => revision.name === 'same-content').length).toBe(2);
    await page.reload();
    await ready(page);
    await expect.poll(async () => ((await page.evaluate(() => window.fem.registry.query({ query: 'query.autosaveHistory' }))) as { revisions: { name: string }[] }).revisions.filter((revision) => revision.name === 'same-content').length).toBe(2);
    const history = (await page.evaluate(() => window.fem.registry.query({ query: 'query.autosaveHistory' }))) as { revisions: { id: string; name: string }[] };
    const revisions = history.revisions.filter((revision) => revision.name === 'same-content');
    expect(revisions).toHaveLength(2);
    expect(new Set(revisions.map((revision) => revision.id)).size).toBe(2);
    await page.evaluate(async (ids) => {
      for (const id of ids) await window.fem.dispatch({ cmd: 'file.restore', id });
    }, revisions.map((revision) => revision.id));
    await peer.close();
  });
});
