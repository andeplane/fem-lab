import type { Command } from '@femlab/registry';
import { expect, test } from './fixtures';

for (const solid of [false, true]) {
  for (const simplices of [false, true]) {
    const kind = solid ? (simplices ? 'Tet10' : 'Hex20') : (simplices ? 'Tri6' : 'Quad8');
    test(`@cpu ${kind} queries measure the original quadratic geometry under refinement`, async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
      await page.goto('./');
      await page.waitForFunction(() => typeof window.fem !== 'undefined');
      let previousGeometryError: number | undefined;
      let previousQuadratureError: number | undefined;
      for (const n of [2, 4, 8]) {
        const values = await page.evaluate(async ({ n, solid, simplices }) => {
          const mesh: Extract<Command, { cmd: 'mesh.set' }> = {
            cmd: 'mesh.set', order: 2, simplices, mesher: {
              kind: 'mapped', body: 'ring', blocks: [{
                corners: [['1 m', '0 m'], ['2 m', '0 m'], ['0 m', '2 m'], ['0 m', '1 m']],
                edges: [{ kind: 'line' }, { kind: 'arc', center: ['0 m', '0 m'], ccw: true },
                  { kind: 'line' }, { kind: 'arc', center: ['0 m', '0 m'], ccw: false }],
                n: [1, n], tags: ['radial0', 'outer', 'radial1', 'inner'],
              }],
            },
          };
          if (solid) mesh.mesher = { kind: 'sweep', base: mesh.mesher, sweep: { kind: 'extrude', layers: 1, height: '3 m' } };
          const commands: Command[] = [
            { cmd: 'model.new', name: 'original-quadratic-query' },
            { cmd: 'model.setUnits', units: { length: 'm' } },
            ...(!solid ? [{ cmd: 'model.setIdealisation' as const, idealisation: { kind: 'planeStress' as const, thickness: '2 mm' } }] : []),
            mesh,
            { cmd: 'geometry.nameRegion', name: 'whole', where: { kind: 'body', name: 'ring' } },
          ];
          for (const command of commands) await window.fem.dispatch(command);
          return {
            whole: await window.fem.query.set({ name: 'whole' }),
            outer: await window.fem.query.set({ name: 'ring.outer' }),
            inner: await window.fem.query.set({ name: 'ring.inner' }),
            model: await window.fem.query.model(),
          };
        }, { n, solid, simplices });
        const delta = Math.PI / (4 * n);
        const scale = solid ? 3 : 1;
        const exactOriginalArea = scale * n * Math.sin(delta) * (4 - Math.cos(delta));
        const k = 2 * Math.tan(delta / 2);
        const exactBoundary = scale * 2 * n * Math.sin(delta) * (Math.sqrt(1 + k * k) + Math.asinh(k) / k);
        expect(Math.abs(values.whole.measure.value - exactOriginalArea)).toBeLessThan(3e-13);
        expect(values.model.bodies).toHaveLength(1);
        expect(Math.abs(values.model.bodies[0]!.measure.value - exactOriginalArea)).toBeLessThan(3e-13);
        expect(values.whole.measure.unit).toBe(solid ? 'm^3' : 'm^2');
        expect(values.outer.measure.unit).toBe(solid ? 'm^2' : 'm');
        expect(Math.abs(values.outer.measure.value - 2 * values.inner.measure.value)).toBeLessThan(3e-13);
        const geometryError = Math.abs(values.whole.measure.value - scale * 3 * Math.PI / 4);
        const quadratureError = Math.abs(values.outer.measure.value - exactBoundary);
        expect(quadratureError / exactBoundary).toBeLessThan(5e-6);
        if (previousGeometryError !== undefined) {
          const order = Math.log2(previousGeometryError / geometryError);
          expect(order).toBeGreaterThan(3.9);
          expect(order).toBeLessThan(4.1);
          expect(quadratureError).toBeLessThan(previousQuadratureError! / 20);
        }
        previousGeometryError = geometryError;
        previousQuadratureError = quadratureError;
        await expect(page.locator('#tree-geometry-items .name').filter({ hasText: /^ring$/ })).toBeVisible();
        await expect(page.locator('.error-card')).toHaveCount(0);
      }
    });
  }
}
