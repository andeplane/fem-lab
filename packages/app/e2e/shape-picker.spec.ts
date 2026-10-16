import { expect, test, type Page } from './fixtures';

const field = (page: Page, path: string) => page.locator(`.props [data-field="${path}"]`);
const choices = (page: Page, path: string) => field(page, path).locator(':scope > .segmented');

/** Equal columns, complete borders and readable labels, including an incomplete last row. */
async function aligned(page: Page, path: string) {
  const grid = choices(page, path);
  const bounds = await grid.evaluate(el => {
    const group = el.getBoundingClientRect();
    const panel = el.closest('.props')!.getBoundingClientRect();
    const buttons = [...el.querySelectorAll('button')].map(button => {
      const r = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right,
        fitsText: button.scrollWidth <= button.clientWidth && button.scrollHeight <= button.clientHeight,
        border: style.borderRightWidth, label: button.textContent };
    });
    return { buttons, left: group.x, right: group.right, panelLeft: panel.x, panelRight: panel.right,
      overflow: el.closest('.props-body')!.scrollWidth - el.closest('.props-body')!.clientWidth };
  });
  expect(bounds.buttons.length).toBeGreaterThan(1);
  const width = bounds.buttons[0]!.width;
  for (const button of bounds.buttons) {
    expect(Math.abs(button.width - width), `${button.label} equal column width`).toBeLessThan(1);
    expect(button.x).toBeGreaterThanOrEqual(bounds.left - 0.5);
    expect(button.right).toBeLessThanOrEqual(bounds.right + 0.5);
    expect(button.height).toBeGreaterThanOrEqual(32);
    expect(button.fitsText, `${button.label} is readable`).toBe(true);
    expect(button.border).toBe('1px');
  }
  expect(bounds.left).toBeGreaterThan(bounds.panelLeft);
  expect(bounds.right).toBeLessThan(bounds.panelRight);
  expect(bounds.overflow).toBeLessThanOrEqual(1);
  return bounds;
}

async function start(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('femlab.tour.dismissed', '1');
    localStorage.setItem('femlab.autosave', 'off');
  });
  await page.goto('./');
  await page.waitForFunction(() => Boolean(window.fem));
  await page.evaluate(async () => {
    await window.fem.model.new({ name: 'aligned-shapes' });
    await window.fem.dispatch({ cmd: 'form.open', command: 'geometry.add', args: { name: 'pin' } });
  });
}

test('@cpu shape choices align at wide, narrow and mobile widths and keyboard edits create one Body', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await start(page);
  const kinds = choices(page, 'shape');
  await expect(kinds).toHaveAttribute('aria-label', 'Shape kind');
  await expect(kinds.locator('button')).toHaveCount(10);
  const measurements = [];
  for (const [width, panel] of [[1440, 440], [1440, 240], [390, 240]] as const) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(size => window.fem.dispatch({ cmd: 'panel.resize', panel: 'properties', size }), panel);
    await kinds.scrollIntoViewIfNeeded();
    measurements.push({ width, panel, ...await aligned(page, 'shape') });
    await page.screenshot({ path: info.outputPath(`shape-picker-${width}-${panel}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const before = await page.evaluate(() => window.fem.query.journal());
  const box = kinds.getByRole('button', { name: 'box', exact: true });
  const cylinder = kinds.getByRole('button', { name: 'cylinder', exact: true });
  const sphere = kinds.getByRole('button', { name: 'sphere', exact: true });
  await box.focus();
  await page.keyboard.press('Tab');
  await expect(cylinder).toBeFocused();
  expect(await cylinder.evaluate(el => el.matches(':focus-visible') && getComputedStyle(el).outlineStyle !== 'none')).toBe(true);
  await page.keyboard.press('Space');
  await expect(cylinder).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Tab');
  await expect(sphere).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(sphere).toHaveAttribute('aria-pressed', 'true');
  await expect(kinds.locator('[aria-pressed="true"]')).toHaveCount(1);
  expect(await page.evaluate(() => window.fem.query.journal()), 'picking kinds only changes the draft').toEqual(before);
  await cylinder.focus();
  await page.keyboard.press('Enter');
  await field(page, 'shape.radius').locator('input').fill('20 mm');
  await field(page, 'shape.height').locator('input').fill('100 mm');
  await page.locator('.props .apply').click();
  await expect.poll(() => page.evaluate(async () => (await window.fem.query.model()).bodies.map(body => body.name))).toEqual(['pin']);
  const after = await page.evaluate(() => window.fem.query.journal());
  expect(after.entries).toHaveLength(before.entries.length + 1);
  expect(after.entries.at(-1)?.cmd).toEqual({ cmd: 'geometry.add', name: 'pin', shape: { kind: 'cylinder', radius: '20 mm', height: '100 mm' } });
  await info.attach('shape-picker-bounds', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
});

test('@cpu nested shapes retain aligned controls and long schema choices wrap inside a narrow panel', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await start(page);
  await page.evaluate(async () => {
    await window.fem.dispatch({ cmd: 'panel.resize', panel: 'properties', size: 240 });
    await window.fem.dispatch({ cmd: 'form.open', command: 'geometry.add', args: {
      name: 'moved', shape: { kind: 'transform', shape: { kind: 'box' }, at: {} },
    } });
  });
  const inner = choices(page, 'shape.shape');
  await inner.getByRole('button', { name: 'sphere', exact: true }).click();
  await expect(choices(page, 'shape').getByRole('button', { name: 'transform', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(inner.getByRole('button', { name: 'sphere', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const outerBounds = await aligned(page, 'shape');
  const innerBounds = await aligned(page, 'shape.shape');
  expect(innerBounds.left).toBeGreaterThan(outerBounds.left);
  await field(page, 'shape.shape.radius').locator('input').fill('10 mm');
  await inner.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('nested-shape-picker-240.png') });
  await page.setViewportSize({ width: 390, height: 1000 });
  await inner.scrollIntoViewIfNeeded();
  await aligned(page, 'shape');
  await aligned(page, 'shape.shape');
  await page.screenshot({ path: info.outputPath('nested-shape-picker-mobile.png') });
  await page.locator('.props .apply').click();
  await expect.poll(() => page.evaluate(async () => (await window.fem.query.model()).bodies.map(body => body.name))).toEqual(['moved']);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => window.fem.dispatch({ cmd: 'panel.resize', panel: 'properties', size: 300 }));
  await page.evaluate(() => window.fem.dispatch({ cmd: 'form.open', command: 'step.add', args: { name: 'long-labels' } }));
  await field(page, 'procedure').scrollIntoViewIfNeeded();
  await aligned(page, 'procedure');
  const longChoice = choices(page, 'procedure').getByRole('button', { name: 'randomVibration', exact: true });
  await expect(longChoice).toBeVisible();
  expect(await longChoice.evaluate(el => {
    const range = document.createRange(); range.selectNodeContents(el);
    return range.getClientRects().length;
  }), 'a long schema label wraps instead of widening its column').toBeGreaterThan(1);
  await page.screenshot({ path: info.outputPath('long-schema-labels-300.png') });
  await page.goto('docs/geometry/');
  await expect(page.locator('article')).toContainText('use Tab to reach a choice and Space or Enter to select it');
});
