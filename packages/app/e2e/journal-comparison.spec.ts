import { expect, test } from '@playwright/test';
import type { EngineTransport } from '@femlab/registry';

async function ready(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
  await page.waitForFunction(async () => Boolean(await window.fem.query.capabilities()), undefined, { timeout: 60_000 });
}

test('@cpu Journal comparison keeps the explicit baseline and does not import the comparison file', async ({ page }) => {
  await ready(page);
  await page.evaluate(async () => {
    await window.fem.model.new({ name: 'comparison' });
    await window.fem.geometry.addBox({ name: 'beam', size: ['1 m', '100 mm', '100 mm'] });
  });
  await expect(page.locator('.topbar [data-cmd="file.compare"]')).toBeInViewport();
  const download = page.waitForEvent('download');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'file.save' }));
  const saved = await (await download).path();
  expect(saved).toBeTruthy();
  const { readFile } = await import('node:fs/promises');
  const savedFile = await readFile(saved!, 'utf8');

  await page.evaluate(() => window.fem.model.setName({ name: 'edited' }));
  const before = await page.evaluate(() => window.fem.query.journal());
  await page.evaluate((json) => window.fem.dispatch({ cmd: 'file.compare', json }), savedFile);
  const after = await page.evaluate(() => window.fem.query.journal());
  const diff = await page.evaluate(() => window.fem.registry.query({ query: 'query.journalComparison' }));

  expect(after).toEqual(before);
  expect(diff).toMatchObject({ sharedEntries: 2, removed: [], added: [{ cmd: { cmd: 'model.setName' } }] });
  await page.evaluate(() => window.fem.journal.undo({ steps: 1 }));
  await expect.poll(() => page.evaluate(() => window.fem.registry.query({ query: 'query.journalComparison' }))).toMatchObject({ sharedEntries: 2, added: [] });
  await expect(page.locator('.comparison-label')).toContainText('Compared file');
});

test('@cpu repeated Commands highlight only the added causal occurrence', async ({ page }) => {
  await ready(page);
  await page.evaluate(async () => {
    await window.fem.model.new({ name: 'A' });
    await window.fem.geometry.addBox({ name: 'beam', size: ['1 m', '1 m', '1 m'] });
    await window.fem.model.setName({ name: 'B' });
  });
  const download = page.waitForEvent('download');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'file.save' })); await download;
  await page.evaluate(() => window.fem.model.setName({ name: 'B' }));
  expect(await page.evaluate(() => window.fem.registry.query({ query: 'query.journalComparison' })))
    .toMatchObject({ sharedEntries: 3, added: [{ seq: 3, cmd: { cmd: 'model.setName', name: 'B' } }] });
  expect(await page.locator('.comparison-added .no').allTextContents()).toEqual(['3']);
});

interface ReplyGate {
  op: string | null;
  held: number;
  release(): void;
  pending?: Promise<unknown>;
}
/** Delay a normalized transport response after the real Worker RPC completed, leaving its queue free. */
async function installReplyGate(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const gate: ReplyGate = { op: null, held: 0, release: () => undefined };
    const deliveries: (() => void)[] = [];
    gate.release = () => { for (const deliver of deliveries.splice(0)) deliver(); gate.held = 0; };
    Object.assign(window, { comparisonGate: gate });
    // Inject scheduling at the typed host boundary; every value still comes from the real engine.
    const transport = (window.fem.registry as unknown as { transport: EngineTransport }).transport;
    const delay = async <T>(op: string, action: () => Promise<T>): Promise<T> => {
      const hold = gate.op === op;
      if (hold) gate.op = null;
      const value = await action();
      if (!hold) return value;
      gate.held++;
      return new Promise<T>(resolve => deliveries.push(() => resolve(value)));
    };
    const exportFile = transport.exportFile.bind(transport);
    const query = transport.query.bind(transport);
    transport.exportFile = () => delay('exportFile', exportFile);
    transport.query = input => delay(input.query, () => query(input));
  });
}

test('@cpu edits made during a delayed Save remain outside its explicit baseline', async ({ page }) => {
  await ready(page); await installReplyGate(page);
  await page.evaluate(async () => {
    await window.fem.model.new({ name: 'saved snapshot' });
    await window.fem.geometry.addBox({ name: 'beam', size: ['1 m', '1 m', '1 m'] });
    const gate = (window as unknown as { comparisonGate: ReplyGate }).comparisonGate;
    gate.op = 'exportFile'; gate.pending = window.fem.dispatch({ cmd: 'file.save' });
  });
  await page.waitForFunction(() => (window as unknown as { comparisonGate: ReplyGate }).comparisonGate.held === 1);
  await page.evaluate(() => window.fem.model.setName({ name: 'later edit' }));
  const download = page.waitForEvent('download');
  await page.evaluate(async () => {
    const gate = (window as unknown as { comparisonGate: ReplyGate }).comparisonGate;
    gate.release(); await gate.pending;
  });
  const { readFile } = await import('node:fs/promises');
  const file = JSON.parse(await readFile((await (await download).path())!, 'utf8'));
  expect(file.journal.entries).toHaveLength(2);
  expect(await page.evaluate(() => window.fem.registry.query({ query: 'query.journalComparison' })))
    .toMatchObject({ sharedEntries: 2, added: [{ cmd: { cmd: 'model.setName', name: 'later edit' } }] });
  await expect(page.locator('[aria-label="Unsaved changes"]')).toBeVisible();
});

