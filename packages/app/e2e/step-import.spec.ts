import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ModelSummary } from '@femlab/registry';
import { expect, test, type Page } from './fixtures';
const fixture = (name: string) => path.join(import.meta.dirname, '../test/fixtures/step', name);
const q = (page: Page, query: string) => page.evaluate(query => window.fem.registry.query({ query }), query);
async function start(page: Page) {
  await page.setViewportSize({ width: 1800, height: 1100 });
  await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
  await page.goto('./'); await page.waitForFunction(() => typeof window.fem !== 'undefined');
  await page.evaluate(() => window.fem.registry.dispatch({ cmd: 'file.autosave', on: false }));
}
async function choose(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }, name = 'cad', linear = '1 mm', angular = '15 deg') {
  await page.getByTitle('Import STEP geometry', { exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import STEP geometry', exact: true });
  await dialog.getByLabel('Body name', { exact: true }).fill(name);
  await dialog.getByLabel('Absolute linear deflection').fill(linear);
  await dialog.getByLabel('Angular deflection').fill(angular);
  const picker = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Choose STEP file and import', exact: true }).click();
  await (await picker).setFiles(file);
  return dialog;
}
async function checkedState(page: Page) {
  return page.evaluate(async () => ({ document: await window.fem.registry.query({ query: 'query.document' }), journal: await window.fem.registry.query({ query: 'query.journal' }), catalogue: await window.fem.registry.query({ query: 'query.results' }), project: await window.fem.registry.query({ query: 'query.project' }) }));
}
async function visibleBody(page: Page) {
  // Physical queries can pass while a millimeter Body is wholly behind the perspective
  // near plane (#620). Inspect the actual WebGL drawing buffer, excluding colored axes
  // and the dark grid/background; DOM labels and a nonempty Mesh cannot satisfy this.
  await expect.poll(async () => page.locator('.viewer canvas').evaluate(element => {
    const canvas = element as HTMLCanvasElement; const gl = canvas.getContext('webgl2')!;
    const rgba = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    let xmin = canvas.width, xmax = -1, ymin = canvas.height, ymax = -1;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const offset = (y * canvas.width + x) * 4;
      const channels = [rgba[offset]!, rgba[offset + 1]!, rgba[offset + 2]!];
      if (Math.min(...channels) > 65 && Math.max(...channels) - Math.min(...channels) < 32) {
        xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
      }
    }
    return xmin > 0 && ymin > 0 && xmax < canvas.width - 1 && ymax < canvas.height - 1
      && (xmax - xmin + 1) / canvas.width > 0.2 && (ymax - ymin + 1) / canvas.height > 0.2;
  })).toBe(true);
}
test('@cpu @sw STEP is truly lazy, imports declared units, names a durable face, meshes, and re-imports a curved Body', async ({ page }, info) => {
  test.setTimeout(120_000);
  const requests: string[] = []; page.on('request', request => requests.push(request.url()));
  await start(page);
  expect(requests.filter(url => url.includes('step-converter') || /step\.worker/.test(url))).toEqual([]);
  await choose(page, fixture('analytic-box-mm.step'), 'cad', '0.001 mm', '15 deg');
  const report = page.getByRole('dialog', { name: 'STEP import report', exact: true });
  await expect(report).toBeVisible(); await expect(report).toContainText('6 faces'); await expect(report).toContainText('Output: meters');
  expect(requests.some(url => url.includes('step-converter/occt-import-js.js'))).toBe(true);
  expect(requests.some(url => url.includes('step-converter/occt-import-js.wasm'))).toBe(true);
  expect(requests.some(url => url.includes('corresponding-source.tar.gz'))).toBe(false);
  const model = await q(page, 'query.model') as ModelSummary;
  model.bodies[0]!.bbox.forEach((value, i) => expect(Math.abs(value.value - [0, 0, 0, 0.001, 0.002, 0.003][i]!)).toBeLessThan(1e-14));
  expect(model.bodies[0]!.measure.value).toBeCloseTo(6e-9, 18);
  await report.getByTitle('Close STEP report', { exact: true }).click();
  await page.evaluate(async () => {
    await window.fem.dispatch({ cmd: 'material.add', name: 'solid', E: '1 MPa', nu: 0.25 });
    await window.fem.dispatch({ cmd: 'material.assign', material: 'solid', bodies: ['cad'] });
    await window.fem.dispatch({ cmd: 'geometry.nameFace', name: 'base', of: 'cad', where: { kind: 'plane', normal: [0, 0, 1], offset: '0 m', tol: '0.0000001 m' } });
    await window.fem.dispatch({ cmd: 'mesh.set', mesher: { kind: 'lattice', size: '0.5 mm' } });
    await window.fem.dispatch({ cmd: 'view.fit' });
  });
  const mesh = await q(page, 'query.mesh') as { elements: number };
  expect(mesh.elements).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.fem.query.set({ name: 'base' }))).toMatchObject({ kind: 'face', count: expect.any(Number) });
  expect((await page.evaluate(() => window.fem.query.set({ name: 'base' }))).count).toBeGreaterThan(0);
  await expect(page.locator('aside.tree')).toContainText('cad');
  await visibleBody(page);
  await page.screenshot({ path: info.outputPath('step-box-import-to-mesh.png') });
  // Re-import carries triangles in meters and retains the existing Material/face rule.
  // Change mesh size first: retaining the millimeter mesh for a meter cylinder would be huge.
  await page.evaluate(() => window.fem.dispatch({ cmd: 'mesh.set', mesher: { kind: 'lattice', size: '0.5 m' } }));
  await choose(page, fixture('analytic-cylinder-m.step'), 'cad', '6.25 mm', '180 deg');
  await expect(report).toBeVisible(); await expect(report).toContainText('3 faces');
  const curve = await q(page, 'query.model') as ModelSummary;
  expect(curve.bodies).toHaveLength(1); expect(curve.bodies[0]!.material).toBe('solid');
  expect(Math.abs(curve.bodies[0]!.measure.value - 2 * Math.PI)).toBeLessThan(2 * Math.PI * (2 * 0.00625 - 0.00625 ** 2) + 1e-7);
  await report.getByTitle('Close STEP report', { exact: true }).click();
  expect((await q(page, 'query.mesh') as { elements: number }).elements).toBeGreaterThan(0);
  expect((await page.evaluate(() => window.fem.query.set({ name: 'base' }))).count).toBeGreaterThan(0);
  await page.evaluate(() => window.fem.dispatch({ cmd: 'view.fit' }));
  await visibleBody(page);
  // This is the retained coarse 0.5 m lattice boundary, intentionally visibly stepped;
  // the source-cylinder measurement/refinement oracle lives in test-step-import.mjs.
  await page.screenshot({ path: info.outputPath('step-cylinder-import-to-mesh.png') });
});

