import { expect, test, type Page } from './fixtures';

// Software-adapter correctness is independent of concurrent build/test load.
test.setTimeout(90_000);

async function ready(page: Page) {
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined');
}

async function freeModel(page: Page, procedure: 'modal' | 'explicit') {
  await page.evaluate(async (procedure) => {
    await window.fem.dispatch({ cmd: 'project.new', name: `mixed-${procedure}` });
    await window.fem.model.setUnits({ units: { length: 'm', force: 'N', stress: 'Pa' } });
    await window.fem.geometry.addBox({ name: 'block', size: ['100 mm', '100 mm', '100 mm'] });
    await window.fem.material.add({ name: 'steel', E: '210 GPa', nu: 0.3, rho: '7800 kg/m^3' });
    await window.fem.material.assign({ material: 'steel', bodies: ['block'] });
    await window.fem.mesh.set({ mesher: { kind: 'lattice', size: { nx: 1, ny: 1, nz: 1 } }, formulation: 'full' });
    if (procedure === 'explicit') await window.fem.load.gravity({ name: 'gravity', g: ['0 m/s^2', '0 m/s^2', '-9.81 m/s^2'] });
    await window.fem.step.add({
      name: 'free', procedure, constraints: [], loads: procedure === 'explicit' ? ['gravity'] : [], output: ['displacement'],
      ...(procedure === 'modal' ? { nModes: 8 } : { tEnd: '1 ms', outputEvery: 100 }),
    });
    await window.fem.step.add({ name: 'unfinished', procedure: 'static', constraints: [], loads: [], output: ['displacement'] });
  }, procedure);
}

for (const procedure of ['modal', 'explicit'] as const) {
  test(`@cpu valid free ${procedure} Solve ignores an unfinished later static Step`, async ({ page }) => {
    await ready(page);
    await freeModel(page, procedure);
    const model = await page.evaluate(() => window.fem.query.model());
    expect(model.warnings).toContainEqual(expect.objectContaining({ code: 'model.unconstrained', step: 'unfinished' }));
    const solve = page.locator('button.solve');
    await expect(solve).toBeEnabled();
    await expect(page.locator('.banner')).toHaveCount(0);
    await solve.click();
    await expect(solve).toContainText('Solved', { timeout: 30_000 });
    const proof = await page.evaluate(async () => ({ result: await window.fem.query.result(), journal: await window.fem.query.journal() }));
    expect(proof.result.step).toBe('free');
    expect(proof.result.stale).toBe(false);
    expect(proof.journal.entries.at(-1)?.cmd).toEqual({ cmd: 'solve.run', step: 'free' });
    if (procedure === 'explicit') {
      const z = proof.result.extremes.find(extreme => extreme.field === 'displacement' && extreme.component === 2)!;
      expect(z.min.value).toBeCloseTo(-0.5 * 9.81 * 1e-6, 10);
      expect(z.max.value).toBeCloseTo(z.min.value, 10);
    }
    await page.evaluate(() => window.fem.step.reorder({ order: ['unfinished', 'free'] }));
    await expect(solve).toBeDisabled();
    await expect(solve).toHaveAttribute('title', /W-1300/);
    await expect(page.locator('.banner')).toContainText('W-1300');
    // The stale Result's action targets free, even while the top bar targets unfinished.
    const reSolve = page.locator('.stale-banner button[data-cmd="solve.run"]');
    await expect(reSolve).toBeEnabled();
    await reSolve.click();
    await expect(page.locator('.stale-banner')).toHaveCount(0, { timeout: 30_000 });
    expect((await page.evaluate(() => window.fem.query.journal())).entries.at(-1)?.cmd).toEqual({ cmd: 'solve.run', step: 'free' });
    const failure = await page.evaluate(async () => {
      try { await window.fem.solve.run({ step: 'unfinished' }); return null; }
      catch (error) { const e = error as { code?: string; cause?: string }; return { code: e.code, cause: e.cause }; }
    });
    expect(failure).not.toBeNull();
    await expect(page.locator('.banner.error')).toBeVisible();
    expect((await page.evaluate(() => window.fem.query.result({ step: 'free' }))).step).toBe('free');
  });
}

