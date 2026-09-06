// Issue #40, in the built app: the Assistant drawer opens on the start screen, and it is still
// there — with the same conversation — once the first Command brings the workspace up around it.
import { expect, test, type Page } from '@playwright/test';

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
  await page.waitForFunction(async () => Boolean(await window.fem.query.capabilities()), undefined, { timeout: 60_000 });
}

test.describe('@cpu the Assistant before a Model exists', () => {
  test('opens over the start screen and survives the workspace appearing', async ({ page }) => {
    await page.goto('./');
    await ready(page);

    // The start screen, not the shell.
    await expect(page.locator('.start')).toBeVisible();
    await expect(page.locator('.shell')).toHaveCount(0);

    // The two Commands the start screen's "Ask the Assistant" card dispatches, in one tick —
    // which is what used to lose the line: the drawer had not mounted yet to receive it.
    await page.evaluate(async () => {
      await window.fem.dispatch({ cmd: 'panel.toggle', panel: 'assistant', open: true });
      await window.fem.dispatch({ cmd: 'chat.send', text: 'a 1 m steel cantilever, 10 kN at the tip' });
    });

    const drawer = page.locator('aside.assistant');
    await expect(drawer).toBeVisible();
    // No API key in the test browser, so the drawer answers by opening Settings — the point is
    // that it answered at all.
    await expect(drawer).toContainText('API key');
    await expect(page.locator('.start')).toBeVisible();

    // The first Command brings the workspace up around the drawer, which keeps its content.
    await page.evaluate(() => window.fem.model.new({ name: 'from-the-assistant' }));
    await expect(page.locator('.shell')).toBeVisible();
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText('API key');
    // Reserved, not overlaid: the workspace still shows Properties beside it.
    await expect(page.locator('.under-bar.with-assistant')).toHaveCount(1);
  });
});

test('@cpu composer suggestions and skills prepare editable drafts by keyboard', async ({ page }) => {
  await page.goto('./');
  await ready(page);
  await page.evaluate(() => window.fem.dispatch({ cmd: 'chat.setDraft', text: 'Inspect my beam' }));
  const drawer = page.locator('aside.assistant');
  const input = drawer.locator('textarea');
  await expect(drawer).toBeVisible();
  await expect(input).toHaveValue('Inspect my beam');
  const skillMenu = drawer.getByTitle('Choose a skill for this draft');
  await skillMenu.focus();
  await page.keyboard.press('Enter');
  const skill = drawer.locator('.popover button').filter({ hasText: 'beam-theory-check' });
  await skill.focus();
  await page.keyboard.press('Space');
  await expect(input).toHaveValue('/beam-theory-check Inspect my beam');
  await expect(input).toBeFocused();
  await expect(drawer.locator('.messages')).toBeEmpty();
  const suggestion = drawer.locator('.suggestions button').first();
  await suggestion.focus();
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue(/Help me build a cantilever/);
  await expect(input).toBeFocused();
  await expect(drawer.locator('.messages')).toBeEmpty();
  await drawer.getByTitle('Close the assistant').click();
  await expect(drawer).toBeHidden();
  await page.evaluate(() => window.fem.dispatch({ cmd: 'chat.setDraft', text: 'Reopened draft' }));
  await expect(drawer).toBeVisible();
  await expect(input).toHaveValue('Reopened draft');
  await expect(input).toBeFocused();
});
