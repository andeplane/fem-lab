import type { Command } from '@femlab/registry';
import { expect, test } from './fixtures';

for (const [stop, points, every] of [[1e100, 3, 1], [1e100, 9, 4], [1e20, 3, 1], [1e20, 17, 1]] as const) {
  test('@cpu finite logarithmic sweep to ' + stop + ' Hz at ' + points + ' points retains both Results', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('femlab.tour.dismissed', '1');
      localStorage.setItem('femlab.autosave', 'off');
    });
    await page.goto('./');
    await page.waitForFunction(() => Boolean(window.fem));
    const sampled = await page.evaluate(async ({ stop, points, every }) => {
      const commands: Command[] = [
        { cmd: 'model.new', name: 'finite logarithmic sweep' },
        { cmd: 'geometry.addBox', name: 'bar', size: ['1 m', '0.1 m', '0.1 m'] },
        { cmd: 'material.add', name: 'steel', E: '210 GPa', nu: 0.3, rho: '7800 kg/m^3' },
        { cmd: 'material.assign', material: 'steel', bodies: ['bar'] },
        { cmd: 'mesh.set', mesher: { kind: 'lattice', size: { nx: 1, ny: 1, nz: 1 } }, formulation: 'full' },
        { cmd: 'constraint.fix', name: 'root', on: 'bar.xmin' },
        { cmd: 'constraint.fix', name: 'guide', on: 'bar.xmax', dofs: ['uy', 'uz'] },
        { cmd: 'load.traction', name: 'pull', on: 'bar.xmax', total: ['10 kN', '0 N', '0 N'] },
        { cmd: 'step.add', name: 'modes', procedure: 'modal', constraints: ['root', 'guide'], loads: [], nModes: 4 },
        { cmd: 'step.add', name: 'sweep', procedure: 'harmonic', constraints: ['root', 'guide'], loads: ['pull'],
          after: 'modes', fStart: '1e-300 Hz', fStop: String(stop) + ' Hz', points, outputEvery: every,
          dampingRatio: 0, sweep: 'log' },
        { cmd: 'solve.run', step: 'modes', solver: 'cpu-direct' },
      ];
      for (const command of commands) await window.fem.dispatch(command);
      const modalBefore = await window.fem.query.result({ step: 'modes' });
      const modeBefore = await window.fem.query.field({ resultId: modalBefore.resultId, field: 'mode:1' });
      await window.fem.dispatch({ cmd: 'solve.run', step: 'sweep', solver: 'cpu-direct' });
      return {
        modalBefore, modeBefore,
        modalAfter: await window.fem.query.result({ resultId: modalBefore.resultId }),
        modeAfter: await window.fem.query.field({ resultId: modalBefore.resultId, field: 'mode:1' }),
        response: await window.fem.query.result({ step: 'sweep' }),
        catalogue: await window.fem.query.results(),
      };
    }, { stop: stop!, points: points!, every: every! });
    expect(sampled.modalAfter).toEqual(sampled.modalBefore);
    expect(sampled.modeAfter).toEqual(sampled.modeBefore);
    expect(sampled.catalogue.records.map(row => row.step).sort()).toEqual(['modes', 'sweep']);
    expect(sampled.response.sweep).toBeDefined();
    const rows = sampled.response.sweep!;
    const indices = Array.from({ length: points! }, (_, i) => i)
      .filter(i => i === 0 || i % every! === 0 || i === points! - 1);
    expect(rows).toHaveLength(indices.length);
    expect(rows[0]!.frequency.value).toBe(1e-300);
    expect(rows.at(-1)!.frequency.value).toBe(stop);
    for (const [i, row] of rows.entries()) {
      const exact = 10 ** (-300 + (stop === 1e100 ? 400 : 320) * indices[i]! / (points! - 1));
      expect(row.frequency.unit).toBe('Hz');
      expect(Number.isFinite(row.frequency.value)).toBe(true);
      expect(Math.abs(row.frequency.value / exact - 1)).toBeLessThan(4e-13);
      if (i > 0) expect(row.frequency.value).toBeGreaterThan(rows[i - 1]!.frequency.value);
      if (stop === 1e20) {
        const stiffness = 210e9 * (1 - 0.3) / ((1 + 0.3) * (1 - 2 * 0.3)) * 0.01;
        const omega = 2 * Math.PI * row.frequency.value;
        const dynamicStiffness = stiffness - 26 * omega * omega;
        expect(Math.abs(row.amplitude.value / (10000 / Math.abs(dynamicStiffness)) - 1)).toBeLessThan(1e-10);
        expect(Math.abs(Math.abs(row.phase.value) - (dynamicStiffness > 0 ? 0 : Math.PI))).toBeLessThan(1e-12);
      }
    }
    // The extreme stop proves the frequency contract; its response reciprocal has a separate issue.
    await expect(page.locator('.error-card')).toHaveCount(0);
    await expect(page.locator('button.solve')).toBeEnabled();
    await expect(page.locator('.section-label').filter({ hasText: 'Frequency response · sweep' })).toBeVisible();
    await expect(page.getByRole('img', { name: 'amplitude against f, ' + rows.length + ' points' })).toBeVisible();
    const polylines = await page.locator('svg.plot polyline').evaluateAll(elements => elements.map(element => element.getAttribute('points')));
    expect(polylines.length).toBeGreaterThanOrEqual(2);
    expect(polylines.every(points => points !== null && !/NaN|Infinity/.test(points))).toBe(true);
  });
}
