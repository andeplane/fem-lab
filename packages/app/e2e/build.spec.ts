// The design's build flow, driven the way a person drives it: the start screen, the Properties
// forms, the tree's `+ add …` chips and the ⌘K palette. The nine Commands are exactly the
// `crates/engine/benches/journals/cantilever.json` fixture, so the Model hash at the end has to
// be that fixture's last `hashAfter` — a UI that fills the forms wrongly cannot pass this.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const SHOTS = path.join(import.meta.dirname, 'screenshots');
const FIXTURE = path.join(import.meta.dirname, '../../../crates/engine/benches/journals/cantilever.json');
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { seq: number; cmd: Record<string, unknown>; hashAfter: string }[];
// The fixture ends on `solve.run` so the gallery opens it solved; the forms build the Model, which
// is everything before that line (a solve leaves the Model hash unchanged).
const journal = fixture.filter((e) => !String(e.cmd.cmd).startsWith('solve.'));

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
  await page.waitForFunction(async () => Boolean(await window.fem.query.capabilities()), undefined, { timeout: 60_000 });
}

async function shot(page: Page, name: string): Promise<void> {
  if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
}

/** Type into one field of the Properties form, named by its path in the Command. */
const field = (page: Page, path: string) => page.locator(`[data-field="${path}"]`);
const fill = async (page: Page, path: string, value: string, nth = 0): Promise<void> => {
  await field(page, path).locator('input').nth(nth).fill(value);
};
const apply = async (page: Page): Promise<void> => {
  await page.locator('.props .apply').click();
  await expect(page.locator('.props .surface.error')).toHaveCount(0);
};

/** ⌘K, filter, ⇥ — the palette's "fill parameters" path. */
async function palette(page: Page, query: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k');
  await page.locator('.palette-head input').fill(query);
  await expect(page.locator('.prow').first()).toContainText(query);
  await page.keyboard.press('Tab');
  await expect(page.locator('.palette')).toHaveCount(0);
}

test.describe('@cpu the cantilever, built through the UI', () => {
  test.setTimeout(180_000);

  test('nine forms produce the fixture Journal, hash for hash', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
    await page.goto('./');
    await expect(page.getByText('Start a tutorial')).toBeVisible();
    await ready(page);
    await shot(page, '01-start');

    // 0 · model.new, named on the start card.
    await page.getByLabel('model name').fill('cantilever');
    await page.locator('button[title="model.new"]').click();
    await expect(page.locator('.workspace')).toBeVisible();
    await shot(page, '02-empty-model');

    // 1 · model.setUnits — mm, kN, MPa is not one of the two top-bar presets, so it comes from
    // the palette and the generated sub-form for `UnitSet`.
    await palette(page, 'model.setUnits');
    await fill(page, 'units.length', 'mm');
    await fill(page, 'units.force', 'kN');
    await fill(page, 'units.stress', 'MPa');
    await apply(page);

    // 2 · geometry.addBox, the form the shell opens by itself (design state 1).
    await page.locator('.chip-add', { hasText: '+ add body' }).click();
    await fill(page, 'name', 'beam');
    await fill(page, 'size', '1 m', 0);
    await fill(page, 'size', '100 mm', 1);
    await fill(page, 'size', '100 mm', 2);
    await expect(page.locator('.recorded-cmd')).toContainText('await fem.geometry.addBox({ name: "beam", size: ["1 m", "100 mm", "100 mm"] });');
    await apply(page);
    await shot(page, '03-body');

    // 3 · material.add from the tree's empty-group chip.
    await page.locator('.chip-add', { hasText: '+ add material' }).click();
    await fill(page, 'name', 'steel');
    await fill(page, 'E', '210 GPa');
    await fill(page, 'nu', '0.3');
    await fill(page, 'rho', '7850 kg/m^3');
    await fill(page, 'source', 'EN 10025');
    await apply(page);

    // 4 · material.assign, with the Body chosen from the picker's candidates.
    await palette(page, 'material.assign');
    await field(page, 'material').locator('.chip-cand', { hasText: 'steel' }).click();
    await field(page, 'bodies').locator('.chip-cand', { hasText: 'beam' }).click();
    await apply(page);

    // 5 · mesh.set: a tagged union (MesherSpec) as a kind selector plus its sub-form.
    await page.locator('.chip-add', { hasText: '+ add mesh' }).click();
    await field(page, 'mesher').locator('button', { hasText: 'lattice' }).first().click();
    await fill(page, 'mesher.size', '25 mm');
    await fill(page, 'order', '1');
    await apply(page);
    await shot(page, '04-mesh');

    // 6 · constraint.fix, its Set picked from the auto faces of the Body.
    await page.locator('.chip-add', { hasText: '+ add constraint' }).click();
    await fill(page, 'name', 'root');
    await field(page, 'on').locator('.chip-cand', { hasText: 'beam.xmin' }).click();
    await apply(page);

    // 7 · load.traction, a three-part force quantity.
    await palette(page, 'load.traction');
    await fill(page, 'name', 'tip');
    await field(page, 'on').locator('.chip-cand', { hasText: 'beam.xmax' }).click();
    await fill(page, 'total', '0 N', 0);
    await fill(page, 'total', '0 N', 1);
    await fill(page, 'total', '-1 kN', 2);
    await apply(page);

    // 8 · step.add: an enum as a segmented control and two multi-pickers.
    await page.locator('.chip-add', { hasText: '+ add step' }).click();
    await fill(page, 'name', 'static');
    await field(page, 'procedure').locator('button', { hasText: 'static' }).click();
    await field(page, 'constraints').locator('.chip-cand', { hasText: 'root' }).click();
    await field(page, 'loads').locator('.chip-cand', { hasText: 'tip' }).click();
    await apply(page);
    await expect(page.locator('.jrow')).toHaveCount(journal.length);
    await shot(page, '05-built');

    // The Journal is the Model: nine lines, and the same hash the fixture recorded.
    const model = (await page.evaluate(() => window.fem.query.model())) as unknown as { hash: string; revision: number };
    expect(model.revision).toBe(journal.length);
    expect(model.hash).toBe(journal[journal.length - 1]!.hashAfter);
    await expect(page.locator('.jrow')).toHaveCount(journal.length);
    await expect(page.locator('.jrow').first()).toContainText('model.new');
    await expect(page.locator('.jrow').last()).toContainText('step.add');
    await expect(page.getByText(`rev ${journal.length}`)).toBeVisible();

    // Nothing blocks a solve any more, so the banner is gone and Solve is live.
    await expect(page.locator('.banner')).toHaveCount(0);
    await expect(page.locator('button.solve')).toBeEnabled();
    expect(errors).toEqual([]);
  });
});