test('@cpu structural Solve proceeds while a later heat Step requires conductivity', async ({ page }) => {
  await ready(page);
  await page.evaluate(async () => {
    await window.fem.dispatch({ cmd: 'project.new', name: 'structural-with-heat' });
    await window.fem.model.setUnits({ units: { length: 'm', force: 'N', stress: 'Pa' } });
    await window.fem.geometry.addBox({ name: 'bar', size: ['1 m', '100 mm', '100 mm'] });
    await window.fem.material.add({ name: 'steel', E: '200 GPa', nu: 0 });
    await window.fem.material.assign({ material: 'steel', bodies: ['bar'] });
    await window.fem.mesh.set({ mesher: { kind: 'lattice', size: { nx: 2, ny: 1, nz: 1 } }, formulation: 'full' });
    await window.fem.constraint.fix({ name: 'root', on: 'bar.xmin' });
    await window.fem.load.traction({ name: 'pull', on: 'bar.xmax', total: ['1000 N', '0 N', '0 N'] });
    await window.fem.load.gravity({ name: 'unused-gravity', g: ['0 m/s^2', '0 m/s^2', '-9.81 m/s^2'] });
    await window.fem.constraint.temperature({ name: 'reference', on: 'bar.xmin', value: '293 K' });
    await window.fem.step.add({ name: 'pull', procedure: 'static', constraints: ['root'], loads: ['pull'], output: ['displacement'] });
    await window.fem.step.add({ name: 'warm', procedure: 'heat-steady', constraints: ['reference'], loads: [], output: ['temperature'] });
    await window.fem.dispatch({ cmd: 'panel.toggle', panel: 'results', open: true });
  });
  const model = await page.evaluate(() => window.fem.query.model());
  expect(model.warnings).toContainEqual(expect.objectContaining({ code: 'material.missing-property', step: 'warm', where: "material 'steel'" }));
  expect(model.warnings.map(warning => warning.code)).not.toContain('load.no-density');
  const fallback = page.locator('.bottom-body button[data-cmd="solve.run"]');
  await expect(fallback).toBeEnabled();
  await fallback.click();
  await expect(page.locator('button.solve')).toContainText('Solved', { timeout: 30_000 });
  const result = await page.evaluate(() => window.fem.query.result());
  expect(result.step).toBe('pull');
  expect(result.extremes.find(extreme => extreme.field === 'displacement' && extreme.component === 0)?.max.value).toBeCloseTo(5e-7, 12);
  const failure = await page.evaluate(async () => {
    try { await window.fem.solve.run({ step: 'warm' }); return null; }
    catch (error) { const e = error as { code?: string; where?: string }; return { code: e.code, where: e.where }; }
  });
  expect(failure).toMatchObject({ code: 'model.ill-posed', where: "body 'bar'" });
  await expect(page.locator('.banner.error')).toContainText('conductivity k');
});

test('@cpu a required thermal predecessor still blocks the structural Solve', async ({ page }) => {
  await ready(page);
  await page.evaluate(async () => {
    await window.fem.dispatch({ cmd: 'project.new', name: 'invalid-predecessor' });
    await window.fem.geometry.addBox({ name: 'bar', size: ['1 m', '100 mm', '100 mm'] });
    await window.fem.material.add({ name: 'steel', E: '200 GPa', nu: 0, alpha: '1e-5 1/K' });
    await window.fem.material.assign({ material: 'steel', bodies: ['bar'] });
    await window.fem.mesh.set({ mesher: { kind: 'lattice', size: { nx: 2, ny: 1, nz: 1 } } });
    await window.fem.constraint.fix({ name: 'root', on: 'bar.xmin' });
    await window.fem.constraint.temperature({ name: 'reference', on: 'bar.xmin', value: '293 K' });
    await window.fem.load.traction({ name: 'pull', on: 'bar.xmax', total: ['1000 N', '0 N', '0 N'] });
    // Upsert the first Step after defining its prerequisite, retaining the button's target.
    await window.fem.step.add({ name: 'expand', procedure: 'static', constraints: ['root'], loads: ['pull'], output: ['displacement'] });
    await window.fem.step.add({ name: 'warm', procedure: 'heat-steady', constraints: ['reference'], loads: [], output: ['temperature'] });
    await window.fem.step.add({ name: 'expand', procedure: 'static', constraints: ['root'], loads: ['pull'], after: 'warm', output: ['displacement'] });
  });
  await expect(page.locator('button.solve')).toBeDisabled();
  await expect(page.locator('button.solve')).toHaveAttribute('title', /W-1103/);
  const failure = await page.evaluate(async () => {
    try { await window.fem.solve.run({ step: 'expand' }); return null; }
    catch (error) { const e = error as { code?: string; where?: string; suggestion?: string }; return { code: e.code, where: e.where, suggestion: e.suggestion }; }
  });
  expect(failure).toMatchObject({ code: 'not-found', where: "step 'expand'", suggestion: "solve.run on step 'warm' first" });
  await expect(page.locator('.banner.error')).toContainText("warm");
});