test('@cpu a late imported comparison cannot replace a newer explicit Save', async ({ page }) => {
  await ready(page); await installReplyGate(page);
  await page.evaluate(async () => {
    await window.fem.model.new({ name: 'colleague' });
    await window.fem.geometry.addBox({ name: 'beam', size: ['1 m', '1 m', '1 m'] });
  });
  const download = page.waitForEvent('download');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'file.save' }));
  const { readFile } = await import('node:fs/promises');
  const imported = await readFile((await (await download).path())!, 'utf8');
  await page.evaluate(async json => {
    await window.fem.model.setName({ name: 'current' });
    await window.fem.dispatch({ cmd: 'file.compare', json });
    const gate = (window as unknown as { comparisonGate: ReplyGate }).comparisonGate;
    gate.op = 'query.journalDiff'; gate.pending = window.fem.registry.query({ query: 'query.journalComparison' });
  }, imported);
  await page.waitForFunction(() => (window as unknown as { comparisonGate: ReplyGate }).comparisonGate.held === 1);
  const saved = page.waitForEvent('download');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'file.save' })); await saved;
  expect(await page.evaluate(async () => {
    const gate = (window as unknown as { comparisonGate: ReplyGate }).comparisonGate;
    gate.release(); return gate.pending;
  })).toBeNull();
  expect(await page.evaluate(() => window.fem.registry.query({ query: 'query.journalComparison' })))
    .toMatchObject({ sharedEntries: 3, added: [], removed: [] });
  await expect(page.locator('.comparison-label')).toContainText('Since last explicit save/open');
  await expect(page.locator('.comparison-added')).toHaveCount(0);
});

test('@cpu a live-engine comparison waits for the displayed Journal to hydrate', async ({ page }) => {
  await ready(page); await installReplyGate(page);
  await page.evaluate(async () => {
    await window.fem.model.new({ name: 'hydrated snapshot' });
    await window.fem.geometry.addBox({ name: 'beam', size: ['1 m', '1 m', '1 m'] });
  });
  const download = page.waitForEvent('download');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'file.save' })); await download;
  await page.evaluate(() => {
    const gate = (window as unknown as { comparisonGate: ReplyGate }).comparisonGate;
    gate.op = 'query.model'; gate.pending = window.fem.model.setName({ name: 'ahead of hydration' });
  });
  await page.waitForFunction(() => (window as unknown as { comparisonGate: ReplyGate }).comparisonGate.held === 1);
  // The real Worker has recorded the edit, while the app's model/Journal refresh is held.
  expect(await page.evaluate(() => window.fem.query.journal())).toMatchObject({ entries: [
    { cmd: { cmd: 'model.new' } }, { cmd: { cmd: 'geometry.addBox' } },
    { cmd: { cmd: 'model.setName', name: 'ahead of hydration' } },
  ] });
  expect(await page.evaluate(() => window.fem.registry.query({ query: 'query.journalComparison' }))).toBeNull();
  await expect(page.locator('.comparison-added')).toHaveCount(0);
  await page.evaluate(async () => {
    const gate = (window as unknown as { comparisonGate: ReplyGate }).comparisonGate;
    gate.release(); await gate.pending;
  });
  expect(await page.evaluate(() => window.fem.registry.query({ query: 'query.journalComparison' })))
    .toMatchObject({ sharedEntries: 2, added: [{ cmd: { cmd: 'model.setName', name: 'ahead of hydration' } }] });
  expect(await page.locator('.comparison-added .no').allTextContents()).toEqual(['2']);
});

test('@cpu project Save establishes its receipt baseline and rejects a late imported comparison', async ({ page }) => {
  await ready(page); await installReplyGate(page);
  await page.evaluate(async () => {
    await window.fem.model.new({ name: 'browser project' });
    await window.fem.geometry.addBox({ name: 'beam', size: ['1 m', '1 m', '1 m'] });
  });
  const download = page.waitForEvent('download');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'file.save' }));
  const { readFile } = await import('node:fs/promises');
  const imported = await readFile((await (await download).path())!, 'utf8');
  await page.evaluate(async json => {
    await window.fem.model.setName({ name: 'later edit' });
    await window.fem.dispatch({ cmd: 'file.compare', json });
    const gate = (window as unknown as { comparisonGate: ReplyGate }).comparisonGate;
    gate.op = 'query.journalDiff'; gate.pending = window.fem.registry.query({ query: 'query.journalComparison' });
  }, imported);
  await page.waitForFunction(() => (window as unknown as { comparisonGate: ReplyGate }).comparisonGate.held === 1);
  expect(await page.evaluate(() => window.fem.dispatch({ cmd: 'project.save' })))
    .toMatchObject({ journal: { entries: [{ cmd: { cmd: 'model.new' } }, { cmd: { cmd: 'geometry.addBox' } }, { cmd: { cmd: 'model.setName', name: 'later edit' } }] } });
  expect(await page.evaluate(async () => {
    const gate = (window as unknown as { comparisonGate: ReplyGate }).comparisonGate;
    gate.release(); return gate.pending;
  })).toBeNull();
  expect(await page.evaluate(() => window.fem.registry.query({ query: 'query.journalComparison' })))
    .toMatchObject({ sharedEntries: 3, added: [], removed: [] });
  await expect(page.locator('[aria-label="Unsaved changes"]')).toHaveCount(0);
  await expect(page.locator('.comparison-label')).toContainText('Since last explicit save/open');
});
