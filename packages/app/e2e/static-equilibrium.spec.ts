// #445: real supported Chromium host dispatch, physics Queries, and rendered Report UI.
import { readFileSync } from 'node:fs';
import type { Command, ResultSummary, Valued } from '@femlab/registry';
import { expect, test } from './fixtures';

const benchmark = JSON.parse(readFileSync(new URL('../../../crates/femlab/benches/cases/beam-torsion-shaft.json', import.meta.url), 'utf8')) as { journal: Command[] };
function close(actual: number, expected: number, tolerance: number): void {
  expect(Number.isFinite(actual)).toBe(true);
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

function vector(actual: Valued[], expected: number[], unit: string, tolerance = 1e-8): void {
  expect(actual).toHaveLength(3);
  actual.forEach((quantity, c) => {
    expect(quantity.unit).toBe(unit);
    close(quantity.value, expected[c]!, tolerance);
  });
}

function staticLedger(result: ResultSummary) {
  expect(result.staticEquilibrium).toBeDefined();
  return result.staticEquilibrium!;
}

for (const divisions of [2, 4, 8]) {
  test(`@cpu B25 pure bending and torsion retain visible force and moment checks at ${divisions} divisions`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.addInitScript(() => {
      localStorage.setItem('femlab.tour.dismissed', '1');
      localStorage.setItem('femlab.autosave', 'off');
    });
    await page.goto('./');
    await page.waitForFunction(() => Boolean(window.fem), undefined, { timeout: 60_000 });
    const commands = benchmark.journal.map(command => ({ ...command,
      ...(command.cmd === 'geometry.addLine' ? { divisions } : {}),
      ...(command.cmd === 'solve.run' ? { solver: 'cpu-direct' as const } : {}),
    })) as Command[];
    await page.evaluate(async input => { for (const command of input) await window.fem.dispatch(command); }, commands);
    await expect(page.locator('.workspace')).toBeVisible();
    const sampled = await page.evaluate(async () => ({
      twist: await window.fem.query.result({ step: 'static' }),
      bend: await window.fem.query.result({ step: 'bend' }),
      twistAngle: await window.fem.query.probe({ step: 'static', field: 'rotation', component: 0, at: ['1 m', '0 m', '0 m'] }),
      bendSlope: await window.fem.query.probe({ step: 'bend', field: 'rotation', component: 1, at: ['1 m', '0 m', '0 m'] }),
      bendDeflection: await window.fem.query.probe({ step: 'bend', field: 'displacement', component: 2, at: ['1 m', '0 m', '0 m'] }),
      report: await window.fem.query.report(),
    }));
    for (const [result, applied] of [[sampled.twist, [1000, 0, 0]], [sampled.bend, [0, 1000, 0]]] as const) {
      const ledger = staticLedger(result);
      vector(ledger.reference, [0, 0, 0], 'mm');
      expect(ledger.characteristicLength.unit).toBe('mm');
      close(ledger.characteristicLength.value, 1000, 1e-8);
      vector(result.appliedTotal, [0, 0, 0], 'kN');
      vector(result.reactions[0]!.total, [0, 0, 0], 'kN');
      vector(ledger.forceResidual, [0, 0, 0], 'kN');
      vector(ledger.appliedMoment, [...applied], 'kN mm');
      expect(ledger.reactionMoments[0]!.constraint).toBe('root');
      vector(ledger.reactionMoments[0]!.total, applied.map(v => -v), 'kN mm');
      vector(ledger.momentResidual, [0, 0, 0], 'kN mm', 1e-6);
      expect(ledger.forceScale.unit).toBe('kN');
      expect(ledger.momentScale.unit).toBe('kN mm');
      expect(ledger.forceScale.value).toBeGreaterThanOrEqual(1);
      expect(ledger.momentScale.value).toBeGreaterThanOrEqual(1000);
      expect(result.balance).toBeLessThanOrEqual(1e-9);
      expect(ledger.momentBalance).toBeLessThanOrEqual(1e-9);
    }
    const inertia = Math.PI * 0.05 ** 4 / 4;
    const shear = 200e9 / (2 * 1.3);
    const twist = 1000 / (shear * 2 * inertia);
    const slope = 1000 / (200e9 * inertia);
    expect(sampled.twistAngle.value.unit).toBe('rad');
    expect(sampled.bendSlope.value.unit).toBe('rad');
    expect(sampled.bendDeflection.value.unit).toBe('mm');
    close(sampled.twistAngle.value.value, twist, twist * 1e-9);
    close(sampled.bendSlope.value.value, slope, slope * 1e-9);
    close(sampled.bendDeflection.value.value, -1000 * slope / 2, slope * 1e-6);
    expect(sampled.report.markdown).toContain('Moment residual');
    const queriedVerdicts = sampled.report.markdown.split('\n').filter(line => line.includes('Static moment balance'));
    expect(queriedVerdicts.length).toBeGreaterThan(0);
    expect(queriedVerdicts.every(line => line.includes('**pass**'))).toBe(true);

    await page.evaluate(() => window.fem.dispatch({ cmd: 'panel.toggle', panel: 'report', open: true }));
    const paper = page.locator('.report-paper');
    await expect(paper).toBeVisible({ timeout: 60_000 });
    await expect(paper).toContainText('Static force residual');
    await expect(paper).toContainText('Moment residual');
    await expect(paper).toContainText('kN mm');
    const momentChecks = paper.locator('p, li').filter({ hasText: 'Static moment balance' });
    await expect(momentChecks.first()).toBeVisible();
    expect((await momentChecks.allTextContents()).every(line => line.includes('pass') && !line.includes('fail'))).toBe(true);
    const forceChecks = paper.locator('p, li').filter({ hasText: 'Reaction balance' });
    expect(await forceChecks.count()).toBeGreaterThan(0);
    expect((await forceChecks.allTextContents()).every(line => line.includes('pass') && !line.includes('fail'))).toBe(true);
    await expect(page.locator('.report-figure img')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export PDF', exact: true })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath(`static-equilibrium-${divisions}.png`), fullPage: false });
  });
}
