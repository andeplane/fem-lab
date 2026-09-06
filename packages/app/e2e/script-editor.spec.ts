// Design brief §5.5: the Script is a real TypeScript editor with an aligned line-number
// gutter, highlighted tokens, normal editing shortcuts, registry-backed run/stop and a draft
// that survives looking back at the live Journal.
import { expect, test, type Locator, type Page } from '@playwright/test';

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
  await page.waitForFunction(async () => Boolean(await window.fem.query.capabilities()), undefined, { timeout: 60_000 });
}

async function replace(editor: Locator, page: Page, text: string): Promise<void> {
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(text);
}

test.describe('@cpu Script editor', () => {
  test('edits, highlights, preserves, runs and stops TypeScript with native keyboard behaviour', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
    await page.goto('./');
    await ready(page);
    await page.evaluate(async () => {
      await window.fem.model.new({ name: 'script-editor' });
      await window.fem.geometry.addBox({ name: 'seed', size: ['1 m', '1 m', '1 m'] });
      await window.fem.registry.dispatch({ cmd: 'selection.set', bodies: ['seed'] });
    });
    await page.locator('.tab', { hasText: 'script' }).click();
    await page.getByRole('button', { name: 'edit this script' }).click();

    const editor = page.locator('.script-edit');
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    const draft = 'const marker: string = "draft";\n// keep me\nreturn marker;';
    await replace(editor, page, draft);
    await expect(page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: '3' })).toBeVisible();
    const colours = await page.locator('.cm-line').first().locator('span').evaluateAll((spans) => [...new Set(spans.map((span) => getComputedStyle(span).color))]);
    expect(colours.length).toBeGreaterThan(1);

    // A selected Model object makes the app-level ⌘C route tempting; focus keeps copy and undo
    // inside the editor instead.
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('ControlOrMeta+c');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(draft);
    await page.keyboard.press('End');
    await page.keyboard.insertText('x');
    await page.keyboard.press('ControlOrMeta+z');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('ControlOrMeta+c');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(draft);

    await page.getByRole('button', { name: 'insert current Journal' }).click();
    await expect(editor).toContainText('fem.geometry.addBox');
    await page.getByRole('button', { name: 'view the Journal' }).click();
    await expect(page.locator('.script-view')).toContainText('fem.model.new');
    await expect(page.locator('.script-view')).not.toContainText('keep me');
    await page.getByRole('button', { name: 'resume draft' }).click();
    await expect(editor).toContainText('keep me');
    await expect(editor).toContainText('fem.geometry.addBox');

    const long = Array.from({ length: 80 }, (_, index) => `const line${index + 1}: number = ${index + 1};`).join('\n');
    await replace(editor, page, long);
    await page.keyboard.press('ControlOrMeta+End');
    const line80 = page.locator('.cm-line').last();
    const gutter80 = page.locator('.cm-lineNumbers .cm-gutterElement').filter({ hasText: /^80$/ });
    await line80.scrollIntoViewIfNeeded();
    const [lineBox, gutterBox] = await Promise.all([line80.boundingBox(), gutter80.boundingBox()]);
    expect(Math.abs(lineBox!.y - gutterBox!.y)).toBeLessThan(1);

    await replace(editor, page, 'const value: number = 1;\nthrow new Error("boom");');
    await page.getByRole('button', { name: 'Run script' }).click();
    await expect(page.locator('.script-out')).toContainText('boom (line 2)', { timeout: 30_000 });

    await replace(editor, page, 'await fem.geometry.addBox({ name: "fromEditor", size: ["2 m", "1 m", "1 m"] });');
    await page.getByRole('button', { name: 'Run script' }).click();
    await expect(page.locator('.tree .name', { hasText: 'fromEditor' })).toBeVisible({ timeout: 30_000 });

    await replace(editor, page, 'await new Promise(() => undefined);');
    await page.getByRole('button', { name: 'Run script' }).click();
    await expect(page.getByRole('button', { name: 'Stop' })).toBeEnabled();
    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(page.locator('.script-out')).toContainText('stopped');

    await page.locator('.tab', { hasText: 'journal' }).click();
    await expect(page.locator('.jrow').last()).toContainText('ai');
  });
});
