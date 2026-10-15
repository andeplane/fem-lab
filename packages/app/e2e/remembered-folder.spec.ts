// Issue #247 in the built app. Chromium 153 ends the browser process when IndexedDB deserialises a
// stored `FileSystemHandle` in an off-the-record profile — which is exactly the profile Playwright
// runs in — so this test seeds the shape a browser that can no longer produce a handle leaves
// behind, and holds the app to the two things that matter: start-up never reads the handle slot, so
// the projects come back; and the reopen click reports a plain `file.not-found` and offers the
// picker again rather than dying or going quiet.
import { expect, test } from './fixtures';
import type { Page } from './fixtures';

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
  await page.evaluate(() => window.fem.query.capabilities());
}

/**
 * Write both handle records straight into the `femlab` database, with a value that is not a
 * directory handle: a record from an older build, another app, or a structured clone that no
 * longer produces one. A real handle cannot be used — deserialising it is what kills the browser.
 */
const poison = (page: Page, name: string): Promise<void> =>
  page.evaluate(async (folder) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('femlab', 3);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('handles', 'readwrite');
      transaction.objectStore('handles').put({ kind: 'file', name: folder }, 'folder');
      transaction.objectStore('handles').put({ name: folder, at: Date.now() }, 'folder:info');
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  }, name);

const handleKeys = (page: Page): Promise<string[]> =>
  page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('femlab', 3);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<string[]>((resolve, reject) => {
        const request = db.transaction('handles', 'readonly').objectStore('handles').getAllKeys();
        request.onsuccess = () => resolve(request.result.map(String));
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  });

/** Every value the page deserialises out of IndexedDB, as `store:key`, reset on each navigation. */
const deserialised = (page: Page): Promise<string[]> => page.evaluate(() => (window as typeof window & { idbGets: string[] }).idbGets);

test('@cpu a remembered folder this browser cannot restore costs a message, not the app', async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    localStorage.setItem('femlab.tour.dismissed', '1');
    const reads: string[] = [];
    (window as typeof window & { idbGets: string[] }).idbGets = reads;
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key: IDBValidKey | IDBKeyRange): IDBRequest {
      reads.push(`${this.name}:${String(key)}`);
      return get.call(this, key);
    };
  });
  await page.goto('./');
  await ready(page);

  // A saved project, so "the projects come back" is something this test can see.
  await page.evaluate(() => window.fem.dispatch({ cmd: 'project.new', name: 'kept-project' }));
  await page.evaluate(() => window.fem.geometry.addBox({ name: 'beam', size: ['1 m', '100 mm', '100 mm'] }));
  await page.evaluate(() => window.fem.dispatch({ cmd: 'project.save' }));
  await poison(page, 'gone-folder');

  await page.reload();
  await ready(page);

  // Start-up survived the poisoned record, and leads with the Recent list as it always does.
  await expect(page.getByTitle('project.open kept-project')).toBeVisible();
  await expect(page.locator('.recent')).toHaveCount(1);
  // The invariant behind all of it: nothing on the way to a usable app touched the handle store.
  // With a real handle in that slot instead of this stand-in, that read is what ends the browser.
  expect(await deserialised(page)).not.toContain('handles:folder');

  await page.getByTitle('project.open kept-project').click();
  await page.locator('.topbar').getByRole('button', { name: '✳ Assistant', exact: true }).click();
  const assistant = page.locator('.assistant');

  // The folder is offered by name, read from the descriptor beside the handle and never the handle.
  const reopen = assistant.getByTitle('Reopen the remembered folder', { exact: true });
  await expect(reopen).toBeVisible();
  await expect(reopen).toContainText('reopen ‘gone-folder’');
  expect(await deserialised(page)).toContain('handles:folder:info');
  expect(await deserialised(page)).not.toContain('handles:folder');

  await reopen.click();
  // Deserialising it is the click's business, and only the click's.
  await expect.poll(() => deserialised(page)).toContain('handles:folder');

  // Plain, structured, actionable — and the picker is back where the offer was.
  const banner = page.locator('.banner.error');
  await expect(banner).toContainText('file.not-found');
  await expect(banner).toContainText('the remembered folder ‘gone-folder’ is no longer available in this browser');
  await expect(banner).toContainText('open a project folder again to pick it');
  await expect(assistant.getByTitle('Open a folder on disk', { exact: true })).toBeVisible();

  // Forgotten rather than retried: the next start has no record left to offer, and the project stands.
  expect(await handleKeys(page)).toEqual([]);
  await page.reload();
  await ready(page);
  await expect(page.getByTitle('project.open kept-project')).toBeVisible();
  await page.getByTitle('project.open kept-project').click();
  await page.locator('.topbar').getByRole('button', { name: '✳ Assistant', exact: true }).click();
  await expect(assistant.getByTitle('Open a folder on disk', { exact: true })).toBeVisible();
});
