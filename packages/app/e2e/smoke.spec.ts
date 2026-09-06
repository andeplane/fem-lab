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

async function expectCanvasSized(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.locator('.viewer canvas').evaluate((el) => {
        const canvas = el as HTMLCanvasElement;
        const scale = Math.min(devicePixelRatio, 2);
        return [canvas.width - Math.round(canvas.clientWidth * scale), canvas.height - Math.round(canvas.clientHeight * scale)];
      }),
    )
    .toEqual([0, 0]);
}

test.describe('@cpu the shell', () => {
  test('camera shortcuts move the view without touching the Journal or typed input', async ({ page }) => {
    await page.goto('./');
    await ready(page);
    await page.evaluate(() => window.fem.model.new({ name: 'camera-shortcuts' }));
    await page.waitForFunction(async () => {
      try {
        await window.fem.registry.query({ query: 'query.view' });
        return true;
      } catch {
        return false;
      }
    });
    const journal = await page.evaluate(() => window.fem.query.journal());
    const shortcuts = ['Digit1', 'Digit2', 'Digit3', 'Digit4'];
    for (let i = 0; i < shortcuts.length; i++) {
      const before = await page.evaluate(async (n) => {
        await window.fem.dispatch({ cmd: 'view.setCamera', position: [10 + n, 11 + n, 12 + n], target: [0, 0, 0] });
        return window.fem.registry.query({ query: 'query.view' });
      }, i);
      await page.keyboard.press(`Shift+${shortcuts[i]}`);
      await expect.poll(() => page.evaluate(() => window.fem.registry.query({ query: 'query.view' }))).not.toEqual(before);
    }

    const input = page.locator('.props input').first();
    await input.focus();
    const beforeTyping = await page.evaluate(() => window.fem.registry.query({ query: 'query.view' }));
    const value = await input.inputValue();
    await page.keyboard.press('Shift+Digit1');
    expect(await input.inputValue()).toContain('!');
    expect(await input.inputValue()).not.toBe(value);
    expect(await page.evaluate(() => window.fem.registry.query({ query: 'query.view' }))).toEqual(beforeTyping);
    expect(await page.evaluate(() => window.fem.query.journal())).toEqual(journal);
  });

  test('Assistant stays on the right and spans the workspace when toggled', async ({ page }) => {
    await page.goto('./');
    await ready(page);
    await page.evaluate(() => window.fem.model.new({ name: 'assistant-layout' }));
    for (const width of [1600, 1494, 1280, 1180, 1100]) {
      await page.setViewportSize({ width, height: 900 });
      await expectCanvasSized(page);
      for (let cycle = 0; cycle < 2; cycle++) {
        await page.locator('.topbar').getByRole('button', { name: '✳ Assistant', exact: true }).click();
        const assistant = page.locator('.assistant');
        await expect(assistant).toBeVisible();
        const drawer = (await assistant.boundingBox())!;
        const workspace = (await page.locator('.workspace').boundingBox())!;
        const properties = (await page.locator('.workspace > .panel').last().boundingBox())!;
        const banner = (await page.locator('.banner').boundingBox())!;
        expect(drawer.width).toBe(392);
        expect(drawer.y).toBe(workspace.y);
        expect(drawer.height).toBe(workspace.height);
        expect(drawer.x + drawer.width).toBe(width);
        expect(banner.x + banner.width).toBe(width);
        if (width >= 1494) {
          expect(drawer.x).toBe(properties.x + properties.width);
        } else {
          expect(properties.x + properties.width).toBe(width);
        }
        expect(drawer.x).toBeGreaterThanOrEqual(workspace.x);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await expectCanvasSized(page);
        await assistant.getByTitle('Close the assistant', { exact: true }).click();
        await expect(assistant).toBeHidden();
        const centre = (await page.locator('.centre').boundingBox())!;
        expect(centre.y).toBe(workspace.y);
        expect(centre.height).toBe(workspace.height);
        await expectCanvasSized(page);
      }
    }

    await page.evaluate(() => window.fem.dispatch({ cmd: 'file.openExample', name: 'cantilever' }));
    await expect(page.locator('.banner')).toHaveCount(0);
    await page.setViewportSize({ width: 1600, height: 900 });
    await expectCanvasSized(page);
    await page.locator('.topbar').getByRole('button', { name: '✳ Assistant', exact: true }).click();
    const assistant = page.locator('.assistant');
    await expect(assistant).toBeVisible();
    const drawer = (await assistant.boundingBox())!;
    const workspace = (await page.locator('.workspace').boundingBox())!;
    expect(drawer.y).toBe(workspace.y);
    expect(drawer.height).toBe(workspace.height);
    await expectCanvasSized(page);
    await assistant.getByTitle('Close the assistant', { exact: true }).click();
    await expect(assistant).toBeHidden();
    await expectCanvasSized(page);
  });

  test('boots, builds a Model from window.fem, and shows it', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const t0 = Date.now();
    await page.goto('./');

    // The start screen is up before the engine is.
    await expect(page.locator('.start')).toBeVisible();
    const painted = Date.now() - t0;
    const loadedFonts = await page.evaluate(async () => {
      const specs = ["400 12px 'IBM Plex Sans'", "500 12px 'IBM Plex Sans'", "600 12px 'IBM Plex Sans'", "400 12px 'IBM Plex Mono'", "500 12px 'IBM Plex Mono'", "600 12px 'IBM Plex Mono'"];
      await Promise.all(specs.map((spec) => document.fonts.load(spec)));
      await document.fonts.ready;
      return [...document.fonts].filter((font) => font.status === 'loaded').map((font) => `${font.family}:${font.weight}`);
    });
    for (const family of ['IBM Plex Sans', 'IBM Plex Mono']) {
      for (const weight of ['400', '500', '600']) expect(loadedFonts).toContain(`${family}:${weight}`);
    }
    await ready(page);
    // `store.ready` flips the start screen's build control; before it, `project.new` is disabled
    // (asserting *that* would be a race against a fast engine, so only the flip is checked).
    await expect(page.locator('button[title="project.new"]')).toBeEnabled();

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

  test('collapsing the Assistant preserves its draft, references and transcript', async ({ page }) => {
    await page.goto('./');
    await ready(page);
    await page.evaluate(() => window.fem.model.new({ name: 'assistant-collapse' }));
    await page.evaluate(() => window.fem.geometry.addBox({ name: 'beam', size: ['1 m', '100 mm', '100 mm'] }));
    await expect(page.locator('.assistant')).toHaveCount(0);
    await page.evaluate(() => window.fem.dispatch({ cmd: 'panel.toggle', panel: 'assistant', open: true }));
    const drawer = page.locator('.assistant');
    await expect(drawer).toBeVisible();
    await drawer.locator('textarea').fill('Check the beam');
    await page.evaluate(() => window.fem.dispatch({ cmd: 'chat.insertMention', ref: 'body:beam' }));
    await expect(drawer.locator('.token')).toContainText('@body:beam');
    await drawer.locator('button.send').click();
    await expect(drawer.locator('.bad-line')).toContainText('API key');
    await drawer.locator('button[title="Close the assistant"]').click();
    await expect(drawer).toBeHidden();
    await page.evaluate(() => window.fem.dispatch({ cmd: 'panel.toggle', panel: 'assistant', open: true }));
    await expect(drawer.locator('.bad-line')).toContainText('API key');
    await expect(drawer.locator('textarea')).toHaveValue('Check the beam');
    await expect(drawer.locator('.token')).toContainText('@body:beam');
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

  // Issue #39's second half, which happy-dom cannot answer: the picker is a box on a screen, and
  // it has to sit between the skills row and the composer rather than on top of either.
  test('the @ picker opens below the skills row and above the composer', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
    await page.goto('./');
    await ready(page);
    await page.evaluate(() => window.fem.model.new({ name: 'mentions' }));
    await page.evaluate(() => window.fem.geometry.addBox({ name: 'beam', size: ['1 m', '100 mm', '100 mm'] }));
    await page.evaluate(() => window.fem.dispatch({ cmd: 'panel.toggle', panel: 'assistant', open: true }));

    const box = page.locator('.assistant textarea');
    await box.click();
    await box.pressSequentially('@');
    const popover = page.locator('.assistant .popover');
    await expect(popover).toBeVisible();
    await expect(popover).toContainText('beam');

    const [strip, list, composer] = await Promise.all([page.locator('.assistant .strip').boundingBox(), popover.boundingBox(), page.locator('.assistant .composer').boundingBox()]);
    expect(list!.y).toBeGreaterThanOrEqual(strip!.y + strip!.height);
    expect(list!.y + list!.height).toBeLessThanOrEqual(composer!.y + 1);
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
    // The name is the project's, renameable in place, so it is an input rather than a span.
    await expect(page.locator('.model-name')).toHaveValue(longName);
    await expect(page.locator('.model-name')).toHaveAttribute('title', longName);
    const solve = page.locator('button.solve');
    await expect(solve).toHaveText(/Solved/);
    await expect(solve).toHaveAttribute('title', /Solved · rev 10 — solve\.run static/);

    // Include both sides of each responsive transition as well as the four acceptance widths.
    const widths = [1180, 1199, 1200, 1280, 1299, 1300, 1440, 1599, 1600];
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
