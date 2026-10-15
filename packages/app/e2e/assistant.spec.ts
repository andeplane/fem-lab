// Issue #40, in the built app: the Assistant drawer opens on the start screen, and it is still
// there — with the same conversation — once the first Command brings the workspace up around it.
import { expect, test, type Page } from './fixtures';

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
}

test.describe('@cpu the Assistant before a Model exists', () => {
  test('opens over the start screen and survives the workspace appearing', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto('./');
    await ready(page);

    // The start screen, not the shell.
    await expect(page.locator('.start')).toBeVisible();
    await expect(page.locator('.shell')).toHaveCount(0);

    // The two Commands the start screen's "Ask the Assistant" card dispatches, in one tick —
    // which is what used to lose the line: the drawer had not mounted yet to receive it.
    await page.evaluate(async () => {
      await window.fem.dispatch({ cmd: 'panel.toggle', panel: 'assistant', open: true });
      await window.fem.dispatch({ cmd: 'chat.send', text: 'a 1 m steel cantilever, 10 kN at the tip' });
    });

    const drawer = page.locator('aside.assistant');
    await expect(drawer).toBeVisible();
    // No API key in the test browser, so the drawer answers by opening Settings — the point is
    // that it answered at all.
    await expect(drawer).toContainText('API key');
    await expect(page.locator('.start')).toBeVisible();

    // The first Command brings the workspace up around the drawer, which keeps its content.
    await page.evaluate(() => window.fem.model.new({ name: 'from-the-assistant' }));
    await expect(page.locator('.shell')).toBeVisible();
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText('API key');
    // Reserved, not overlaid: at this width the workspace gives the drawer its 392 px, so the
    // Properties panel is still beside it rather than under it.
    expect(await page.locator('.workspace').evaluate((el) => getComputedStyle(el).marginRight)).toBe('392px');
  });
});

test('@cpu composer suggestions and skills prepare editable drafts by keyboard', async ({ page }) => {
  await page.goto('./');
  await ready(page);
  await page.evaluate(() => window.fem.dispatch({ cmd: 'chat.setDraft', text: 'Inspect my beam' }));
  const drawer = page.locator('aside.assistant');
  const input = drawer.locator('textarea');
  await expect(drawer).toBeVisible();
  await expect(input).toHaveValue('Inspect my beam');
  const skillMenu = drawer.getByTitle('Choose a skill for this draft');
  await skillMenu.focus();
  await page.keyboard.press('Enter');
  const skill = drawer.locator('.popover button').filter({ hasText: 'beam-theory-check' });
  await skill.focus();
  await page.keyboard.press('Space');
  await expect(input).toHaveValue('/beam-theory-check Inspect my beam');
  await expect(input).toBeFocused();
  await expect(drawer.locator('.messages')).toBeEmpty();
  const suggestion = drawer.locator('.suggestions button').first();
  await suggestion.focus();
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue(/Help me build a cantilever/);
  await expect(input).toBeFocused();
  await expect(drawer.locator('.messages')).toBeEmpty();
  await drawer.getByTitle('Close the assistant').click();
  await expect(drawer).toBeHidden();
  await page.evaluate(() => window.fem.dispatch({ cmd: 'chat.setDraft', text: 'Reopened draft' }));
  await expect(drawer).toBeVisible();
  await expect(input).toHaveValue('Reopened draft');
  await expect(input).toBeFocused();
});

test('@cpu Assistant observations survive tab changes and collapse, then become stale after an edit', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('femlab.ai.key.openai', 'test-only');
    localStorage.setItem('femlab.ai.model', 'gpt-5.4-mini');
    localStorage.setItem('femlab.tour.dismissed', '1');
    const original = window.fetch.bind(window);
    window.fetch = async (input, options) => {
      if (!String(input).includes('api.openai.com/v1/responses')) return original(input, options);
      const events = [
        { type: 'response.output_text.delta', delta: 'Review complete.\n<verification>\nwarn | Mesh convergence | not run\n</verification>' },
        { type: 'response.completed', response: { output: [], usage: { input_tokens: 4, output_tokens: 4, input_tokens_details: { cached_tokens: 0 } } } },
      ];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });
    };
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('./');
  await ready(page);
  await page.evaluate(async () => {
    await window.fem.dispatch({ cmd: 'file.openExample', name: 'cantilever' });
    await window.fem.dispatch({ cmd: 'panel.toggle', panel: 'assistant', open: true });
  });
  const drawer = page.locator('aside.assistant');
  await drawer.locator('textarea').fill('Review this Model');
  await drawer.locator('textarea').press('Enter');
  await expect(drawer.locator('.thinking')).toHaveCount(0);
  await expect(drawer).toContainText('VERIFICATION · also in Checks');
  await expect(drawer).toContainText('Recorded at Model rev');
  await page.locator('.tab', { hasText: 'checks' }).click();
  const checks = page.locator('.checks');
  await expect(checks.locator('.assistant-check')).toContainText('Mesh convergence');
  await expect(checks).toContainText('not independently verified engine measurements');
  await drawer.getByTitle('Close the assistant').click();
  await expect(drawer).toBeHidden();
  await page.locator('.tab', { hasText: 'results' }).click();
  await page.locator('.tab', { hasText: 'checks' }).click();
  await expect(checks.locator('.assistant-check')).toContainText('not run');
  await page.evaluate(() => window.fem.load.traction({ name: 'tip', on: 'beam.xmax', total: ['0 N', '0 N', '-2 kN'] }));
  await expect(checks.locator('.assistant-check')).toContainText('Stale — Model or Result changed');
  await page.screenshot({ path: testInfo.outputPath('assistant-checks-stale.png') });
});
