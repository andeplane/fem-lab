import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures';

const journalsDir = path.resolve(import.meta.dirname, '../../../crates/engine/benches/journals');
const examples = readdirSync(journalsDir)
  .filter((name) => name.endsWith('.json') && !name.endsWith('.meta.json'))
  .map((file) => ({ name: file.slice(0, -'.json'.length), entries: JSON.parse(readFileSync(path.join(journalsDir, file), 'utf8')) as { cmd: { cmd: string; name?: string; step?: string } }[] }))
  .sort((a, b) => a.name.localeCompare(b.name));

test.describe('@cpu every bundled benchmark opens with solved Steps and no erroneous blockers', () => {
  test.setTimeout(240_000);
  for (const { name, entries } of examples) {
    test(name, async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
      await page.goto('./');
      await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
      // Opening the actual shipped Journal also runs its solves and convergence studies. Do
      // not substitute an easier fixture, omit expensive Steps, or discard warning codes.
      const opened = await page.evaluate(async (name) => {
        const gallery = await (await fetch('examples/index.json')).json() as { examples: { name: string }[] };
        await window.fem.dispatch({ cmd: 'example.open', name });
        return { gallery: gallery.examples.map((example) => example.name).sort(), model: await window.fem.query.model(), result: await window.fem.query.result(), journal: await window.fem.query.journal() };
      }, name);
      expect(opened.gallery).toEqual(examples.map((example) => example.name).sort());
      const steps = entries.filter((entry) => entry.cmd.cmd === 'step.add').map((entry) => entry.cmd.name!);
      expect(steps.length, `${name} must remain a solvable benchmark`).toBeGreaterThan(0);
      expect(opened.model.steps.map((step) => step.name)).toEqual(steps);
      expect(opened.model.steps.every((step) => step.solved), `${name}: every bundled Step must have a current solve`).toBe(true);
      const solves = entries.filter((entry) => entry.cmd.cmd === 'solve.run');
      expect(opened.result).toMatchObject({ step: solves.at(-1)!.cmd.step, stale: false });
      expect(opened.journal.entries.map((entry) => entry.cmd)).toEqual(entries.map((entry) => entry.cmd));
      await expect(page.locator('input.model-name')).toHaveValue(opened.model.name);
      await expect(page.locator('.banner')).toHaveCount(0);
      await expect(page.locator('.error-card')).toHaveCount(0);
      await expect(page.locator('.tree .badge.warn')).toHaveCount(0);
      if (opened.model.loads.length > 0) {
        const loads = page.locator('.tree-group').filter({ has: page.locator('.group-label', { hasText: /^Loads$/ }) });
        await expect(loads.locator('.badge')).toHaveText('ok');
      }
      await expect(page.locator('button.solve')).toBeEnabled();
      await expect(page.locator('button.solve')).toHaveText(/Solved · rev \d+/);
    });
  }
});

test('@cpu public example.open and gallery alias replay the same Journal and preserve dirty failures', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined');
  const dirty = page.getByRole('img', { name: 'Unsaved changes' });
  const name = page.getByRole('textbox', { name: 'Model name', exact: true });
  const original = await page.evaluate(async () => {
    const project = await window.fem.dispatch({ cmd: 'project.new', name: 'keep this project' }) as { id: string };
    await window.fem.dispatch({ cmd: 'geometry.addBox', name: 'original', size: ['1 m', '2 m', '3 m'] });
    await window.fem.dispatch({ cmd: 'project.save' });
    return { id: project.id, journal: await window.fem.query.journal() };
  });
  const expected = await page.evaluate(async () => {
    const entries = await (await fetch('examples/cantilever.json')).json();
    const opened = await window.fem.dispatch({ cmd: 'example.open', name: 'cantilever' });
    return { entries, opened, journal: await window.fem.query.journal() };
  });
  expect(expected.opened).toEqual({ name: 'cantilever', commands: expected.entries.length });
  expect(expected.journal.entries).toHaveLength(expected.entries.length);
  await expect(name).toHaveValue('cantilever');
  await expect(dirty).toBeHidden();
  await page.evaluate(() => window.fem.dispatch({ cmd: 'project.save' }));
  await page.evaluate((id) => window.fem.dispatch({ cmd: 'project.open', id }), original.id);
  expect((await page.evaluate(() => window.fem.query.journal())).entries).toEqual(original.journal.entries);
  await expect(name).toHaveValue('keep this project');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'file.openExample', name: 'cantilever' }));
  expect((await page.evaluate(() => window.fem.query.journal())).entries).toEqual(expected.journal.entries);
  await expect(dirty).toBeHidden();
  await page.route('**/examples/cantilever.json', route => route.fulfill({ json: [
    { cmd: { cmd: 'model.new', name: 'partial example' } },
    { cmd: { cmd: 'material.assign', material: 'missing', bodies: ['missing'] } },
  ] }));
  const error = await page.evaluate(async () => {
    try { await window.fem.dispatch({ cmd: 'example.open', name: 'cantilever' }); return null; }
    catch (error) { return String(error); }
  });
  expect(error).not.toBeNull();
  await expect(name).toHaveValue('cantilever');
  await expect(dirty).toBeHidden();
  expect((await page.evaluate(() => window.fem.query.journal())).entries).toEqual(expected.journal.entries);
  await expect(page.locator('.theory-panel')).toBeVisible();
  await page.unroute('**/examples/cantilever.json');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'example.open', name: 'cantilever' }));
  await expect(dirty).toBeHidden();
});
