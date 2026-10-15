import { expect, test, type Page } from './fixtures';

const camera = (page: Page) => page.evaluate(() => window.fem.registry.query({ query: 'query.view' }));
const rounded = (value: unknown) => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'number' ? Number(v.toPrecision(12)) : v));

async function contained(page: Page) {
  const bounds = await page.evaluate(() => {
    const rect = (selector: string) => {
      const r = document.querySelector(selector)!.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    const input = document.querySelector<HTMLInputElement>('.props [data-field="name"] input')!;
    const box = input.getBoundingClientRect();
    return {
      centre: rect('.centre'), content: rect('.result-workspace'), viewer: rect('.viewer'),
      canvas: rect('.viewer canvas'), bottom: rect('.bottom'), tabs: rect('.tabs'),
      props: rect('.workspace > .props'), input: rect('.props [data-field="name"] input'),
      legend: rect('.legend'), inputOwnsLeftEdge: document.elementFromPoint(box.x + 5, box.y + box.height / 2) === input,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  for (const key of ['content', 'viewer', 'canvas', 'bottom', 'tabs'] as const) {
    expect(bounds[key].x, `${key} left`).toBeGreaterThanOrEqual(bounds.centre.x);
    expect(bounds[key].right, `${key} right`).toBeLessThanOrEqual(bounds.centre.right + 0.5);
  }
  expect(bounds.legend.right).toBeLessThanOrEqual(bounds.viewer.right);
  expect(bounds.input.x).toBeGreaterThan(bounds.props.x);
  expect(bounds.input.right).toBeLessThan(bounds.props.right);
  expect(bounds.inputOwnsLeftEdge, 'Properties input is not covered by the Viewer or legend').toBe(true);
  expect(bounds.documentWidth).toBeLessThanOrEqual(page.viewportSize()!.width);
  await expect.poll(() => page.locator('.viewer canvas').evaluate(el => {
    const c = el as HTMLCanvasElement, scale = Math.min(devicePixelRatio, 2);
    return [c.width - Math.round(c.clientWidth * scale), c.height - Math.round(c.clientHeight * scale)];
  })).toEqual([0, 0]);
  return bounds;
}

test('@cpu solved workspace keeps Properties and every bottom action usable through desktop resizing', async ({ page }, info) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => { localStorage.setItem('femlab.tour.dismissed', '1'); localStorage.setItem('femlab.autosave', 'off'); });
  await page.goto('./'); await page.waitForFunction(() => Boolean(window.fem));
  await page.evaluate(async () => {
    await window.fem.dispatch({ cmd: 'file.openExample', name: 'cantilever' });
    await window.fem.dispatch({ cmd: 'view.showField', field: 'vonMises', component: 0 });
    await window.fem.dispatch({ cmd: 'view.setDeformScale', scale: 0 });
    await window.fem.dispatch({ cmd: 'view.fit' });
  });
  const viewer = (await page.locator('.viewer canvas').boundingBox())!;
  await page.mouse.click(viewer.x + viewer.width / 2, viewer.y + viewer.height / 2);
  await expect(page.locator('.probe')).toContainText('MPa');
  await page.locator('.chip-add', { hasText: '+ add body' }).click();
  await page.locator('.add-menu [data-cmd]', { hasText: 'box' }).first().click();
  const journal = await page.evaluate(() => window.fem.query.journal());
  const model = await page.evaluate(() => window.fem.query.model());
  const originalCamera = rounded(await camera(page));
  const measurements = [];
  for (const [index, width] of [1600, 1180, 1600].entries()) {
    await page.setViewportSize({ width, height: 1000 });
    measurements.push({ width, bounds: await contained(page) });
    expect(rounded(await camera(page)), 'resize preserves the chosen camera').toEqual(originalCamera);
    for (const tab of ['journal', 'history', 'script', 'results', 'checks', 'console']) {
      const control = page.locator(`.tabs [title="panel.toggle ${tab}"]`);
      await control.click(); await expect(control).toHaveAttribute('aria-selected', 'true');
      await contained(page);
    }
    const controls = page.locator('.tabs button');
    await controls.first().focus();
    for (let i = 1; i < await controls.count(); i++) {
      await page.keyboard.press('Tab'); await expect(controls.nth(i)).toBeFocused();
      const visible = await controls.nth(i).evaluate(el => {
        const r = el.getBoundingClientRect(), row = el.parentElement!.getBoundingClientRect();
        const style = getComputedStyle(el), outside = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
        return { fits: r.x - outside >= row.x && r.right + outside <= row.right && r.y - outside >= row.y && r.bottom + outside <= row.bottom
          && el.matches(':focus-visible') && style.outlineStyle !== 'none', x: r.x, right: r.right, y: r.y, bottom: r.bottom,
          row: { x: row.x, right: row.right, y: row.y, bottom: row.bottom }, outside, text: el.textContent };
      });
      expect(visible.fits, `keyboard focus scrolls every action into the row: ${JSON.stringify(visible)}`).toBe(true);
    }
    expect(await page.evaluate(() => [scrollX, scrollY])).toEqual([0, 0]);
    await page.screenshot({ path: info.outputPath(`workspace-${index}-${width}.png`) });
  }
  expect(await page.evaluate(() => window.fem.query.journal())).toEqual(journal);
  expect(await page.evaluate(() => window.fem.query.model())).toEqual(model);
  await page.setViewportSize({ width: 1180, height: 1000 });
  await contained(page);
  await expect(page.locator('.tabs [data-cmd="clipboard.copy"]')).toHaveCount(1);
  const download = page.waitForEvent('download');
  await page.locator('.tabs [data-cmd="file.export"]').click();
  expect((await download).suggestedFilename()).toMatch(/\.ts$/);
  await page.locator('.props [data-field="name"] input').fill('narrow-body');
  const size = page.locator('.props [data-field="size"] input');
  for (const [i, value] of ['1 m', '100 mm', '100 mm'].entries()) await size.nth(i).fill(value);
  await page.locator('.props .apply').click();
  await expect.poll(() => page.evaluate(async () => (await window.fem.query.model()).bodies.map(b => b.name))).toContain('narrow-body');
  const after = await page.evaluate(() => window.fem.query.journal());
  expect(after.entries).toHaveLength(journal.entries.length + 1);
  expect(after.entries.slice(0, journal.entries.length)).toEqual(journal.entries);
  expect(after.entries.at(-1)?.cmd.cmd).toBe('geometry.addBox');
  expect(rounded(await camera(page)), 'Properties Apply does not refit the camera').toEqual(originalCamera);
  await page.evaluate(async () => {
    for (const layer of ['grid', 'axes']) await window.fem.dispatch({ cmd: 'view.toggle', layer, on: false });
    await window.fem.dispatch({ cmd: 'view.fit' });
  });
  await contained(page);
  const body = await page.locator('.viewer canvas').evaluate(el => {
    const c = el as HTMLCanvasElement, gl = c.getContext('webgl2')!, pixels = new Uint8Array(c.width * c.height * 4);
    gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let count = 0, minX = c.width, minY = c.height, maxX = -1, maxY = -1;
    for (let i = 0; i < pixels.length; i += 4) if (Math.max(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!) > 65) {
      const x = i / 4 % c.width, y = Math.floor(i / 4 / c.width);
      count++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    return { count, minX, maxX, minY, maxY, width: c.width, height: c.height };
  });
  expect(body.count).toBeGreaterThan(100);
  expect(body.maxX - body.minX).toBeGreaterThan(10); expect(body.maxY - body.minY).toBeGreaterThan(10);
  expect(body.minX).toBeGreaterThan(2); expect(body.maxX).toBeLessThan(body.width - 2);
  expect(body.minY).toBeGreaterThan(2); expect(body.maxY).toBeLessThan(body.height - 2);
  await page.screenshot({ path: info.outputPath('1180-explicit-fit.png') });
  await info.attach('nested-layout-bounds', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
  await info.attach('explicit-fit-body-pixels', { body: JSON.stringify(body), contentType: 'application/json' });
});