test('@cpu STEP cancellation terminates a real loading Worker and refuses a second pending import', async ({ page }) => {
  test.setTimeout(120_000);
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  let requested!: () => void; const fetching = new Promise<void>(resolve => { requested = resolve; });
  let cancelled = false; let closed = false;
  page.on('worker', worker => { if (/step\.worker/.test(worker.url())) worker.on('close', () => { closed = true; }); });
  const bytes = readFileSync(path.join(import.meta.dirname, '../../../vendor/step-converter/dist/occt-import-js.wasm'));
  await page.route('**/third-party/step-converter/occt-import-js.wasm', async route => {
    requested(); await blocked;
    try { await route.fulfill({ contentType: 'application/wasm', body: bytes }); }
    catch (error) { if (!cancelled) throw error; }
  });
  await start(page); const before = await checkedState(page);
  const dialog = await choose(page, fixture('analytic-box-m.step'));
  await fetching;
  expect(await page.evaluate(async () => {
    try { await window.fem.registry.dispatch({ cmd: 'geometry.importStep', name: 'second', linearDeflection: '1 mm', angularDeflection: '15 deg' }); return null; }
    catch (error) { return (error as { code: string }).code; }
  })).toBe('session.conflict');
  cancelled = true; await dialog.getByRole('button', { name: 'Cancel STEP import', exact: true }).click();
  await expect.poll(() => closed).toBe(true);
  await expect(dialog.getByRole('alert')).toContainText('cancelled');
  release();
  expect(await checkedState(page)).toEqual(before);
});

test('@cpu malformed and stale STEP conversions cannot publish over an edited or replaced project', async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      if (this.name !== 'late.step') return read.call(this);
      return new Promise<ArrayBuffer>(resolve => { (window as unknown as { releaseStepRead(): Promise<void> }).releaseStepRead = async () => resolve(await read.call(this)); });
    };
  });
  await start(page); const before = await checkedState(page);
  let dialog = await choose(page, { name: 'broken.step', mimeType: 'model/step', buffer: Buffer.from('not a STEP document') });
  await expect(dialog.getByRole('alert')).toContainText('STEP_');
  expect(await checkedState(page)).toEqual(before);
  await dialog.getByTitle('Close STEP import').click();
  dialog = await choose(page, { name: 'late.step', mimeType: 'model/step', buffer: readFileSync(fixture('analytic-box-m.step')) });
  await page.waitForFunction(() => 'releaseStepRead' in window);
  await page.evaluate(() => window.fem.dispatch({ cmd: 'geometry.addBox', name: 'intervening', size: ['1 m', '1 m', '1 m'] }));
  const edited = await checkedState(page);
  await page.evaluate(() => (window as unknown as { releaseStepRead(): Promise<void> }).releaseStepRead());
  await expect(dialog.getByRole('alert')).toContainText('session.conflict');
  expect(await checkedState(page)).toEqual(edited);
  await dialog.getByTitle('Close STEP import').click();
  await page.evaluate(() => { delete (window as unknown as { releaseStepRead?: () => Promise<void> }).releaseStepRead; });
  await choose(page, { name: 'late.step', mimeType: 'model/step', buffer: readFileSync(fixture('analytic-box-m.step')) });
  await page.waitForFunction(() => 'releaseStepRead' in window);
  await page.evaluate(() => window.fem.dispatch({ cmd: 'project.new', name: 'replacement' }));
  const replacement = await checkedState(page);
  await page.evaluate(async () => { await (window as unknown as { releaseStepRead(): Promise<void> }).releaseStepRead(); await Promise.resolve(); });
  expect(await checkedState(page)).toEqual(replacement);
});

