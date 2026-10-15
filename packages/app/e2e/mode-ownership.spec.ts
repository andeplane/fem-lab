// #608: real supported-browser solves must select fields owned by the response Result,
// while modal-basis frequencies and the earlier Result's mode shapes remain available.
import type { ResultSummary } from '@femlab/registry';
import { expect, test } from './fixtures';

for (const response of ['harmonic', 'randomVibration'] as const) {
  test(`@cpu modal → ${response} selects response fields and keeps retained modes`, async ({ page }, testInfo) => {
    await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('./');
    await page.waitForFunction(() => typeof window.fem !== 'undefined');
    const modal = await page.evaluate(async (procedure) => {
      await window.fem.dispatch({ cmd: 'project.new', name: 'mode ownership' });
      for (const command of [
        { cmd: 'geometry.addBox', name: 'bar', size: ['1 m', '0.1 m', '0.1 m'] },
        { cmd: 'material.add', name: 'steel', E: '210 GPa', nu: 0.3, rho: '7800 kg/m^3', source: 'EN 10025' },
        { cmd: 'material.assign', material: 'steel', bodies: ['bar'] },
        { cmd: 'mesh.set', mesher: { kind: 'lattice', size: { nx: 1, ny: 1, nz: 1 } }, formulation: 'full' },
        { cmd: 'constraint.fix', name: 'root', on: 'bar.xmin' },
        { cmd: 'constraint.fix', name: 'guide', on: 'bar.xmax', dofs: ['uy', 'uz'] },
        { cmd: 'load.traction', name: 'pull', on: 'bar.xmax', total: ['10 kN', '0 N', '0 N'] },
        { cmd: 'step.add', name: 'modes', procedure: 'modal', constraints: ['root', 'guide'], loads: [], nModes: 4 },
        { cmd: 'step.add', name: 'response', procedure, constraints: ['root', 'guide'], loads: ['pull'], after: 'modes', dampingRatio: 0.02,
          ...(procedure === 'harmonic' ? { fStart: '10 Hz', fStop: '20 Hz', points: 3 } : { psd: [{ frequency: '0 Hz', density: '0.01 s' }, { frequency: '1 MHz', density: '0.01 s' }] }) },
      ]) await window.fem.dispatch(command);
      await window.fem.solve.run({ step: 'modes', solver: 'cpu-direct' });
      const summary = await window.fem.query.result() as ResultSummary;
      const field = await window.fem.query.field({ resultId: summary.resultId, field: 'mode:2' });
      return { summary, field };
    }, response);
    expect(modal.summary.modeCount).toBe(4);
    await expect(page.locator('.legend-field')).toHaveText('mode 1');
    await page.evaluate(() => window.fem.dispatch({ cmd: 'view.showField', field: 'mode:2' }));
    await expect(page.locator('.legend-field')).toHaveText('mode 2');

    // This public app dispatch used to solve successfully, then reject while loading mode:1.
    await page.evaluate(() => window.fem.solve.run({ step: 'response', solver: 'cpu-direct' }));
    const summary = await page.evaluate(() => window.fem.query.result()) as ResultSummary;
    expect(summary.modeCount).toBe(0);
    expect(summary.extremes.some(row => row.field === 'displacement')).toBe(true);
    await expect(page.locator('.legend-field')).not.toHaveText(/mode/);
    await expect(page.locator('.tree [data-cmd="view.showField"]', { hasText: 'mode ' })).toHaveCount(0);
    await page.evaluate(() => window.fem.dispatch({ cmd: 'view.showField', field: 'displacement' }));
    await expect(page.locator('.legend-field')).toHaveText('|u|');
    const displacement = await page.evaluate(id => window.fem.query.field({ resultId: id, field: 'displacement' }), summary.resultId);
    expect(displacement.values.every(Number.isFinite)).toBe(true);
    expect(displacement.values.some(value => value > 0)).toBe(true);
    if (response === 'harmonic') {
      expect(summary.frequencies).toEqual(modal.summary.frequencies);
      expect(summary.sweep).toHaveLength(3);
      const table = page.locator('.rtable', { hasText: 'frequency' });
      await expect(table.locator('tbody tr')).toHaveCount(4);
      await expect(table.locator('[data-cmd="view.showField"]')).toHaveCount(0);
      await expect(page.locator('section.bottom')).toContainText('Modal basis frequencies');
      await expect(page.locator('section.bottom')).toContainText('Frequency response · response');
    } else {
      expect(summary.frequencies ?? []).toEqual([]);
      expect(summary.extremes.some(row => row.field === 'stress')).toBe(true);
    }
    await page.screenshot({ path: testInfo.outputPath(`${response}-response.png`) });

    expect(await page.evaluate(id => window.fem.query.result({ resultId: id }), modal.summary.resultId)).toEqual(modal.summary);
    expect(await page.evaluate(id => window.fem.query.field({ resultId: id, field: 'mode:2' }), modal.summary.resultId)).toEqual(modal.field);
    await page.evaluate(() => window.fem.dispatch({ cmd: 'view.animate', step: 'modes', mode: 2, playing: false, frame: 50 }));
    await expect(page.locator('.legend-field')).toHaveText('mode 2');
    await expect(page.locator('.rtable', { hasText: 'frequency' }).locator('[data-cmd="view.showField"]')).toHaveCount(4);
    await page.screenshot({ path: testInfo.outputPath(`${response}-retained-modal.png`) });
  });
}
