// Issue #247: does this Chromium survive reading a stored `FileSystemHandle` back out of
// IndexedDB? No FEM Lab code is involved — only Playwright's browser and a blank page.
//
//   node tools/repro-directory-handle.mjs
//   CHROMIUM_EXECUTABLE=/path/to/chrome node tools/repro-directory-handle.mjs   # compare revisions
//
// The matrix is what makes the finding precise: the profile, not the handle's origin, is the
// variable. Chromium 153.0.8010.12 on macOS arm64 ends the **browser process** — no exception, no
// `crash` event — for every ephemeral (off-the-record) row and passes every persistent one;
// 151.0.7922.34 passes all eight. Playwright's default context is off-the-record, so this is also
// the reason the app's own e2e suite can never store and reopen a real handle.
//
// Re-run this when the pinned Chromium moves. All eight rows OK means the boundary in
// `packages/app/src/ai/project.ts` could be simplified; anything else means keep it.
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const server = createServer((_request, response) => response.end('<html><body style="width:100vw;height:100vh">probe</body></html>'));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const executablePath = process.env.CHROMIUM_EXECUTABLE || undefined;

/** In the page: put `window.handle` into a `handles` store and wait for the transaction. */
const putHandle = async () => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('repro', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('handles');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const transaction = db.transaction('handles', 'readwrite');
    transaction.objectStore('handles').put(window.handle, 'project');
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
};

/** In the page: read it back. This is the call that takes the browser down. */
const getHandle = async () => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('repro', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('handles');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const value = await new Promise((resolve, reject) => {
      const request = db.transaction('handles', 'readonly').objectStore('handles').get('project');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return value === undefined ? '<undefined>' : `${value.kind}:${value.name}`;
  } finally {
    db.close();
  }
};

/** OPFS needs no gesture; the native row drops a real directory on the page over CDP. */
async function acquire(page, source, fixture) {
  if (source === 'opfs') {
    await page.evaluate(async () => {
      window.handle = await (await navigator.storage.getDirectory()).getDirectoryHandle('probe', { create: true });
    });
    return;
  }
  await page.evaluate(() => {
    document.body.addEventListener('dragover', (event) => event.preventDefault());
    document.body.addEventListener('drop', async (event) => {
      event.preventDefault();
      window.handle = await event.dataTransfer.items[0].getAsFileSystemHandle();
    });
  });
  const cdp = await page.context().newCDPSession(page);
  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    await cdp.send('Input.dispatchDragEvent', { type, x: 100, y: 100, data: { items: [], files: [fixture], dragOperationsMask: 1 } });
  }
  await page.waitForFunction(() => window.handle !== undefined);
}

async function row({ profile, source, again }) {
  const fixture = await mkdtemp(join(tmpdir(), 'fem247-dir-'));
  await writeFile(join(fixture, 'AGENTS.md'), '# probe\n');
  const dir = await mkdtemp(join(tmpdir(), 'fem247-profile-'));
  const open = async () => {
    if (profile === 'persistent') {
      const context = await chromium.launchPersistentContext(dir, { headless: true, executablePath });
      return { context, close: () => context.close() };
    }
    const browser = await chromium.launch({ headless: true, executablePath });
    return { context: browser, close: () => browser.close() };
  };
  let session = await open();
  let outcome;
  try {
    const page = await session.context.newPage();
    await page.goto(url);
    await acquire(page, source, fixture);
    await page.evaluate(putHandle);
    if (again === 'restart') {
      await session.close();
      session = await open();
      const next = await session.context.newPage();
      await next.goto(url);
      outcome = `OK   ${await next.evaluate(getHandle)}`;
    } else {
      await page.reload();
      outcome = `OK   ${await page.evaluate(getHandle)}`;
    }
  } catch (error) {
    outcome = `DIED ${String(error).split('\n')[0]}`;
  }
  console.log(`${profile.padEnd(11)} ${source.padEnd(7)} ${again.padEnd(8)} ${outcome}`);
  await session.close().catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
  await rm(fixture, { recursive: true, force: true });
  return outcome.startsWith('OK');
}

const browser = await chromium.launch({ headless: true, executablePath });
console.log(`Chromium ${browser.version()}, ${process.platform}/${process.arch}`);
await browser.close();

let died = 0;
for (const profile of ['persistent', 'ephemeral']) {
  for (const source of ['opfs', 'native']) {
    for (const again of ['reload', 'restart']) if (!(await row({ profile, source, again }))) died += 1;
  }
}
await new Promise((resolve) => server.close(resolve));
console.log(died === 0 ? 'every row survived: this Chromium deserialises stored handles' : `${died} row(s) took the browser down`);