test('@cpu STEP receipt and solved long-name header fit with native keyboard access', async ({ page }, info) => {
  test.setTimeout(120_000);
  await start(page);
  await choose(page, fixture('analytic-box-m.step'));
  const receipt = page.getByRole('dialog', { name: 'STEP import report', exact: true });
  await expect(receipt).toBeVisible();
  await receipt.getByTitle('Close STEP report', { exact: true }).click();
  const longName = 'Very_long_structural_model_revision_2026_final';
  await page.evaluate(async name => {
    await window.fem.dispatch({ cmd: 'model.setName', name });
    await window.fem.dispatch({ cmd: 'material.add', name: 'solid', E: '1 MPa', nu: 0.25 });
    await window.fem.dispatch({ cmd: 'material.assign', material: 'solid', bodies: ['cad'] });
    for (const [name, offset] of [['base', '0 m'], ['top', '3 m']]) await window.fem.dispatch({ cmd: 'geometry.nameFace', name, of: 'cad', where: { kind: 'plane', normal: [0, 0, 1], offset, tol: '0.0000001 m' } });
    await window.fem.dispatch({ cmd: 'mesh.set', mesher: { kind: 'lattice', size: '0.5 m' } });
    await window.fem.dispatch({ cmd: 'constraint.fix', name: 'root', on: 'base' });
    await window.fem.dispatch({ cmd: 'load.traction', name: 'push', on: 'top', total: ['0 N', '0 N', '-1 N'] });
    await window.fem.dispatch({ cmd: 'step.add', name: 'static', procedure: 'static', constraints: ['root'], loads: ['push'] });
    await window.fem.dispatch({ cmd: 'solve.run', step: 'static', solver: 'cpu-direct' });
    await window.fem.dispatch({ cmd: 'file.autosave', on: true });
    await window.fem.dispatch({ cmd: 'project.save' });
  }, longName);
  await expect(page.locator('.model-name')).toHaveValue(longName);
  await expect(page.locator('.topbar .solve')).toHaveText(/Solved/);
  await expect(page.locator('.saved-chip')).toContainText('saved');
  await expect(page.getByRole('button', { name: 'STEP receipt', exact: true })).toBeVisible();
  const layouts = [];
  for (const width of [1180, 1199, 1200, 1280, 1399, 1400, 1599, 1699, 1700, 1800, 1899, 1900, 2000, 2099, 2100]) {
    await page.setViewportSize({ width, height: 1100 });
    const layout = await page.locator('.topbar').evaluate(header => ({
      client: header.clientWidth, scroll: header.scrollWidth,
      items: [...header.children].map(element => ({ text: element.textContent?.trim(), rect: element.getBoundingClientRect().toJSON() })).filter(item => item.rect.width > 0),
    }));
    expect(layout.scroll, `STEP receipt header overflows at ${width}px`).toBe(layout.client);
    for (const item of layout.items) {
      expect(item.rect.left).toBeGreaterThanOrEqual(0);
      expect(item.rect.right).toBeLessThanOrEqual(width);
    }
    for (let i = 1; i < layout.items.length; i++) expect(layout.items[i - 1]!.rect.right).toBeLessThanOrEqual(layout.items[i]!.rect.left);
    layouts.push({ width, ...layout });
  }
  await page.setViewportSize({ width: 1180, height: 1100 });
  await page.screenshot({ path: info.outputPath('step-receipt-solved-header-1180.png') });
  for (const name of ['STEP receipt', 'Import Abaqus .inp', 'Import STEP geometry']) {
    await page.getByRole('button', { name, exact: true }).focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const title = name === 'STEP receipt' ? 'Close STEP report' : name === 'Import Abaqus .inp' ? 'Close Abaqus import' : 'Close STEP import';
    await dialog.getByTitle(title, { exact: true }).click();
  }
  await info.attach('STEP-receipt-layout', { body: JSON.stringify(layouts, null, 2), contentType: 'application/json' });
});
