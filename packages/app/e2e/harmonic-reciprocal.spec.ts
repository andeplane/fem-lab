import type { Command } from '@femlab/registry';
import { expect, test } from './fixtures';

for (const [start, stop, points, damping] of [
  [800, 2400, 9, 0.05],
  [1e99, 1e100, 3, 0],
  [1e99, 1e100, 9, 0.05],
  [1e99, 1e100, 9, 0.8],
]) {
  test(`@cpu harmonic reciprocal ${start}–${stop} Hz at ${points} points, damping ${damping}`, async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('femlab.tour.dismissed', '1');
      localStorage.setItem('femlab.autosave', 'off');
    });
    await page.goto('./');
    await page.waitForFunction(() => Boolean(window.fem));
    const sampled = await page.evaluate(async ({ start, stop, points, damping }) => {
      const commands: Command[] = [
        { cmd: 'model.new', name: 'finite harmonic reciprocal' },
        { cmd: 'geometry.addBox', name: 'bar', size: ['1 m', '0.1 m', '0.1 m'] },
        { cmd: 'material.add', name: 'steel', E: '210 GPa', nu: 0.3, rho: '7800 kg/m^3' },
        { cmd: 'material.assign', material: 'steel', bodies: ['bar'] },
        { cmd: 'mesh.set', mesher: { kind: 'lattice', size: { nx: 1, ny: 1, nz: 1 } }, formulation: 'full' },
        { cmd: 'constraint.fix', name: 'root', on: 'bar.xmin' },
        { cmd: 'constraint.fix', name: 'guide', on: 'bar.xmax', dofs: ['uy', 'uz'] },
        { cmd: 'load.traction', name: 'pull', on: 'bar.xmax', total: ['10 kN', '0 N', '0 N'] },
        { cmd: 'step.add', name: 'modes', procedure: 'modal', constraints: ['root', 'guide'], loads: [], nModes: 4 },
        { cmd: 'step.add', name: 'sweep', procedure: 'harmonic', constraints: ['root', 'guide'], loads: ['pull'],
          after: 'modes', fStart: { value: start, unit: 'Hz' }, fStop: { value: stop, unit: 'Hz' },
          points, dampingRatio: damping, sweep: 'linear' },
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
        field: await window.fem.query.field({ step: 'sweep', field: 'displacement' }),
        probe: await window.fem.query.probe({ step: 'sweep', field: 'displacement', component: 0,
          at: ['1 m', '0.05 m', '0.05 m'] }),
        catalogue: await window.fem.query.results(),
      };
    }, { start: start!, stop: stop!, points: points!, damping: damping! });
    expect(sampled.modalAfter).toEqual(sampled.modalBefore);
    expect(sampled.modeAfter).toEqual(sampled.modeBefore);
    expect(sampled.catalogue.records.map(row => row.step).sort()).toEqual(['modes', 'sweep']);
    const rows = sampled.response.sweep!;
    expect(rows).toHaveLength(points!);
    expect(rows[0]!.frequency.value).toBe(start);
    expect(rows.at(-1)!.frequency.value).toBe(stop);
    const stiffness = 210e9 * (1 - 0.3) / ((1 + 0.3) * (1 - 2 * 0.3)) * 0.01;
    const mass = 26;
    const viscous = 2 * damping! * Math.sqrt(stiffness * mass);
    let peak = 0;
    for (const row of rows) {
      const omega = 2 * Math.PI * row.frequency.value;
      const real = stiffness - mass * omega * omega;
      const imaginary = viscous * omega;
      const expected = 10000 / Math.hypot(real, imaginary);
      expect(row.amplitude.value).toBeGreaterThan(0);
      expect(Number.isFinite(row.amplitude.value)).toBe(true);
      expect(Math.abs(row.amplitude.value / expected - 1)).toBeLessThan(1e-10);
      const error = row.phase.value - Math.atan2(imaginary, real);
      expect(Math.abs(Math.atan2(Math.sin(error), Math.cos(error)))).toBeLessThan(1e-12);
      peak = Math.max(peak, expected);
    }
    const fieldMax = Math.max(...sampled.field.values);
    expect(fieldMax).toBeGreaterThan(0);
    expect(sampled.field.values.every(Number.isFinite)).toBe(true);
    expect(Math.abs(fieldMax / peak - 1)).toBeLessThan(1e-10);
    expect(sampled.probe.value.value).toBeGreaterThan(0);
    expect(Math.abs(sampled.probe.value.value / peak - 1)).toBeLessThan(1e-10);
    await expect(page.locator('.error-card')).toHaveCount(0);
    await expect(page.locator('button.solve')).toBeEnabled();
    await expect(page.locator('.section-label').filter({ hasText: 'Frequency response · sweep' })).toBeVisible();
    await expect(page.getByRole('img', { name: `amplitude against f, ${rows.length} points` })).toBeVisible();
    const polylines = await page.locator('svg.plot polyline').evaluateAll(elements =>
      elements.map(element => element.getAttribute('points')));
    expect(polylines.length).toBeGreaterThanOrEqual(2);
    expect(polylines.every(points => points !== null && !/NaN|Infinity/.test(points))).toBe(true);
  });
}