test.describe('@cpu the gallery, the palette and the Script tab', () => {
  test.setTimeout(120_000);

  test('opens an example from the gallery and shows its Journal', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
    await page.goto('./');
    await ready(page);
    await page.locator('button[data-cmd="panel.toggle"]', { hasText: 'Open an example' }).click();
    await expect(page.locator('.gallery')).toBeVisible();
    await shot(page, '06-gallery');
    await page.locator('button[title="file.openExample cantilever"]').click();
    // The fixture ends on solve.run, so it opens solved and on the Results tab; the Journal is a tab away.
    await expect(page.locator('button.solve')).toHaveText(/Solved · rev \d+/, { timeout: 60_000 });
    await page.locator('.tab', { hasText: 'journal' }).click();
    await expect(page.locator('.jrow')).toHaveCount(fixture.length);
    const model = (await page.evaluate(() => window.fem.query.model())) as unknown as { name: string; hash: string };
    expect(model.name).toBe('cantilever');
    expect(model.hash).toBe(fixture[fixture.length - 1]!.hashAfter);
    await shot(page, '07-example-open');
  });

  test('the ⌘K palette lists the registry and fills a form', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
    await page.goto('./');
    await ready(page);
    await page.evaluate(() => window.fem.model.new({ name: 'palette' }));
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.locator('.palette')).toBeVisible();
    await shot(page, '08-palette');
    await page.locator('.palette-head input').fill('load.pressure');
    await expect(page.locator('.prow').first()).toContainText('load.pressure');
    await page.keyboard.press('Tab');
    await expect(page.locator('.props .panel-sub')).toHaveText('load.pressure');
    await expect(page.locator('[data-field="value"] .field-dim')).toContainText('stress');
  });

  test('a script from the Script tab adds a body and the tree follows', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
    await page.goto('./');
    await ready(page);
    await page.evaluate(() => window.fem.model.new({ name: 'scripted' }));
    await page.locator('.tab', { hasText: 'script' }).click();
    await page.getByRole('button', { name: 'edit this script' }).click();
    await page.locator('.script-edit').fill('await fem.geometry.addBox({ name: "fromScript", size: ["2 m", "1 m", "1 m"] });\nconsole.log("added");\nreturn (await fem.query.model()).bodies.length;');
    await page.locator('button[data-cmd="script.run"]').click();
    await expect(page.locator('.script-out')).toContainText('added', { timeout: 30_000 });
    await expect(page.locator('.tree .name', { hasText: 'fromScript' })).toBeVisible();
    // A script's Commands are the AI's, and the Journal says so.
    await page.locator('.tab', { hasText: 'journal' }).click();
    await expect(page.locator('.jrow').last()).toContainText('ai');
    await shot(page, '09-script');
  });
});
