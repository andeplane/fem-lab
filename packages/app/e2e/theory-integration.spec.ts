import type { ProjectMeta } from '@femlab/registry';
import { expect, test } from '@playwright/test';

test('@cpu theory retains live reference and warns on edited model', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'file.openExample', name: 'cantilever' }));
  await page.locator('.tab', { hasText: 'results' }).click();
  const panel = page.locator('.theory-panel');
  await expect(panel.locator('.theory-values')).toBeVisible();
  await expect(panel.locator('.katex')).not.toHaveCount(0);
  await expect(panel.locator('.surface.pass')).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('theory-current.png') });

  await page.evaluate(() => window.fem.material.add({ name: 'steel', E: '200 GPa', nu: 0.3 }));
  await expect(panel).toHaveClass(/stale/);
  await expect(panel.locator('.surface.pass')).toHaveCount(0);
  await page.evaluate(() => window.fem.solve.run({ step: 'static' }));
  await expect(panel).toContainText('modified example');
  await expect(panel.locator('.surface.pass')).toHaveCount(0);
  await page.evaluate(() => window.fem.model.new({ name: 'unrelated' }));
  await expect(panel).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('@cpu project replacements clear theory only after success', async ({ page }) => {
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined');
  const project = await page.evaluate(() => window.fem.dispatch({ cmd: 'project.new', name: 'unrelated project' })) as ProjectMeta;
  const panel = page.locator('.theory-panel');
  const openBenchmark = async () => {
    await page.evaluate(() => window.fem.dispatch({ cmd: 'file.openExample', name: 'cantilever' }));
    await page.locator('.tab', { hasText: 'results' }).click();
    await expect(panel.locator('.theory-values')).toBeVisible();
  };

  await openBenchmark();
  const failed = await page.evaluate(async () => {
    try {
      await window.fem.dispatch({ cmd: 'project.open', id: 'missing-project' });
      return false;
    } catch {
      return true;
    }
  });
  expect(failed).toBe(true);
  await expect(panel.locator('.theory-values')).toBeVisible();
  await page.evaluate((id) => window.fem.dispatch({ cmd: 'project.open', id }), project.id);
  await expect(panel).toHaveCount(0);

  await openBenchmark();
  await page.evaluate(() => window.fem.dispatch({ cmd: 'project.new', name: 'fresh project' }));
  await expect(panel).toHaveCount(0);
  await openBenchmark();
  // A failed lookup preserves the active reference; public example.open replaces it on success.
  const exampleFailed = await page.evaluate(async () => {
    try {
      await window.fem.dispatch({ cmd: 'example.open', name: 'missing-example' });
      return false;
    } catch {
      return true;
    }
  });
  expect(exampleFailed).toBe(true);
  await expect(panel.locator('.theory-values')).toBeVisible();
  await page.evaluate(() => window.fem.dispatch({ cmd: 'example.open', name: 'cantilever-hex20' }));
  await expect(panel).toHaveAttribute('aria-label', 'Theory for Cantilever beam, hex20');
  await expect(panel.locator('.theory-values')).toBeVisible();
  await expect(panel.locator('.surface.pass')).toHaveCount(1);
});
