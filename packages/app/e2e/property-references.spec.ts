import { expect, test } from './fixtures';

test('@cpu Properties references insert chips for the edited object', async ({ page }) => {
  await page.setViewportSize({ width: 1720, height: 1000 });
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined');
  await page.evaluate(async () => {
    await window.fem.dispatch({ cmd: 'project.new', name: 'property-references' });
    await window.fem.geometry.addBox({ name: 'beam', size: ['1 m', '100 mm', '100 mm'] });
    await window.fem.material.add({ name: 'steel', E: '210 GPa', nu: 0.3 });
    await window.fem.dispatch({ cmd: 'panel.toggle', panel: 'assistant', open: true });
  });
  await expect(page.locator('.assistant')).toBeVisible();
  for (const [kind, name] of [['body', 'beam'], ['material', 'steel']] as const) {
    await page.evaluate(async ({ kind, name }) => {
      await window.fem.dispatch({ cmd: 'form.edit', kind, name });
    }, { kind, name });
    await page.locator('.props .prop-name [data-cmd="chat.insertMention"]').click();
    await expect(page.locator('.assistant .tokens')).toContainText(`@${kind}:${name}`);
  }
  await expect(page.locator('.assistant .tokens .token')).toHaveCount(2);
});
