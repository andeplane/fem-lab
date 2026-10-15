// #17: actual threaded wasm in Chromium, with server headers and the Pages COI worker.
import { test, expect, type Page } from './fixtures';

async function solveBars(page: Page) {
  await page.waitForFunction(() => window.fem !== undefined, undefined, { timeout: 60_000 });
  return page.evaluate(async () => {
    const capabilities = await window.fem.query.capabilities();
    const cases = [];
    for (const divisions of [2, 4, 8]) {
      await window.fem.model.new({ name: 'threaded axial bar' });
      await window.fem.geometry.addBox({ name: 'bar', size: ['1 m', '0.1 m', '0.1 m'] });
      await window.fem.material.add({ name: 'steel', E: '200 GPa', nu: 0 });
      await window.fem.material.assign({ material: 'steel', bodies: ['bar'] });
      await window.fem.mesh.set({ mesher: { kind: 'lattice', size: { nx: divisions, ny: 1, nz: 1 } }, order: 1, formulation: 'full' });
      await window.fem.constraint.fix({ name: 'root', on: 'bar.xmin' });
      await window.fem.load.traction({ name: 'tip', on: 'bar.xmax', total: ['1000 N', '0 N', '0 N'] });
      await window.fem.step.add({ name: 'axial', procedure: 'static', constraints: ['root'], loads: ['tip'] });
      await window.fem.solve.run({ step: 'axial', solver: 'cpu-direct' });
      const fields = await Promise.all((['displacement', 'stress', 'reaction'] as const).map(field => window.fem.query.field({ field })));
      const displacement = fields[0]!;
      const reaction = fields[2]!;
      cases.push({
        divisions,
        hashes: (await window.fem.query.journal()).entries.map(entry => entry.hashAfter),
        mesh: await window.fem.query.mesh(),
        // Preserve even the sign bit of zero across the browser/Playwright JSON boundary.
        fields: fields.map(({ values, ...metadata }) => ({ metadata, bits: Array.from(new Uint8Array(new Float64Array(values).buffer)) })),
        tip: Math.max(...displacement.values.filter((_, i) => i % 3 === 0)),
        axialStress: fields[1]!.values.filter((_, i) => i % 6 === 0),
        finite: fields.every(field => field.values.every(Number.isFinite)),
        reaction: reaction.values.filter((_, i) => i % 3 === 0).reduce((a, b) => a + b, 0),
      });
    }
    return { capabilities, cases };
  });
}

test('@cpu @sw browser CPU results and Journal hashes are exact at one and four real workers', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  const outputs = [];
  const lifecycles = [];
  for (const threads of [1, 4]) {
    const context = await browser.newContext();
    const pageErrors: string[] = [];
    context.on('page', page => page.on('pageerror', error => pageErrors.push(error.message)));
    const cdp = await browser.newBrowserCDPSession();
    const workers = new Map<string, string>();
    const destroyed = new Set<string>();
    const remember = ({ targetInfo }: { targetInfo: { type: string; targetId: string; url: string } }) => {
      if (targetInfo.type === 'worker') workers.set(targetInfo.targetId, targetInfo.url);
    };
    cdp.on('Target.targetCreated', remember);
    cdp.on('Target.targetInfoChanged', remember);
    cdp.on('Target.targetDestroyed', ({ targetId }) => destroyed.add(targetId));
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    let owned: [string, string][] = [];
    try {
      await context.addInitScript(count => Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => count }), threads);
      const page = await context.newPage();
      await page.goto(baseURL!);
      await page.waitForFunction(() => crossOriginIsolated, undefined, { timeout: 60_000 });
      const output = await solveBars(page);
      expect(output.capabilities.threads).toBe(threads);
      for (const bar of output.cases) {
        expect(bar.mesh.elements).toBe(bar.divisions);
        expect(bar.finite).toBe(true);
        expect(bar.axialStress.length).toBeGreaterThan(0);
        for (const stress of bar.axialStress) expect(Math.abs(stress - 100000)).toBeLessThan(1e-7);
        // Closed form F L / EA = 5e-7 m; support reaction is -F, at all three grids.
        expect(Math.abs(bar.tip - 5e-7)).toBeLessThan(1e-18);
        expect(Math.abs(bar.reaction + 1000)).toBeLessThan(1e-8);
      }
      outputs.push(output);
      const active = () => [...workers].filter(([id]) => !destroyed.has(id));
      await expect.poll(() => active().filter(([, url]) => /workerHelpers-[^/]+\.js$/.test(url)).length).toBe(threads);
      owned = [...workers].filter(([, url]) => /(?:session\.worker|workerHelpers)-[^/]+\.js$/.test(url));
      expect(active().filter(([, url]) => /session\.worker-/.test(url))).toHaveLength(1);
      expect(active().filter(([, url]) => /(?:session\.worker|workerHelpers)-[^/]+\.js$/.test(url))).toHaveLength(threads + 1);
    } finally {
      try {
        await context.close();
        expect(pageErrors, 'uncaught page errors in the owned context').toEqual([]);
        await expect.poll(() => owned.filter(([id]) => !destroyed.has(id)).length).toBe(0);
        lifecycles.push({ threads, workers: owned.map(([id, url]) => ({ id, url, destroyed: destroyed.has(id) })) });
      } finally { await cdp.detach(); }
    }
  }
  expect(outputs[1]!.cases).toEqual(outputs[0]!.cases);
  await testInfo.attach('browser-thread-determinism.json', { body: JSON.stringify(outputs), contentType: 'application/json' });
  await testInfo.attach('browser-thread-lifecycle.json', { body: JSON.stringify(lifecycles), contentType: 'application/json' });
});

test('@cpu browser without cross-origin isolation runs honestly on one CPU thread', async ({ browser, baseURL }, testInfo) => {
  const context = await browser.newContext();
  const pageErrors: string[] = [];
  context.on('page', page => page.on('pageerror', error => pageErrors.push(error.message)));
  try {
    // Headerless origin with service workers unavailable exercises the real portable runtime.
    const url = new URL(baseURL!); url.port = String(Number(url.port) + 7);
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'serviceWorker', { value: undefined });
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4 });
    });
    const page = await context.newPage();
    await page.goto(url.href);
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);
    const output = await solveBars(page);
    expect(output.capabilities.threads).toBe(1);
    await expect(page.getByText('Running single-threaded; open in Chrome and reload to enable threads.', { exact: true })).toBeVisible();
    await testInfo.attach('single-thread-capability-note.png', { body: await page.getByRole('status').screenshot(), contentType: 'image/png' });
  } finally { await context.close(); expect(pageErrors, 'uncaught page errors in the owned context').toEqual([]); }
});
