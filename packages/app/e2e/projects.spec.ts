// Issue #41 in the built app: a project is started, built, saved, found again after a reload and
// reopened to the *same Model hash* — identity, not similarity. Plus the file round trip, and the
// start screen's own composer (issue #40) which only exists here.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
  await page.waitForFunction(async () => Boolean(await window.fem.query.capabilities()), undefined, { timeout: 60_000 });
}

const modelHash = (page: Page): Promise<string> => page.evaluate(async () => ((await window.fem.query.model()) as unknown as { hash: string }).hash);

/** The three Commands on top of the `model.new` that `project.new` issues. */
async function build(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.fem.geometry.addBox({ name: 'beam', size: ['1 m', '100 mm', '100 mm'] });
    await window.fem.material.add({ name: 'steel', E: '210 GPa', nu: 0.3 });
    await window.fem.material.assign({ material: 'steel', bodies: ['beam'] });
  });
}

test.describe('@cpu projects in this browser', () => {
  test('explicit save writes the exact Journal with autosave off, reopens it, and rejects a failed write', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('femlab.autosave', 'off');
      const state = window as typeof window & { failProjectJournalWrite?: boolean };
      state.failProjectJournalWrite = false;
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
        if (state.failProjectJournalWrite === true && this.name === 'journals') {
          this.transaction.abort();
          throw new DOMException('injected project Journal failure', 'QuotaExceededError');
        }
        return key === undefined ? put.call(this, value) : put.call(this, value, key);
      };
    });
    await page.goto('./');
    await ready(page);
    await page.evaluate(() => window.fem.dispatch({ cmd: 'project.new', name: 'manual-save' }));
    await build(page);
    const before = await page.evaluate(async () => ({
      model: await window.fem.query.model(),
      journal: await window.fem.query.journal(),
    }));
    const receipt = await page.evaluate(() => window.fem.dispatch({ cmd: 'project.save' })) as unknown as {
      id: string;
      autosave: boolean;
      journal: { entries: unknown[] };
    };
    expect(receipt.autosave).toBe(false);
    expect(receipt.journal.entries).toEqual(before.journal.entries);

    // This later edit is only in memory. Reopening after a reload must reproduce the payload
    // captured by explicit Save, rather than the newest refresh that happened while storage was off.
    await page.evaluate(() => window.fem.geometry.addBox({ name: 'unsaved', size: ['2 m', '20 mm', '20 mm'] }));
    expect((await page.evaluate(() => window.fem.query.journal())).entries).toHaveLength(before.journal.entries.length + 1);
    await page.reload();
    await ready(page);
    await page.evaluate((id) => window.fem.dispatch({ cmd: 'project.open', id }), receipt.id);
    expect(await page.evaluate(() => window.fem.query.journal())).toEqual(before.journal);
    expect(await modelHash(page)).toBe(before.model.hash);

    await page.evaluate(() => window.fem.geometry.addBox({ name: 'write-must-fail', size: ['3 m', '30 mm', '30 mm'] }));
    const failure = await page.evaluate(async () => {
      (window as typeof window & { failProjectJournalWrite?: boolean }).failProjectJournalWrite = true;
      try {
        await window.fem.dispatch({ cmd: 'project.save' });
        return null;
      } catch (error) {
        return { name: (error as Error).name, message: (error as Error).message };
      }
    });
    expect(failure).toEqual({ name: 'QuotaExceededError', message: 'injected project Journal failure' });
    await expect(page.locator('.error-card')).toContainText('injected project Journal failure');

    // The failed two-store transaction leaves the previous explicit save openable byte-for-byte.
    await page.reload();
    await ready(page);
    await page.evaluate((id) => window.fem.dispatch({ cmd: 'project.open', id }), receipt.id);
    expect(await page.evaluate(() => window.fem.query.journal())).toEqual(before.journal);
    expect(await modelHash(page)).toBe(before.model.hash);
  });

  test('new → build → save → reload → Recent → open, on the same Model hash', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
    await page.goto('./');
    await expect(page.locator('.start')).toBeVisible();
    await ready(page);

    // Nothing saved yet: the screen says where a project would go rather than showing an
    // empty list with no explanation.
    await expect(page.locator('.no-projects')).toContainText('kept in this browser');

    await page.getByLabel('project name').fill('corbel-ULS');
    await page.locator('button[title="project.new"]').click();
    await expect(page.locator('.workspace')).toBeVisible();
    await build(page);
    const hash = await modelHash(page);
    expect(hash).toBeTruthy();

    // The top bar names the project and says it is saved.
    await expect(page.locator('input.model-name')).toHaveValue('corbel-ULS');

    // The explicit flush, so the reload is not racing the debounce.
    await page.evaluate(() => window.fem.dispatch({ cmd: 'project.save' }));

    // A second project, so Recent has two cards and the screenshot shows the real thing.
    await page.evaluate(async () => {
      await window.fem.dispatch({ cmd: 'project.new', name: 'plate-with-hole' });
      await window.fem.geometry.addBox({ name: 'plate', size: ['500 mm', '500 mm', '20 mm'] });
      await window.fem.dispatch({ cmd: 'project.save' });
    });

    await page.reload();
    await ready(page);
    await expect(page.locator('.start')).toBeVisible();
    const cards = page.locator('.recent');
    await expect(cards).toHaveCount(2);
    // Newest first, and each card says how much of a Journal it holds.
    await expect(cards.nth(0)).toContainText('plate-with-hole');
    await expect(cards.nth(1)).toContainText('corbel-ULS');
    await expect(cards.nth(1)).toContainText('4 Commands');
    await testInfo.attach('start-screen.png', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });

    // Reopening replays the Journal: same Model, same hash, same last `hashAfter`.
    await cards.nth(1).locator('button[data-cmd="project.open"]').click();
    await expect(page.locator('.workspace')).toBeVisible();
    expect(await modelHash(page)).toBe(hash);
    const last = await page.evaluate(async () => {
      const journal = (await window.fem.query.journal()) as unknown as { entries: { hashAfter: string }[] };
      return journal.entries.at(-1)!.hashAfter;
    });
    expect(last).toBe(hash);
    await expect(page.locator('input.model-name')).toHaveValue('corbel-ULS');

    // Renaming the open project is one Command, and the Recent list follows it.
    await page.evaluate(() => window.fem.dispatch({ cmd: 'project.rename', name: 'corbel-SLS' }));
    await expect(page.locator('input.model-name')).toHaveValue('corbel-SLS');
  });

  test('a femlab/1 file written from a project opens into a new one, same hash again', async ({ page }) => {
    await page.goto('./');
    await ready(page);
    await page.evaluate(() => window.fem.dispatch({ cmd: 'project.new', name: 'to-a-file' }));
    await build(page);
    const hash = await modelHash(page);

    const download = await Promise.race([page.waitForEvent('download'), page.evaluate(() => window.fem.dispatch({ cmd: 'file.save' })).then(() => null)]).then(
      (d) => d ?? page.waitForEvent('download'),
    );
    const json = readFileSync(await download.path(), 'utf8');

    // Opening a file replaces the Model, so it forks a project rather than overwriting the one
    // it came from — both are in Recent afterwards.
    await page.evaluate((text) => window.fem.dispatch({ cmd: 'file.open', json: text }), json);
    expect(await modelHash(page)).toBe(hash);
    await page.evaluate(() => window.fem.dispatch({ cmd: 'project.save' }));
    // `query.projects` is a host Query, so it is not on the generated `fem.query` proxy.
    const names = await page.evaluate(async () => ((await window.fem.registry.query({ query: 'query.projects' } as never)) as { projects: { name: string }[] }).projects.map((p) => p.name));
    expect(names).toHaveLength(2);
  });

  test('the start screen composer opens the Assistant over it, and the workspace comes up around it', async ({ page }) => {
    await page.goto('./');
    await ready(page);
    // No API key in the test browser, so the drawer answers by opening its Settings — the point
    // is that the line reached a drawer that did not exist when it was typed (issue #40).
    await page.getByLabel('describe the part').fill('a 1 m steel cantilever, 10 kN at the tip');
    await page.getByLabel('describe the part').press('Enter');

    const drawer = page.locator('aside.assistant');
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('.settings')).toBeVisible();
    await expect(page.locator('.start')).toBeVisible();
    // The typed line is kept, so nothing has to be retyped once a key is pasted in.
    await expect(page.getByLabel('describe the part')).toHaveValue('a 1 m steel cantilever, 10 kN at the tip');

    await page.evaluate(() => window.fem.model.new({ name: 'from-the-assistant' }));
    await expect(page.locator('.shell')).toBeVisible();
    await expect(drawer.locator('.settings')).toBeVisible();
  });

  test('every control on the start screen names a Command the registry has', async ({ page }) => {
    await page.goto('./');
    await ready(page);
    const unknown = await page.evaluate(() => {
      const { commands, queries } = window.fem.registry.list();
      const known = new Set([...commands, ...queries].map((d) => d.name));
      return [...document.querySelectorAll('[data-cmd]')].map((el) => el.getAttribute('data-cmd')!).filter((c) => !known.has(c));
    });
    expect(unknown).toEqual([]);
  });
});
