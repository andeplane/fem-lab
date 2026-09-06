// The post-processing UI, end to end against the real engine: a modal Step's frequencies and
// mode shapes, a transient Step's history plot, and the derived checks a yield makes possible.
// The two Journals live in `fixtures/` rather than in the gallery, because the gallery is the
// content agent's; they are dispatched Command by Command exactly as `file.openExample` does.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from './fixtures';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const journal = (name: string): Record<string, unknown>[] => JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')) as Record<string, unknown>[];

async function ready(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
  await page.waitForFunction(async () => Boolean(await window.fem.query.capabilities()), undefined, { timeout: 60_000 });
}

/** Replay a fixture Journal and solve its Step, the way the gallery and a script both would. */
async function open(page: Page, name: string, step: string): Promise<void> {
  await page.evaluate(async (cmds) => {
    for (const c of cmds) await window.fem.dispatch(c as never);
  }, journal(name));
  await page.locator('button.solve').click();
  await expect(page.locator('button.solve')).toHaveText(/Solved · rev \d+/, { timeout: 180_000 });
  await expect(page.locator('.legend-sub')).toContainText(step);
}

test.describe('@cpu the Results tab after a modal Step', () => {
  test.setTimeout(240_000);

  test('frequencies, the mode picker, and the sweep on the deformation bar', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await ready(page);
    await open(page, 'cantilever-modal', 'modes');

    // A modal Step computes no stress, so the viewer opens on the first mode shape rather than
    // failing to find `vonMises` — and the legend says which one.
    await expect(page.locator('.legend-field')).toHaveText('mode 1');
    await expect(page.locator('.legend-unit')).toHaveText('mm');

    // The frequencies the engine found, against the cantilever's first bending pair: the square
    // section has two identical modes, and Euler-Bernoulli puts them near 83 Hz.
    const f = await page.evaluate(async () => ((await window.fem.query.result()) as unknown as { frequencies: { value: number; unit: string }[] }).frequencies);
    expect(f).toHaveLength(4);
    expect(f[0]!.unit).toBe('Hz');
    expect(f[0]!.value).toBeGreaterThan(70);
    expect(f[0]!.value).toBeLessThan(95);
    expect(f[1]!.value).toBeCloseTo(f[0]!.value, 0);

    const table = page.locator('.rtable', { hasText: 'frequency' });
    await expect(table.locator('tbody tr')).toHaveCount(4);
    await expect(table.locator('tbody tr').first()).toContainText('Hz');
    // The period beside it, so a dynamics check can be read straight off the table.
    await expect(table.locator('tbody tr').first()).toContainText(' s');

    // Every mode is one `view.showField`, in the table and in the tree alike.
    await expect(page.locator('.tree [data-cmd="view.showField"]', { hasText: 'mode 2' })).toHaveCount(1);
    await table.locator('tbody tr').nth(1).locator('[data-cmd="view.showField"]').click();
    await expect(page.locator('.legend-field')).toHaveText('mode 2');
    await expect(page.locator('.legend .field-chip[aria-pressed="true"]')).toHaveText('mode 2');

    // A mode shape has no amplitude of its own, so it opens exaggerated and never at zero.
    const scale = await page.evaluate(() => Number(document.querySelector('.deform-bar .mono')!.textContent!.replace('×', '')));
    expect(scale).toBeGreaterThan(0);

    // Play, pause, and the scrub the sweep gives.
    const play = page.locator('.deform-bar button[data-cmd="view.animate"]');
    await expect(play).toHaveText('▶');
    await play.click();
    await expect(play).toHaveText('❚❚');
    await expect(play).toHaveAttribute('aria-pressed', 'true');
    const phase = page.locator('.deform-bar input.phase');
    await expect(phase).toBeVisible();
    await phase.fill('50');
    await phase.dispatchEvent('input');
    await expect(play).toHaveText('▶');

  });
});

