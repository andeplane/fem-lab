import { expect, test } from '@playwright/test';

test('@cpu overlapping replacements stay atomic and the next new project starts empty', async ({ page }) => {
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined');
  const result = await page.evaluate(async () => {
    await window.fem.dispatch({ cmd: 'project.new', name: 'old-shaft' });
    await window.fem.geometry.addBox({ name: 'brick_shaft', size: ['1 m', '1 m', '1 m'] });
    await window.fem.geometry.remove({ name: 'brick_shaft' });
    const saved = await window.fem.dispatch({ cmd: 'project.save' }) as { id: string };
    const previous = await window.fem.query.journal();
    const opening = window.fem.registry.dispatch({ cmd: 'project.open', id: saved.id });
    const deleting = window.fem.dispatch({ cmd: 'project.delete', id: saved.id });
    const creating = window.fem.dispatch({ cmd: 'project.new', name: 'empty-after-shaft' });
    const outcomes = await Promise.allSettled([opening, deleting, creating]);
    const interim = await window.fem.query.journal();
    // Conflicting requests are rejected, never rebound. A subsequent explicit activation
    // is admitted only after all three original requests have settled.
    await window.fem.dispatch({ cmd: 'project.new', name: 'empty-after-shaft' });
    return {
      previous, interim,
      outcomes: outcomes.map((outcome) => outcome.status === 'fulfilled' ? 'fulfilled' : (outcome.reason as { code: string }).code),
      model: await window.fem.query.model(),
      journal: await window.fem.query.journal(),
      project: await window.fem.registry.query({ query: 'query.project' }),
    };
  });
  expect(result.outcomes).toContain('fulfilled');
  for (const outcome of result.outcomes) expect(['fulfilled', 'session.conflict', 'session.expired', 'session.transitioning', 'not-found']).toContain(outcome);
  expect([result.previous.entries.map(entry => entry.cmd), [{ cmd: 'model.new', name: 'empty-after-shaft' }]])
    .toContainEqual(result.interim.entries.map(entry => entry.cmd));
  expect(result.model).toMatchObject({ name: 'empty-after-shaft', bodies: [] });
  expect(result.journal.entries.map((entry) => entry.cmd)).toEqual([{ cmd: 'model.new', name: 'empty-after-shaft' }]);
  expect(result.project).toMatchObject({ name: 'empty-after-shaft' });
  await expect(page.locator('.error-card')).toHaveCount(0);
});

test('@cpu a new project clears the previous selection and editable body form', async ({ page }) => {
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined');
  await page.evaluate(async () => {
    await window.fem.dispatch({ cmd: 'project.new', name: 'old-shaft' });
    await window.fem.geometry.addBox({ name: 'brick_shaft', size: ['1 m', '1 m', '1 m'] });
    await window.fem.dispatch({ cmd: 'selection.set', refs: ['body:brick_shaft'], bodies: ['brick_shaft'] });
  });
  await expect(page.locator('.selection-chip')).toContainText('brick_shaft');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'project.new', name: 'empty' }));
  await expect(page.locator('.selection-chip')).toHaveCount(0);
  await expect(page.locator('.props .prop-name')).toHaveText('body@ reference in chat');
  await expect(page.locator('.error-card')).toHaveCount(0);
  expect(await page.evaluate(() => window.fem.registry.query({ query: 'query.selection' }))).toMatchObject({ refs: [], bodies: [], faces: [], sets: [] });
});
