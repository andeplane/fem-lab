import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
  await page.waitForFunction(async () => Boolean(await window.fem.query.capabilities()), undefined, { timeout: 60_000 });
}

async function persistedProject(page: Page): Promise<unknown> {
  return page.evaluate(async () => {
    const open = await window.fem.registry.query({ query: 'query.project' });
    const id = (open as { id?: string } | null)?.id;
    if (id === undefined) return null;
    return new Promise<unknown>((resolve, reject) => {
      const opening = indexedDB.open('femlab', 2);
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const db = opening.result;
        const tx = db.transaction(['projects', 'journals'], 'readonly');
        const meta = tx.objectStore('projects').get(id);
        const journal = tx.objectStore('journals').get(id);
        tx.oncomplete = () => {
          db.close();
          const m = meta.result as { name: string } | undefined;
          if (!m) return resolve(null);
          resolve({ name: m.name, cmds: (journal.result as { cmds: unknown[] } | undefined)?.cmds ?? [] });
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  });
}

/** A real file.save output, prepared before replacing it with the old, solved model. */
async function savedCube(page: Page): Promise<Buffer> {
  await page.evaluate(async () => {
    await window.fem.model.new({ name: 'imported-model' });
    await window.fem.geometry.addBox({ name: 'imported-cube', size: ['1 m', '1 m', '1 m'] });
    await window.fem.mesh.set({ mesher: { kind: 'lattice', size: '250 mm' }, order: 1 });
  });
  const downloading = page.waitForEvent('download');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'file.save', name: 'imported.femlab.json', to: 'download' }));
  const download = await downloading;
  return readFile((await download.path())!);
}

test.describe('@cpu opening a model file', () => {
  test.setTimeout(180_000);

  for (const route of ['picker', 'json'] as const) {
    test(`refreshes the entire app after file.open via ${route}`, async ({ page }) => {
      await page.setViewportSize({ width: 1600, height: 1000 });
      await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
      await page.goto('./');
      await ready(page);
      const file = await savedCube(page);
      const imported = JSON.parse(file.toString()) as { journal: { entries: { cmd: unknown }[] } };

      await page.evaluate(() => window.fem.dispatch({ cmd: 'file.openExample', name: 'cantilever' }));
      await expect(page.locator('button.solve')).toHaveClass(/solved/);
      await expect(page.locator('.legend')).toBeVisible();
      await expect(page.locator('.model-name')).toHaveValue('cantilever');
      await expect.poll(() => persistedProject(page)).toMatchObject({ name: 'cantilever' });
      // Place the ray through the imported cube's centre. A stale cantilever surface cannot
      // produce an imported-cube pick, even if the tree and result legend refreshed correctly.
      await page.evaluate(() => window.fem.dispatch({ cmd: 'view.setCamera', position: [3, -4, 3], target: [0.5, 0.5, 0.5] }));

      if (route === 'picker') {
        const choosing = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: 'Open', exact: true }).click();
        await (await choosing).setFiles({ name: 'imported.femlab.json', mimeType: 'application/json', buffer: file });
      } else {
        await page.evaluate((json) => window.fem.dispatch({ cmd: 'file.open', json }), file.toString());
      }

      // No engine Command follows the import: each assertion reads the resulting state.
      await expect(page.locator('.model-name')).toHaveValue('imported-model');
      await expect(page.locator('.tree')).toContainText('imported-cube');
      await expect(page.locator('.tree')).not.toContainText('steel');
      await expect(page.locator('.legend')).toHaveCount(0);
      await expect(page.locator('.bottom-body')).toContainText('No Result yet.');
      await expect(page.locator('button.solve')).not.toHaveClass(/solved/);

      await page.getByRole('tab', { name: /^journal/ }).click();
      await expect(page.locator('.jrow')).toHaveCount(imported.journal.entries.length);
      await expect(page.locator('.bottom-body')).toContainText('imported-model');
      await expect(page.locator('.bottom-body')).toContainText('imported-cube');
      await expect(page.locator('.bottom-body')).not.toContainText('solve.run');
      await page.getByRole('tab', { name: /^script/ }).click();
      await expect(page.locator('.script-view')).toContainText('imported-cube');
      await expect(page.locator('.script-view')).not.toContainText('cantilever');

      const canvas = page.locator('.viewer canvas');
      const bounds = (await canvas.boundingBox())!;
      await canvas.click({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
      await expect.poll(async () => (await page.evaluate(() => window.fem.registry.query({ query: 'query.selection' })) as { bodies: string[] }).bodies).toEqual(['imported-cube']);

      const expectedCommands = imported.journal.entries.map((entry) => entry.cmd);
      expect((await page.evaluate(() => window.fem.query.journal())).entries.map((entry) => entry.cmd)).toEqual(expectedCommands);
      expect(await page.evaluate(() => window.fem.registry.query({ query: 'query.project' }))).toMatchObject({ name: 'imported-model', commands: expectedCommands.length });
      // The save is debounced; verify the actual persisted Journal, not only its UI summary.
      await expect.poll(() => persistedProject(page)).toMatchObject({ name: 'imported-model', cmds: expectedCommands });
    });
  }
});