test.describe('@cpu the Results tab after a transient Step', () => {
  test.setTimeout(240_000);

  test('the history plot, its axes in the Step\'s units, and its hover readout', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await ready(page);
    await open(page, 'bar-heat-transient', 'warmup');

    // Thirteen output times from dt 5 s to tEnd 60 s, and the bar really does warm up.
    const history = await page.evaluate(async () => ((await window.fem.query.result()) as unknown as { history: { time: { value: number }; max: { value: number } }[] }).history);
    expect(history.length).toBeGreaterThan(5);
    expect(history[history.length - 1]!.max.value).toBeGreaterThan(history[0]!.max.value);

    await page.locator('.tab', { hasText: 'results' }).click();
    const chart = page.locator('.chart').first();
    await expect(page.locator('.bottom-body')).toContainText('History · warmup');
    // One point per output time, on the max and on the min.
    const points = await chart.locator('polyline').getAttribute('points');
    expect(points!.split(' ')).toHaveLength(history.length);
    await expect(page.locator('.bottom-body .chart')).toHaveCount(2);
    await expect(chart.locator('.chart-readout')).toContainText('max (K) against t (s)');

    // Hovering names the point under the pointer, which is what a history is read for. The
    // bottom panel is 252 px, so the plot has to be scrolled to before it can be pointed at.
    await chart.scrollIntoViewIfNeeded();
    const box = (await chart.locator('svg').boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.5);
    await expect(chart.locator('circle')).toHaveCount(1);
    await expect(chart.locator('.chart-readout')).not.toContainText('hover to read');
    await expect(chart.locator('.chart-readout')).toContainText(' s · max ');

  });
});

test.describe('@cpu the derived checks and the image resolution', () => {
  test.setTimeout(240_000);

  test('safety and utilisation from the Material\'s yield, and 1x / 2x on the PNG row', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await ready(page);
    // The modal fixture's Model, solved as a static Step instead: it has the yield.
    await page.evaluate(async (cmds) => {
      for (const c of cmds) await window.fem.dispatch(c as never);
      await window.fem.step.add({ name: 'uls', procedure: 'static', constraints: ['root'], loads: ['tip'] });
      await window.fem.solve.run({ step: 'uls' });
    }, journal('cantilever-modal'));
    await expect(page.locator('button.solve')).toHaveText(/Solved · rev \d+/, { timeout: 180_000 });

    // Both derived rows are in the picker and in the tree, because a Material named a yield.
    await expect(page.locator('.legend .field-chip', { hasText: 'n_y' })).toHaveCount(1);
    const util = page.locator('.legend .field-chip', { hasText: 'σ/f_y' });
    await expect(util).toHaveCount(1);
    await util.click();

    // A utilisation is a pure number, and its legend opens against the limit of 1.
    await expect(page.locator('.legend-field')).toHaveText('σ/f_y');
    await expect(page.locator('.legend-unit')).toHaveText('');
    const ticks = await page.locator('.legend .tick').allTextContents();
    expect(Number(ticks[0])).toBeGreaterThanOrEqual(1);
    expect(Number(ticks[ticks.length - 1])).toBe(0);
    // Sanity: this beam is nowhere near yield, so the utilisation is a small fraction.
    const peak = await page.evaluate(async () => {
      const r = (await window.fem.query.result()) as unknown as { extremes: { field: string; max: { value: number; unit: string } }[] };
      return r.extremes.find((e) => e.field === 'vonMises')!.max;
    });
    expect(peak.value / 355).toBeLessThan(1);

    // A safety factor is the same number the other way up.
    await page.locator('.legend .field-chip', { hasText: 'n_y' }).click();
    await expect(page.locator('.legend-field')).toHaveText('n_y');

    // The export dialog's viewer image offers both resolutions, each one Command.
    await page.locator('button.tbutton', { hasText: 'Export' }).click();
    const png = page.locator('.export-row', { hasText: 'Viewer image' });
    await expect(png.locator('[data-cmd="query.screenshot"]')).toHaveCount(2);
    await expect(png.locator('[data-cmd="query.screenshot"]').nth(1)).toHaveText('2×');
    const shot = await page.evaluate(async () => ((await window.fem.registry.query({ query: 'query.screenshot', width: 800, height: 600 })) as { png: string }).png.slice(0, 22));
    expect(shot).toBe('data:image/png;base64,');

  });
});
