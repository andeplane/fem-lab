import { readFile, writeFile } from 'node:fs/promises';
import type { Command, ProjectMeta } from '@femlab/registry';
import { expect, test } from './fixtures';

declare global {
  interface Window {
    beforeCancelFacade: Window['fem'];
  }
}

// A long schedule is cancelled once, never retried. Retain the actual Worker/resource
// trace on success too, so CI can verify the runtime and the visible active-solve witness.
test.describe.configure({ retries: 0, timeout: 30_000 });
test.use({ trace: 'on' });

test('@cpu dense real integration progress preserves Cancel recovery and a later solve', async ({ page }, info) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => {
    localStorage.setItem('femlab.tour.dismissed', '1');
    localStorage.setItem('femlab.autosave', 'off');
  });
  await page.goto('./');
  await page.waitForFunction(() => Boolean(window.fem));
  await page.evaluate(async () => {
    await window.fem.dispatch({ cmd: 'project.new', name: 'Actual cancellation journey' });
    const commands: Command[] = [
      { cmd: 'model.setUnits', units: { length: 'm', force: 'N', stress: 'Pa' } },
      { cmd: 'geometry.addBox', name: 'bar', size: ['1 m', '100 mm', '100 mm'] },
      { cmd: 'material.add', name: 'steel', E: '200 GPa', nu: 0, rho: '7800 kg/m^3' },
      { cmd: 'material.assign', material: 'steel', bodies: ['bar'] },
      { cmd: 'mesh.set', mesher: { kind: 'lattice', size: { nx: 2, ny: 1, nz: 1 } }, order: 1, formulation: 'full' },
      { cmd: 'load.gravity', name: 'gravity', g: ['0 m/s^2', '0 m/s^2', '-9.81 m/s^2'] },
      // Long physical interval, tiny spatial problem, and bounded retained output. This
      // is deliberately cancelled, not a timing benchmark or a completed long-time solve.
      { cmd: 'step.add', name: 'flight', procedure: 'explicit', constraints: [], loads: ['gravity'],
        tEnd: '60 s', dtFactor: 0.9, outputEvery: 1_000_000, output: ['displacement'] },
    ];
    for (const command of commands) await window.fem.dispatch(command);
    window.beforeCancelFacade = window.fem;
  });
  const before = await page.evaluate(async () => ({
    model: await window.fem.query.model(), document: await window.fem.query.document(),
    journal: await window.fem.query.journal(), mesh: await window.fem.query.mesh(),
    cost: await window.fem.query.cost({ step: 'flight' }), results: await window.fem.query.results(),
  }));
  expect(before.model.warnings).toEqual([]);
  expect(before.mesh.nodes).toBe(12);
  expect(before.cost.dofs).toBe(36);
  expect(before.cost.retainedFrames).toBeLessThan(30);
  expect(before.results.records).toEqual([]);
  await page.locator('button[data-cmd="view.fit"]').click();
  await page.locator('.topbar button[data-cmd="project.save"]').click();
  await expect.poll(async () => {
    const { projects } = await page.evaluate(() => window.fem.registry.query({ query: 'query.projects' })) as { projects: ProjectMeta[] };
    return projects.find(p => p.name === 'Actual cancellation journey')?.commands;
  }).toBe(before.journal.entries.length);
  const savedProjects = await page.evaluate(() => window.fem.registry.query({ query: 'query.projects' })) as { projects: ProjectMeta[] };
  const savedProject = savedProjects.projects.find(p => p.name === 'Actual cancellation journey')!;
  const baselineDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save as file', exact: true }).click();
  const baselinePath = info.outputPath('before-cancel.femlab.json');
  await (await baselineDownload).saveAs(baselinePath);

  await page.locator('.topbar button[data-cmd="solve.run"]').click();
  await expect(page.locator('.solving-card .solving-meta')).toContainText('solve ·');
  await expect(page.locator('.solving-card .solving-message')).toHaveText('stepping in time');
  const cancel = page.locator('.solving-card button[data-cmd="solve.cancel"]');
  await expect(cancel).toBeVisible();
  await expect(cancel).toBeEnabled();
  const active = { visibleText: await page.locator('.solving-card').innerText(), cancelEnabled: await cancel.isEnabled() };
  await page.screenshot({ path: info.outputPath('actual-integration-before-cancel.png') });
  await cancel.click();
  await expect(page.locator('.solving-card')).toHaveCount(0);
  await expect.poll(() => page.evaluate(async () => {
    try { return (await window.fem.query.model()).hash; }
    catch (error) { return String((error as { code?: string }).code); }
  })).toBe(before.model.hash);
  const after = await page.evaluate(async () => ({
    model: await window.fem.query.model(), document: await window.fem.query.document(),
    journal: await window.fem.query.journal(), mesh: await window.fem.query.mesh(),
    results: await window.fem.query.results(),
    retiredCode: await window.beforeCancelFacade.query.model().then(() => 'incorrectly active', error => String((error as { code?: string }).code)),
  }));
  expect(after.document).toEqual(before.document);
  expect(after.journal).toEqual(before.journal);
  expect(after.mesh).toEqual(before.mesh);
  expect(after.results.records).toEqual([]);
  expect(after.retiredCode).toBe('session.expired');
  await page.screenshot({ path: info.outputPath('cancelled-model-recovered.png') });
  const recoveredDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save as file', exact: true }).click();
  const recoveredPath = info.outputPath('after-cancel.femlab.json');
  await (await recoveredDownload).saveAs(recoveredPath);
  expect(JSON.parse(await readFile(recoveredPath, 'utf8'))).toEqual(JSON.parse(await readFile(baselinePath, 'utf8')));
  await page.evaluate(id => window.fem.dispatch({ cmd: 'project.open', id }), savedProject.id);
  expect(await page.evaluate(() => window.fem.query.document())).toEqual(before.document);
  expect(await page.evaluate(() => window.fem.query.journal())).toEqual(before.journal);

  await page.evaluate(() => window.fem.step.add({ name: 'flight', procedure: 'explicit', constraints: [], loads: ['gravity'],
    tEnd: '1 ms', dtFactor: 0.9, outputEvery: 100, output: ['displacement'] }));
  await page.locator('.topbar button[data-cmd="solve.run"]').click();
  await expect(page.locator('.topbar button[data-cmd="solve.run"]')).toContainText('Solved');
  const recoveredSolve = await page.evaluate(async () => ({
    result: await window.fem.query.result({ step: 'flight' }), journal: await window.fem.query.journal(),
  }));
  const uz = recoveredSolve.result.extremes.find(e => e.field === 'displacement' && e.component === 2)!;
  expect(recoveredSolve.result.stale).toBe(false);
  expect(uz.min.unit).toBe('m');
  expect(Math.abs(uz.min.value - (-0.5 * 9.81 * 0.001 ** 2))).toBeLessThan(1e-12);
  expect(Math.abs(uz.max.value - uz.min.value)).toBeLessThan(1e-12);
  expect(recoveredSolve.journal.entries).toHaveLength(before.journal.entries.length + 2);
  expect(recoveredSolve.journal.entries.at(-1)?.cmd).toEqual({ cmd: 'solve.run', step: 'flight' });
  await page.screenshot({ path: info.outputPath('successful-solve-after-cancel.png') });
  await writeFile(info.outputPath('public-cancellation-receipts.json'), JSON.stringify({ before, savedProject, active, after, recoveredSolve }, null, 2));
  for (const name of ['actual-integration-before-cancel.png', 'cancelled-model-recovered.png', 'successful-solve-after-cancel.png']) {
    await info.attach(name, { path: info.outputPath(name), contentType: 'image/png' });
  }
  for (const name of ['before-cancel.femlab.json', 'after-cancel.femlab.json', 'public-cancellation-receipts.json']) {
    await info.attach(name, { path: info.outputPath(name), contentType: 'application/json' });
  }
});
