// #17: actual threaded wasm in Chromium, with server headers and the Pages COI worker.
import { test, expect, type Page } from './fixtures';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

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

test('@sw cold Pages bootstrap waits for real SW control and downloads only the threaded engine body', async ({ browser, request, baseURL }, testInfo) => {
  test.setTimeout(60_000);
  const origin = new URL(baseURL!).origin;
  type BodyReceipt = { file: string; bytes: number; gzip: number; sha256: string; completed: boolean };
  const status = async () => (await (await request.get(`${origin}/__femlab_test__/status`)).json()) as { pending: number; requests: BodyReceipt[] };
  await request.post(`${origin}/__femlab_test__/hold`);
  const context = await browser.newContext();
  const errors: string[] = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  try {
    await context.addInitScript(() => Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4 }));
    const page = await context.newPage();
    await page.goto(baseURL!, { waitUntil: 'commit' });
    // This handshake holds the actual script response at the headerless HTTP server. The
    // real browser registration stays pending; no service worker or engine is simulated.
    await expect.poll(async () => (await status()).pending).toBe(1);
    const before = await status();
    expect(before.requests.filter(body => /(?:session\.worker-[^/]+\.js|\.wasm)$/.test(body.file))).toEqual([]);
    await request.post(`${origin}/__femlab_test__/release`);
    await page.waitForFunction(() => crossOriginIsolated && window.fem !== undefined, undefined, { timeout: 30_000 });
    expect((await page.evaluate(() => window.fem.query.capabilities())).threads).toBe(4);
    const after = await status();
    const engineBodies = after.requests.filter(body => /femlab_engine_wasm_bg-[^/]+\.wasm$/.test(body.file));
    expect(engineBodies).toHaveLength(1);
    const expected = readFileSync('src/generated/wasm-threads/femlab_engine_wasm_bg.wasm');
    expect(engineBodies[0]!.sha256).toBe(createHash('sha256').update(expected).digest('hex'));
    expect(engineBodies[0]!.bytes).toBe(expected.length);
    expect(engineBodies[0]!.completed).toBe(true);
    // Same JS/CSS/document/engine budget as size-check, counting repeated response bodies
    // through both navigations instead of deduplicating URLs. Charge even interrupted
    // responses at their full size, giving a conservative upper bound on transferred bodies.
    const boot = after.requests.filter(body => /\.(?:js|css|html|wasm)$/.test(body.file));
    expect(boot.reduce((sum, body) => sum + body.gzip, 0)).toBeLessThanOrEqual(3 * 1024 * 1024);
    await testInfo.attach('cold-pages-network-bodies.json', { body: JSON.stringify({ before, after, fullResponseGzipUpperBound: boot.reduce((sum, body) => sum + body.gzip, 0) }), contentType: 'application/json' });
  } finally {
    await request.post(`${origin}/__femlab_test__/release`);
    await context.close();
    expect(errors).toEqual([]);
  }
});

test('@cpu capability information preserves solve blockers and Assistant alignment across viewports', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { value: undefined });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4 });
  });
  await page.goto('./');
  await solveBars(page);
  const notice = page.getByRole('status', { name: 'Engine capabilities', exact: true });
  await expect(notice).toContainText('so solves run on the CPU.');
  await expect(page.locator('.banner')).toHaveCount(0);
  for (const width of [1600, 1280, 1100]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => window.fem.dispatch({ cmd: 'panel.toggle', panel: 'assistant', open: true }));
    await expect(page.locator('.assistant')).toBeVisible();
    const drawer = (await page.locator('.assistant').boundingBox())!;
    const workspace = (await page.locator('.workspace').boundingBox())!;
    const status = (await notice.boundingBox())!;
    const viewport = (await page.locator('.comparison-canvases').boundingBox())!;
    expect(drawer.y).toBe(workspace.y);
    expect(drawer.height).toBe(workspace.height);
    expect(Number.isInteger(status.height)).toBe(true);
    expect(Number.isInteger(viewport.y)).toBe(true);
    expect(status.y + status.height).toBeLessThanOrEqual(viewport.y);
    expect(viewport.height).toBeGreaterThan(100);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await expect(notice).toBeVisible();
    await page.evaluate(() => window.fem.dispatch({ cmd: 'panel.toggle', panel: 'assistant', open: false }));
  }
  await testInfo.attach('capability-note-workspace.png', { body: await page.screenshot(), contentType: 'image/png' });
});
