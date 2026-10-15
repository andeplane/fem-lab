import { writeFile } from 'node:fs/promises';
import type { Command } from '@femlab/registry';
import { expect, test } from './fixtures';

test('@cpu Checks describes valid free modal, insulated heat and supported static preflight honestly', async ({ page }, info) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => {
    localStorage.setItem('femlab.tour.dismissed', '1');
    localStorage.setItem('femlab.autosave', 'off');
  });
  await page.goto('./');
  await page.waitForFunction(() => Boolean(window.fem));
  const receipts = [];
  for (const procedure of ['modal', 'heat-transient', 'static'] as const) {
    await page.evaluate(async procedure => {
      await window.fem.dispatch({ cmd: 'project.new', name: `Checks-${procedure}` });
      const commands: Command[] = [
        { cmd: 'geometry.addBox', name: 'bar', size: ['1 m', '100 mm', '100 mm'] },
        { cmd: 'mesh.set', mesher: { kind: 'lattice', size: { nx: 2, ny: 1, nz: 1 } }, order: 1, formulation: 'full' },
        procedure === 'heat-transient'
          ? { cmd: 'material.add', name: 'material', k: '12 W/(m K)', rho: '1000 kg/m^3', cp: '1000 J/(kg K)' }
          : { cmd: 'material.add', name: 'material', E: '200 GPa', nu: 0, rho: '7800 kg/m^3' },
        { cmd: 'material.assign', material: 'material', bodies: ['bar'] },
      ];
      if (procedure === 'static') commands.push(
        { cmd: 'constraint.fix', name: 'root', on: 'bar.xmin' },
        { cmd: 'load.traction', name: 'pull', on: 'bar.xmax', total: ['1000 N', '0 N', '0 N'] },
      );
      commands.push({ cmd: 'step.add', name: 'preflight', procedure,
        constraints: procedure === 'static' ? ['root'] : [], loads: procedure === 'static' ? ['pull'] : [],
        ...(procedure === 'modal' ? { nModes: 8 } : {}),
        ...(procedure === 'heat-transient' ? { dt: '0.1 s', tEnd: '0.2 s', initial: '300 K' } : {}),
      });
      for (const command of commands) await window.fem.dispatch(command);
    }, procedure);
    const before = await page.evaluate(() => window.fem.query.journal());
    await page.getByRole('tab', { name: /^checks/ }).click();
    const checks = page.locator('.checks');
    await expect(checks.locator('.surface.pass')).toHaveText('✓No current pre-solve blockers are reported.');
    await expect(checks).toContainText(`degrees of freedom${procedure === 'heat-transient' ? 12 : 36}`);
    await expect(checks.locator('.check-row')).toHaveCount(0);
    const receipt = await page.evaluate(async () => ({
      model: await window.fem.query.model(), mesh: await window.fem.query.mesh(),
      cost: await window.fem.query.cost({ step: 'preflight' }), journal: await window.fem.query.journal(),
    }));
    expect(receipt.model.warnings).toEqual([]);
    expect(receipt.model.constraints).toHaveLength(procedure === 'static' ? 1 : 0);
    expect(receipt.model.loads).toHaveLength(procedure === 'static' ? 1 : 0);
    expect(receipt.model.steps[0]!.solved).toBe(false);
    expect(receipt.journal).toEqual(before);
    receipts.push({ procedure, ...receipt });
    await checks.screenshot({ path: info.outputPath(`checks-ready-${procedure}.png`) });
  }
  await writeFile(info.outputPath('public-preflight-receipts.json'), JSON.stringify(receipts, null, 2));
});
