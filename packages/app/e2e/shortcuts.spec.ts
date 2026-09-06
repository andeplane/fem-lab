import { expect, test, type Page } from '@playwright/test';

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
  await page.waitForFunction(async () => Boolean(await window.fem.query.capabilities()), undefined, { timeout: 60_000 });
}

async function journalState(page: Page): Promise<unknown> {
  return page.evaluate(async () => {
    const journal = (await window.fem.query.journal()) as unknown as {
      revision: number;
      entries: { seq: number; cmd: unknown; hashAfter: string }[];
    };
    return { revision: journal.revision, entries: journal.entries };
  });
}

test.describe('@cpu global editing shortcuts', () => {
  test('keeps native text editing local and reserves undo/redo/copy for the workspace', async ({ page }) => {
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    const press = (key: string, shift = false): Promise<void> => page.keyboard.press(`${modifier}${shift ? '+Shift' : ''}+${key}`);
    await page.goto('./');
    await ready(page);
    await page.evaluate(async () => {
      await window.fem.model.new({ name: 'shortcut-regression' });
      await window.fem.geometry.addBox({ name: 'beam', size: ['1 m', '100 mm', '100 mm'] });
    });
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });

    const beforeText = await journalState(page);
    const input = page.locator('.workspace > .panel input').first();
    await expect(input).toBeVisible();
    const inputOriginal = await input.inputValue();
    await input.focus();
    await page.keyboard.type('x');
    await press('Z');
    expect(await input.inputValue()).toBe(inputOriginal);
    await input.selectText();
    await press('C');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(inputOriginal);
    expect(await journalState(page)).toEqual(beforeText);

    await page.getByRole('tab', { name: /script/ }).click();
    await page.getByRole('button', { name: 'edit this script' }).click();
    const textarea = page.locator('textarea.script-edit');
    await expect(textarea).toBeVisible();
    const textareaOriginal = await textarea.inputValue();
    await textarea.focus();
    await page.keyboard.press('End');
    await page.keyboard.type('x');
    await press('Z');
    expect(await textarea.inputValue()).toBe(textareaOriginal);
    await textarea.selectText();
    await press('C');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(textareaOriginal);
    expect(await journalState(page)).toEqual(beforeText);

    const editor = await page.evaluate(() => {
      const node = document.createElement('div');
      node.id = 'shortcut-contenteditable';
      node.contentEditable = 'true';
      node.textContent = 'editable';
      document.querySelector('.workspace')!.append(node);
      return node.id;
    });
    const contenteditable = page.locator(`#${editor}`);
    await contenteditable.click();
    await page.keyboard.type('x');
    await press('Z');
    expect(await contenteditable.textContent()).toBe('editable');
    await contenteditable.selectText();
    await press('C');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('editable');
    expect(await journalState(page)).toEqual(beforeText);

    await page.evaluate(() => window.fem.dispatch({ cmd: 'selection.set', bodies: ['beam'] }));
    await page.locator('.workspace').click({ position: { x: 10, y: 10 } });
    await press('Z');
    await expect.poll(async () => (await page.evaluate(() => window.fem.query.model())).revision).toBe(1);
    await press('Z', true);
    await expect.poll(async () => (await page.evaluate(() => window.fem.query.model())).revision).toBe(2);
    const beforeWorkspaceCopy = await journalState(page);
    await page.locator('.workspace').click({ position: { x: 10, y: 10 } });
    await press('C');
    expect(await journalState(page)).toEqual(beforeWorkspaceCopy);
  });
});
