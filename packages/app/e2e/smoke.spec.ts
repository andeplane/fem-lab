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
    const t0 = Date.now();
    await page.goto('./');

    // The start screen is up before the engine is.
    await expect(page.getByText('Open an example')).toBeVisible();
    const painted = Date.now() - t0;
    await ready(page);
    // `store.ready` flips the start screen's build control; before it, `model.new` is disabled
    // (asserting *that* would be a race against a fast engine, so only the flip is checked).
    await expect(page.locator('button[title="model.new"]')).toBeEnabled();

    // Reported, never asserted on: CI runners have no timing guarantees (AGENTS.md, ADR 0007).
    // What the budget cares about is the *gap* — the start screen minus the wasm.
    const dcl = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
      return Math.round(nav.domContentLoadedEventEnd);
    });
    const line = `boot: DOMContentLoaded ${dcl} ms · start screen ${painted} ms · engine ready ${Date.now() - t0} ms (from goto)`;
    console.log(line);
    await testInfo.attach('boot-timings.txt', { body: line, contentType: 'text/plain' });

    await page.evaluate(() => window.fem.model.new({ name: 'smoke' }));
    await page.evaluate(() => window.fem.geometry.addBox({ name: 'beam', size: ['1 m', '100 mm', '100 mm'] }));

    const model = (await page.evaluate(() => window.fem.query.model())) as unknown as { bodies: { name: string }[]; revision: number };
    expect(model.bodies.map((b) => b.name)).toEqual(['beam']);
    expect(model.revision).toBe(2);

    // The Journal panel shows the same two lines.
    const journal = page.locator('.bottom-body');
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

  test('keeps every top-bar action visible and keyboard reachable at supported desktop widths', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
    await page.goto('./');
    await ready(page);
    const longName = 'Very_long_structural_model_revision_2026_final';
    await page.evaluate(async (name) => {
      const response = await fetch('./examples/cantilever.json');
      const entries = (await response.json()) as { cmd: Record<string, unknown> }[];
      for (const entry of entries) {
        const cmd = entry.cmd['cmd'] === 'model.new' ? { ...entry.cmd, name } : entry.cmd;
        await window.fem.dispatch(cmd as Parameters<typeof window.fem.dispatch>[0]);
      }
    }, longName);
    await expect(page.locator('.model-name')).toHaveText(longName);
    await expect(page.locator('.model-name')).toHaveAttribute('title', longName);
    const solve = page.locator('button.solve');
    await expect(solve).toHaveText(/Solved/);
    await expect(solve).toHaveAttribute('title', /Solved · rev 10 — solve\.run static/);

    // Include both sides of each responsive transition as well as the four acceptance widths.
    const widths = [1180, 1199, 1200, 1280, 1440, 1599, 1600];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      const layout = await page.locator('.topbar').evaluate((header) => {
        const bar = header.getBoundingClientRect();
        const items = [...header.children]
          .map((element) => ({ text: element.textContent?.trim() ?? '', rect: element.getBoundingClientRect().toJSON() }))
          .filter(({ rect }) => rect.width > 0);
        return { bar: bar.toJSON(), clientWidth: header.clientWidth, scrollWidth: header.scrollWidth, items };
      });
      expect(layout.scrollWidth, `top bar overflows at ${width}px`).toBe(layout.clientWidth);
      for (const item of layout.items) {
        expect(item.rect.left, `${item.text} starts outside the ${width}px top bar`).toBeGreaterThanOrEqual(layout.bar.left);
        expect(item.rect.right, `${item.text} ends outside the ${width}px top bar`).toBeLessThanOrEqual(layout.bar.right);
      }
      for (let i = 1; i < layout.items.length; i++) {
        expect(layout.items[i - 1]!.rect.right, `${layout.items[i - 1]!.text} overlaps ${layout.items[i]!.text} at ${width}px`).toBeLessThanOrEqual(
          layout.items[i]!.rect.left,
        );
      }

      const label = page.locator('.palette-field span').first();
      await expect(label).toBeVisible();
      expect((await label.boundingBox())!.width, `command label has no useful room at ${width}px`).toBeGreaterThan(18);
    }

    // Undoing the solve makes Redo an enabled keyboard stop; now every top-bar button can be
    // reached in DOM order, including actions whose disabled state normally removes them.
    await page.evaluate(() => window.fem.journal.undo({ steps: 1 }));
    await expect(page.locator('button[data-cmd="journal.redo"]')).toBeEnabled();
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      const stops = page.locator('.topbar button:not(:disabled)');
      const stopCount = await stops.count();
      await stops.first().focus();
      for (let i = 0; i < stopCount; i++) {
        const stop = stops.nth(i);
        await expect(stop).toBeFocused();
        const focus = await stop.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const bar = element.closest('.topbar')!.getBoundingClientRect();
          return { left: rect.left, right: rect.right, barLeft: bar.left, barRight: bar.right, outline: getComputedStyle(element).outlineStyle };
        });
        expect(focus.left).toBeGreaterThanOrEqual(focus.barLeft);
        expect(focus.right).toBeLessThanOrEqual(focus.barRight);
        expect(focus.outline).toBe('solid');
        if (i + 1 < stopCount) await page.keyboard.press('Tab');
      }
    }
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

  // Benchmark B1 through the whole browser stack: wasm engine, WebGPU device, f32 conjugate
  // gradient inside the f64 refinement loop. SwiftShader is slow, so this one is `test.slow()`.
  test('solves the cantilever on the GPU and lands on the beam formula', async ({ page }) => {
    test.slow();
    await page.goto('./');
    await ready(page);
    const uz = await page.evaluate(async () => {
      await window.fem.model.new({ name: 'gpu-cantilever' });
      await window.fem.model.setUnits({ units: { length: 'mm', stress: 'MPa', force: 'kN' } });
      await window.fem.geometry.addBox({ name: 'beam', size: ['1 m', '100 mm', '100 mm'] });
      await window.fem.material.add({ name: 'steel', E: '210 GPa', nu: 0.3 });
      await window.fem.material.assign({ material: 'steel', bodies: ['beam'] });
      await window.fem.mesh.set({ mesher: { kind: 'lattice', size: '25 mm' }, order: 1 });
      await window.fem.constraint.fix({ name: 'root', on: 'beam.xmin' });
      await window.fem.load.traction({ name: 'tip', on: 'beam.xmax', total: ['0 N', '0 N', '-1 kN'] });
      await window.fem.step.add({ name: 'static', procedure: 'static', constraints: ['root'], loads: ['tip'] });
      await window.fem.solve.run({ step: 'static', solver: 'gpu-pcg' });
      const result = (await window.fem.query.result({})) as unknown as { solver: string };
      if (result.solver !== 'gpu-pcg') throw new Error(`solved with ${result.solver}, not the GPU`);
      const probe = (await window.fem.query.probe({ field: 'displacement', component: 2, at: ['1 m', '50 mm', '50 mm'] })) as unknown as {
        value: { value: number };
      };
      return probe.value.value;
    });
    // δ = PL³/(3EI) + PL/(κGA) = 0.1919619 mm; the hexahedron is within 2 % of it at 25 mm.
    expect(Math.abs(Math.abs(uz) - 0.1919619) / 0.1919619).toBeLessThan(0.02);
  });
});
