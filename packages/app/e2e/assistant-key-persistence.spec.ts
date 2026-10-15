import { expect, test, type Page } from './fixtures';

const anthropicKey = 'test-only-anthropic-persistence-485';
const openaiKey = 'test-only-openai-persistence-485';

async function settings(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean(window.fem));
  await page.evaluate(async () => {
    await window.fem.dispatch({ cmd: 'panel.toggle', panel: 'assistant', open: true });
    await window.fem.dispatch({ cmd: 'panel.toggle', panel: 'assistant.settings', open: true });
  });
  await expect(page.locator('aside.assistant .settings')).toBeVisible();
}

test('@cpu BYOK keys survive a real fresh tab and reload, and Forget removes only the selected provider', async ({ page, context }) => {
  let providerRequests = 0;
  await context.route(/https:\/\/api\.(openai|anthropic)\.com\//, async route => { providerRequests++; await route.abort(); });
  await context.addInitScript(() => { localStorage.setItem('femlab.tour.dismissed', '1'); localStorage.setItem('femlab.autosave', 'off'); });
  await page.goto('./');
  await settings(page);
  const first = page.locator('aside.assistant .settings');
  await first.locator('input[type=password]').fill(anthropicKey);
  await first.getByRole('button', { name: 'save', exact: true }).click();
  await expect(first).toContainText('from localStorage in this browser');
  await first.locator('select').selectOption('openai');
  await first.locator('input[type=password]').fill(openaiKey);
  await first.getByRole('button', { name: 'save', exact: true }).click();
  await expect(first).toContainText('from localStorage in this browser');

  // context.newPage has no opener and therefore no copied sessionStorage. This is an
  // actual fresh tab sharing only browser-persistent storage with the original page.
  const fresh = await context.newPage();
  await fresh.goto('./');
  await settings(fresh);
  const second = fresh.locator('aside.assistant .settings');
  await expect(second.locator('select')).toHaveValue('openai');
  await expect(second).toContainText('from localStorage in this browser');
  expect(await fresh.evaluate(() => sessionStorage.getItem('femlab.ai.key.openai'))).toBeNull();
  await fresh.reload();
  await settings(fresh);
  await expect(second).toContainText('from localStorage in this browser');
  const journal = await fresh.evaluate(() => window.fem.query.journal());
  await second.getByRole('button', { name: 'forget', exact: true }).click();
  await expect(second).toContainText('no key: the assistant cannot send anything');
  expect(await fresh.evaluate(() => ({ openai: localStorage.getItem('femlab.ai.key.openai'), anthropic: localStorage.getItem('femlab.ai.key') })))
    .toEqual({ openai: null, anthropic: anthropicKey });
  await fresh.close();

  const reopened = await context.newPage();
  await reopened.goto('./');
  await settings(reopened);
  const last = reopened.locator('aside.assistant .settings');
  await expect(last.locator('select')).toHaveValue('openai');
  await expect(last).toContainText('no key: the assistant cannot send anything');
  await last.locator('select').selectOption('anthropic');
  await expect(last).toContainText('from localStorage in this browser');
  expect(await reopened.evaluate(() => window.fem.query.journal())).toEqual(journal);
  const document = JSON.stringify(await reopened.evaluate(() => window.fem.query.document()));
  expect(document).not.toContain(anthropicKey); expect(document).not.toContain(openaiKey);
  expect(providerRequests).toBe(0);
});

test('@cpu refused persistent migration retains the usable tab key and a refused save keeps its draft', async ({ page, context }) => {
  let providerRequests = 0;
  await context.route(/https:\/\/api\.(openai|anthropic)\.com\//, async route => { providerRequests++; await route.abort(); });
  await page.addInitScript(() => {
    localStorage.setItem('femlab.tour.dismissed', '1'); localStorage.setItem('femlab.autosave', 'off');
    localStorage.setItem('femlab.ai.model', 'gpt-5.4-mini');
    sessionStorage.setItem('femlab.ai.key.openai', 'legacy-tab-key-485');
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (slot: string, value: string) {
      if (this === localStorage && slot.startsWith('femlab.ai.key')) throw new DOMException('refused for test', 'QuotaExceededError');
      original.call(this, slot, value);
    };
  });
  await page.goto('./');
  await settings(page);
  const panel = page.locator('aside.assistant .settings');
  await expect(panel).toContainText('from sessionStorage in this tab only');
  await expect(page.locator('aside.assistant .cost')).toContainText('key available in this tab only');
  await panel.locator('input[type=password]').fill('replacement-not-saved-485');
  await panel.getByRole('button', { name: 'save', exact: true }).click();
  await expect(page.locator('aside.assistant')).toContainText('unsupported: browser storage could not complete saving the key');
  await expect(panel.locator('input[type=password]')).toHaveValue('replacement-not-saved-485');
  expect(await page.evaluate(() => ({ persistent: localStorage.getItem('femlab.ai.key.openai'), session: sessionStorage.getItem('femlab.ai.key.openai') })))
    .toEqual({ persistent: null, session: 'legacy-tab-key-485' });
  expect(providerRequests).toBe(0);
});
