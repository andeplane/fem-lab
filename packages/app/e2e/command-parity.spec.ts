import { expect, test } from '@playwright/test';

test('@cpu callable form picking and Assistant draft insertion reproduce UI state', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
  await page.goto('./');
  await page.waitForFunction(async () => typeof window.fem !== 'undefined' && Boolean(await window.fem.query.capabilities()));
  await page.evaluate(async () => {
    await window.fem.model.new({ name: 'command-parity' });
    await window.fem.dispatch({ cmd: 'form.open', command: 'constraint.fix', args: { name: 'root' } });
  });
  const journal = await page.evaluate(() => window.fem.query.journal());
  await page.getByRole('button', { name: 'pick in viewer' }).click();
  await expect(page.locator('.chip-pick')).toHaveClass(/armed/);
  await page.evaluate(async () => {
    await window.fem.dispatch({ cmd: 'selection.setPickTarget', target: 'off' });
    await window.fem.dispatch({ cmd: 'form.open', command: 'constraint.fix', args: { name: 'other' } });
    await window.fem.dispatch({ cmd: 'form.pick', command: 'constraint.fix', field: ['on'] });
  });
  await expect(page.locator('.chip-pick')).toHaveClass(/armed/);
  await page.evaluate(() => window.fem.dispatch({ cmd: 'chat.setDraft', text: '/beam' }));
  const draft = page.locator('.assistant .composer textarea');
  await expect(draft).toHaveValue('/beam');
  const skill = page.locator('.assistant [data-cmd="chat.setDraft"]').filter({ hasText: 'beam-theory-check' });
  await skill.click();
  await expect(draft).toHaveValue('/beam-theory-check ');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'chat.setDraft', text: '/convergence-study inspect this mesh' }));
  await expect(draft).toHaveValue('/convergence-study inspect this mesh');
  await expect(page.locator('.assistant .bubble')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.fem.query.journal())).toEqual(journal);
  expect(errors).toEqual([]);
});
