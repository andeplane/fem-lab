import { test, expect, type Page } from './fixtures';
async function ready(page: Page): Promise<void> {
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem?.dispatch === 'function', undefined, { timeout: 90_000 });
}
test.describe('@cpu session ownership', () => {
  test('an old facade cannot remove a same-named body after a UI project replacement', async ({ page }) => {
    await ready(page);
    await page.evaluate(async () => {
      await window.fem.model.new({ name: 'A' });
      await window.fem.geometry.addBox({ name: 'shared', size: ['1 m', '1 m', '1 m'] });
      (window as unknown as { retained: typeof window.fem }).retained = window.fem;
      await window.fem.dispatch({ cmd: 'form.edit', kind: 'body', name: 'shared' });
    });
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await page.getByRole('button', { name: 'New project', exact: true }).click();
    await expect.poll(() => page.evaluate(async () => (await window.fem.query.model()).bodies.length)).toBe(0);
    await page.evaluate(async () => { try { await window.fem.geometry.addBox({ name: 'shared', size: ['2 m', '1 m', '1 m'] }); } catch (error) { throw new Error(JSON.stringify(error)); } });
    const before = await page.evaluate(() => window.fem.query.journal());
    const code = await page.evaluate(async () => {
      const retained = (window as unknown as { retained: typeof window.fem }).retained;
      try { await retained.geometry.remove({ name: 'shared' }); return 'incorrectly accepted'; }
      catch (error) { return (error as { code: string }).code; }
    });
    expect(code).toBe('session.expired');
    expect(await page.evaluate(() => window.fem.query.journal())).toEqual(before);
    expect((await page.evaluate(() => window.fem.query.model())).bodies).toHaveLength(1);
    await expect(page.locator('.banner')).not.toContainText('not-found');
  });
  test('deleting every project then creating an empty one leaves no old targets or errors', async ({ page }) => {
    await ready(page);
    await page.evaluate(async () => {
      await window.fem.model.new({ name: 'shaft' });
      await window.fem.geometry.addBox({ name: 'brick_shaft', size: ['1 m', '1 m', '1 m'] });
      await window.fem.dispatch({ cmd: 'form.edit', kind: 'body', name: 'brick_shaft' });
      const { projects } = await window.fem.registry.query({ query: 'query.projects' }) as { projects: { id: string }[] };
      for (const project of projects) await window.fem.dispatch({ cmd: 'project.delete', id: project.id });
    });
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await page.getByRole('button', { name: 'New project', exact: true }).click();
    await expect.poll(() => page.evaluate(async () => (await window.fem.query.model()).bodies.length)).toBe(0);
    const journal = await page.evaluate(() => window.fem.query.journal());
    expect(journal.entries.map(entry => entry.cmd.cmd)).toEqual(['model.new']);
    await expect(page.locator('.banner')).not.toContainText('brick_shaft');
    await expect(page.locator('.props')).not.toContainText('brick_shaft');
  });
  test('cancellation recovers acknowledged edits and redo without reviving retained handles', async ({ page }) => {
    await ready(page);
    await page.evaluate(async () => {
      await window.fem.model.new({ name: 'recover' });
      await window.fem.geometry.addBox({ name: 'shared', size: ['1 m', '1 m', '1 m'] });
      await window.fem.journal.undo({ steps: 1 });
      (window as unknown as { retained: typeof window.fem }).retained = window.fem;
      await window.fem.dispatch({ cmd: 'solve.cancel' });
    });
    expect((await page.evaluate(() => window.fem.query.model())).bodies).toHaveLength(0);
    await page.evaluate(() => window.fem.journal.redo({ steps: 1 }));
    expect((await page.evaluate(() => window.fem.query.model())).bodies).toHaveLength(1);
    const code = await page.evaluate(async () => {
      try { await (window as unknown as { retained: typeof window.fem }).retained.geometry.remove({ name: 'shared' }); return 'accepted'; }
      catch (error) { return (error as { code: string }).code; }
    });
    expect(code).toBe('session.expired');
  });
  test('an initiating script can create its own model and continue, while a failed import preserves it', async ({ page }) => {
    await ready(page);
    const result = await page.evaluate(() => window.fem.dispatch({ cmd: 'script.run', code: 'await fem.model.new({name:"script-owned"}); await fem.geometry.addBox({name:"shared",size:["1 m","1 m","1 m"]});' })) as { error: string | null };
    expect(result.error).toBeFalsy();
    expect((await page.evaluate(() => window.fem.query.model())).bodies).toHaveLength(1);
    const before = await page.evaluate(() => window.fem.query.journal());
    const code = await page.evaluate(async () => {
      try { await window.fem.dispatch({ cmd: 'file.open', json: '{"format":"broken"}' }); return 'incorrectly accepted'; }
      catch (error) { return (error as { code: string }).code; }
    });
    expect(code).toBe('schema');
    expect(await page.evaluate(() => window.fem.query.journal())).toEqual(before);
  });
});
