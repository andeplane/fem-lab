// The three smokes of plan B §8. They drive the app the way the AI and the DevTools MCP do —
// through `window.fem` — and then check that what a person sees agrees with what the engine says.
import { expect, test, type Page } from '@playwright/test';

// `window.fem` is typed by `src/main.tsx`'s `declare global`, so these calls are checked against
// the generated schema exactly as a user's script would be.

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
  // The first call queues behind the engine's construction, so this returns only once wasm is up.
  await page.waitForFunction(async () => Boolean(await window.fem.query.capabilities()), undefined, { timeout: 60_000 });
}

test.describe('@cpu the shell', () => {
  test('boots, builds a Model from window.fem, and shows it', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('./');

    // The start screen is up before the engine is.
    await expect(page.getByText('Open an example')).toBeVisible();
    await ready(page);

    // `model.new` is a construct signature in the generated `fem.d.ts`, so it goes through
    // `dispatch` rather than the proxy's dotted form.
    await page.evaluate(() => window.fem.dispatch({ cmd: 'model.new', name: 'smoke' }));
    await page.evaluate(() => window.fem.geometry.addBox({ name: 'beam', size: ['1 m', '100 mm', '100 mm'] }));

    const model = (await page.evaluate(() => window.fem.query.model())) as unknown as { bodies: { name: string }[]; revision: number };
    expect(model.bodies.map((b) => b.name)).toEqual(['beam']);
    expect(model.revision).toBe(2);

    // The Journal panel shows the same two lines.
    const journal = page.locator('.log');
    await expect(journal).toContainText('model.new');
    await expect(journal).toContainText('geometry.addBox');
    await expect(page.locator('canvas')).toBeVisible();
    await expect(page.getByText('rev 2')).toBeVisible();

    // ADR 0003 in the built DOM, not only in vitest.
    const unknown = await page.evaluate(() => {
      const { commands, queries } = window.fem.registry.list();
      const known = new Set([...commands, ...queries].map((d) => d.name));
      return [...document.querySelectorAll('[data-cmd]')].map((el) => el.getAttribute('data-cmd')!).filter((c) => !known.has(c));
    });
    expect(unknown).toEqual([]);

    await testInfo.attach('shell.png', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    expect(errors).toEqual([]);
  });

  test('opens the bundled cantilever example as its own Journal', async ({ page }) => {
    await page.goto('./');
    await ready(page);
    await page.evaluate(() => window.fem.dispatch({ cmd: 'file.openExample', name: 'cantilever' }));
    const model = (await page.evaluate(() => window.fem.query.model())) as unknown as { name: string; bodies: { name: string }[] };
    expect(model.name).toBe('cantilever');
    expect(model.bodies.length).toBeGreaterThan(0);
  });

  test('reports an engine error as a structured error, not a crash', async ({ page }) => {
    await page.goto('./');
    await ready(page);
    const error = await page.evaluate(async () => {
      try {
        await window.fem.geometry.addBox({ name: 'x', size: ['1 banana', '1 m', '1 m'] });
        return null;
      } catch (e) {
        return { code: (e as { code: string }).code, cause: (e as { cause: string }).cause };
      }
    });
    expect(error?.code).toBeTruthy();
  });
});

test.describe('@sw without server headers', () => {
  test('the coi service worker makes the page cross-origin isolated after one reload', async ({ page }) => {
    await page.goto('./');
    // The first visit registers the worker and reloads itself once; the guard stops a loop.
    await page.waitForFunction(() => window.crossOriginIsolated === true, undefined, { timeout: 60_000 });
    expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true);
    await ready(page);
    const caps = (await page.evaluate(() => window.fem.query.capabilities())) as unknown as { crossOriginIsolated: boolean; threads: number };
    expect(caps.crossOriginIsolated).toBe(true);
    expect(caps.threads).toBeGreaterThan(0);
  });
});

test.describe('@gpu on SwiftShader', () => {
  test('the engine gets a WebGPU adapter and the dot-product kernel is right', async ({ page }) => {
    await page.goto('./');
    await ready(page);
    const caps = (await page.evaluate(() => window.fem.query.capabilities())) as unknown as { gpu: boolean; adapter: string | null };
    expect(caps.gpu).toBe(true);
    // Σ i for i in 1..=1000
    expect(await page.evaluate(() => window.fem.gpuSelfTest(1000))).toBe(500500);
  });
});
