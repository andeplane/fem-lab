// Issue #247 recovery in the built app. The historical Chromium 153 crash motivated keeping
// startup separate from handle deserialization. Valid native-handle reloads are now covered by
// project.spec.ts. This test seeds an invalid remembered handle and checks that startup reads
// only metadata, saved projects still load, and explicit reopen reports `file.not-found` and
// restores the picker instead of going quiet.
import { expect, test } from './fixtures';
import type { Page } from './fixtures';

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
  await page.evaluate(() => window.fem.query.capabilities());
}

/**
 * Write both handle records straight into the `femlab` database, with a value that is not a
 * directory handle: a record from an older build, another app, or a structured clone that no
 * longer produces one. This invalid record must fail even when real handles restore correctly.
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
  // Listing saved projects must remain independent of whether a remembered handle is usable.
  expect(await deserialised(page)).not.toContain('handles:folder');

  await page.getByTitle('project.open kept-project').click();
  await page.locator('.topbar').getByRole('button', { name: '✳ Assistant', exact: true }).click();
  const assistant = page.locator('.assistant');

  // The folder is offered by name, read from the descriptor beside the handle and never the handle.
  const reopen = assistant.getByTitle('Reopen gone-folder', { exact: true });
  await expect(reopen).toBeVisible();
  await expect(reopen).toHaveText('reopen gone-folder');
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
  await expect(assistant.getByTitle('Open a project folder', { exact: true })).toBeVisible();
  await expect(reopen).toHaveCount(0);
  expect(await page.evaluate(() => window.fem.registry.query({ query: 'query.folder' }))).toBeNull();
  expect(await page.evaluate(() => window.fem.registry.query({ query: 'query.folderRecent' }))).toBeNull();

  // Forgotten rather than retried: the next start has no record left to offer, and the project stands.
  expect(await handleKeys(page)).toEqual([]);
  await page.reload();
  await ready(page);
  await expect(page.getByTitle('project.open kept-project')).toBeVisible();
  await page.getByTitle('project.open kept-project').click();
  await page.locator('.topbar').getByRole('button', { name: '✳ Assistant', exact: true }).click();
  await expect(assistant.getByTitle('Open a project folder', { exact: true })).toBeVisible();
  await expect(reopen).toHaveCount(0);
  expect(await page.evaluate(() => window.fem.registry.query({ query: 'query.folderRecent' }))).toBeNull();
});
