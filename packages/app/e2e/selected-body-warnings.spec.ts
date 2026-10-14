import type { Command } from '@femlab/registry';
import { expect, test } from './fixtures';

const sheet = (name: string): Command => ({
  cmd: 'geometry.add', name,
  shape: { kind: 'sheet', sketch: { outer: [
    { kind: 'line', to: ['1 m', '0 m'], tag: 'ymin' },
    { kind: 'line', to: ['1 m', '1 m'], tag: 'xmax' },
    { kind: 'line', to: ['0 m', '1 m'], tag: 'ymax' },
    { kind: 'line', to: ['0 m', '0 m'], tag: 'xmin' },
  ] } },
});

const geometry: Command[] = [
  { cmd: 'model.new', name: 'selected body' },
  { cmd: 'model.setIdealisation', idealisation: { kind: 'planeStress', thickness: '2 mm' } },
  sheet('used'), sheet('unused'),
  { cmd: 'geometry.addBox', name: 'unused3d', size: ['1 m', '1 m', '1 m'] },
  { cmd: 'mesh.set', mesher: { kind: 'free', of: 'used', size: '500 mm' } },
];

for (const heat of [true, false]) {
  test(`@cpu selected free ${heat ? 'heat' : 'mechanical'} analysis ignores unused geometry and solves by button`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
    await page.goto('./');
    await page.waitForFunction(() => typeof window.fem !== 'undefined');
    const boundaries: Command[] = heat ? [
      { cmd: 'material.add', name: 'solid', k: '10 W/(m*K)' },
      { cmd: 'material.assign', material: 'solid', bodies: ['used'] },
      { cmd: 'constraint.temperature', name: 'cold', on: 'used.xmin', value: '0 K' },
      { cmd: 'constraint.temperature', name: 'hot', on: 'used.xmax', value: '1 K' },
      { cmd: 'step.add', name: 's', procedure: 'heat-steady', constraints: ['cold', 'hot'], loads: [] },
    ] : [
      { cmd: 'material.add', name: 'solid', E: '1 GPa', nu: 0 },
      { cmd: 'material.assign', material: 'solid', bodies: ['used'] },
      { cmd: 'constraint.fix', name: 'root', on: 'used.xmin' },
      { cmd: 'load.traction', name: 'pull', on: 'used.xmax', total: ['1 N', '0 N', '0 N'] },
      { cmd: 'step.add', name: 's', procedure: 'static', constraints: ['root'], loads: ['pull'] },
    ];
    await page.evaluate(async (commands) => {
      for (const command of commands) await window.fem.dispatch(command);
    }, [...geometry, ...boundaries]);

    for (const size of ['500 mm', '250 mm']) {
      await page.evaluate(size => window.fem.dispatch({ cmd: 'mesh.set', mesher: { kind: 'free', of: 'used', size } }), size);
      const model = await page.evaluate(() => window.fem.query.model());
      expect(model.bodies.map(body => body.name)).toEqual(['used', 'unused', 'unused3d']);
      expect(model.warnings).toEqual([]);
      await expect(page.locator('.banner,.tree .badge.warn')).toHaveCount(0);
      await expect(page.locator('button.solve')).toBeEnabled();
      await page.locator('button.solve').click();
      await expect(page.locator('button.solve')).toHaveText(/Solved/, { timeout: 60_000 });
      const result = await page.evaluate(() => window.fem.query.result({ step: 's' }));
      expect(result.stale).toBe(false);
      expect(result.step).toBe('s');
      const probe = await page.evaluate(heat => window.fem.query.probe({
        step: 's', field: heat ? 'temperature' : 'displacement', component: 0,
        at: [heat ? '0.25 m' : '1 m', '0.5 m', '0 m'],
      }), heat);
      // Independent closed forms: T(x)=x/L; ux(L)=F L/(E A), A=1 m*2 mm.
      expect(probe.value.value).toBeCloseTo(heat ? 0.25 : 5e-7, heat ? 10 : 12);
      const support = result.reactions.find(row => row.constraint === (heat ? 'cold' : 'root'))!;
      expect(support.total[0].value).toBeCloseTo(heat ? 0.02 : -1, 10);
      await expect(page.locator('.banner,.error-card,.tree .badge.warn')).toHaveCount(0);
    }
  });
}

test('@cpu selected free Body still blocks Solve when its own material is missing', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined');
  const boundaries: Command[] = [
    { cmd: 'constraint.temperature', name: 'cold', on: 'used.xmin', value: '0 K' },
    { cmd: 'constraint.temperature', name: 'hot', on: 'used.xmax', value: '1 K' },
    { cmd: 'step.add', name: 's', procedure: 'heat-steady', constraints: ['cold', 'hot'], loads: [] },
  ];
  await page.evaluate(async (commands) => {
    for (const command of commands) await window.fem.dispatch(command);
  }, [...geometry, ...boundaries]);
  const model = await page.evaluate(() => window.fem.query.model());
  expect(model.warnings.filter(w => w.code === 'model.no-material')).toEqual([{
    code: 'model.no-material',
    text: "Body 'used' has no material; assign one with material.assign",
    where: "body 'used'",
  }]);
  await expect(page.locator('button.solve')).toBeDisabled();
});
