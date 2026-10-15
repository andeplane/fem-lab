import { expect, test, type Page } from './fixtures';

async function picture(page: Page) {
  return page.locator('.viewer:not(.comparison-pane)').evaluate(viewer => {
    const canvas = viewer.querySelector('canvas')!, box = canvas.getBoundingClientRect();
    const gl = canvas.getContext('webgl2')!, pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const legend = viewer.querySelector('.legend')?.getBoundingClientRect();
    const chrome = viewer.querySelector('.viewer-chrome')!.getBoundingClientRect();
    const deformation = viewer.querySelector('.deform-bar')?.getBoundingClientRect();
    const safe = { left: box.left + 12, right: legend ? legend.left - 12 : box.right - 12,
      top: chrome.bottom + 12, bottom: deformation ? deformation.top - 12 : box.bottom - 36 };
    let count = 0, obscuredByLegend = 0, outsideSafe = 0;
    const bounds = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
    let legendHit: { x: number; y: number; tag: string | undefined } | null = null;
    for (let i = 0; i < pixels.length; i += 4) {
      // Grid, axes, supports and loads are disabled. Read actual coloured body fragments.
      const rgb = [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!];
      if (Math.max(...rgb) <= 65 || Math.max(...rgb) - Math.min(...rgb) <= 25) continue;
      const x = box.left + (i / 4 % canvas.width + 0.5) * box.width / canvas.width;
      const y = box.top + (canvas.height - 1 - Math.floor(i / 4 / canvas.width) + 0.5) * box.height / canvas.height;
      count++; bounds.left = Math.min(bounds.left, x); bounds.right = Math.max(bounds.right, x);
      bounds.top = Math.min(bounds.top, y); bounds.bottom = Math.max(bounds.bottom, y);
      if (x < safe.left || x > safe.right || y < safe.top || y > safe.bottom) outsideSafe++;
      if (legend && x >= legend.left && x <= legend.right && y >= legend.top && y <= legend.bottom) {
        obscuredByLegend++;
        if (!legendHit) legendHit = { x, y, tag: document.elementFromPoint(x, y)?.closest('.legend')?.className };
      }
    }
    const centre = { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 };
    return { count, obscuredByLegend, outsideSafe, bounds, safe, legendHit,
      bodyCentreHitsCanvas: document.elementFromPoint(centre.x, centre.y) === canvas,
      canvas: { x: box.x, y: box.y, width: box.width, height: box.height } };
  });
}

test('@cpu explicit Fit keeps result pixels and picks clear of viewer chrome without refitting on resize', async ({ page }, info) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => { localStorage.setItem('femlab.tour.dismissed', '1'); localStorage.setItem('femlab.autosave', 'off'); });
  await page.goto('./'); await page.waitForFunction(() => Boolean(window.fem));
  await page.evaluate(async () => {
    await window.fem.dispatch({ cmd: 'file.openExample', name: 'cantilever' });
    await window.fem.dispatch({ cmd: 'view.showField', field: 'displacement', component: 2 });
    await window.fem.dispatch({ cmd: 'view.setDeformScale', scale: 0 });
    for (const layer of ['grid', 'axes', 'loads', 'constraints', 'sets']) await window.fem.dispatch({ cmd: 'view.toggle', layer, on: false });
  });
  await expect(page.locator('.legend')).toBeVisible();
  const journal = await page.evaluate(() => window.fem.query.journal());
  for (const projection of ['perspective', 'orthographic']) {
    await page.evaluate(projection => window.fem.dispatch({ cmd: 'view.setProjection', projection }), projection);
    for (const width of [1600, 1180, 1600]) {
      const beforeResize = await page.evaluate(() => window.fem.registry.query({ query: 'query.view' }));
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(await page.evaluate(() => window.fem.registry.query({ query: 'query.view' }))).toEqual(beforeResize);
      await page.evaluate(() => window.fem.dispatch({ cmd: 'view.fit' }));
      const actual = await picture(page);
      await info.attach(`${projection}-${width}-pixels`, { body: JSON.stringify(actual, null, 2), contentType: 'application/json' });
      await info.attach(`${projection}-${width}`, { body: await page.screenshot(), contentType: 'image/png' });
      expect(actual.count).toBeGreaterThan(1000);
      expect(actual.obscuredByLegend).toBe(0); expect(actual.outsideSafe).toBe(0);
      expect(actual.bodyCentreHitsCanvas).toBe(true);
      const pose = await page.evaluate(() => window.fem.registry.query({ query: 'query.view' }));
      await page.evaluate(pose => window.fem.dispatch({ cmd: 'view.setCamera', ...pose as object }), pose);
      const restored = await picture(page); expect(restored.bounds).toEqual(actual.bounds);
    }
  }
  expect(await page.evaluate(() => window.fem.query.journal())).toEqual(journal);
});
