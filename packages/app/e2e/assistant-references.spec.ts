import { expect, test } from './fixtures';

test('@cpu tree references open the Assistant on first use and after collapse', async ({ page }) => {
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined');
  await page.evaluate(async () => {
    await window.fem.dispatch({ cmd: 'project.new', name: 'references' });
    await window.fem.geometry.addBox({ name: 'beam', size: ['1 m', '100 mm', '100 mm'] });
  });
  const drawer = page.locator('.assistant');
  await expect(drawer).toHaveCount(0);
  const reference = page.locator('.tree button[data-cmd="chat.insertMention"][title="Reference beam in chat"]');
  await reference.click();
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('.tokens .token')).toContainText('@body:beam');
  await expect(drawer.locator('textarea')).toBeFocused();

  await page.evaluate(() => window.fem.dispatch({ cmd: 'panel.toggle', panel: 'assistant', open: false }));
  await expect(drawer).toBeHidden();
  await reference.click();
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('.tokens .token')).toHaveCount(1);
  await expect(drawer.locator('textarea')).toBeFocused();

  // The callable host Command must retain the same behavior as its UI controls.
  await page.evaluate(() => window.fem.dispatch({ cmd: 'panel.toggle', panel: 'assistant', open: false }));
  await expect(drawer).toBeHidden();
  await page.evaluate(() => window.fem.dispatch({ cmd: 'chat.insertMention', ref: 'body:beam' }));
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('.tokens .token')).toHaveCount(1);
  await expect(drawer.locator('.tokens .token')).toContainText('@body:beam');
  await expect(drawer.locator('textarea')).toBeFocused();
});
