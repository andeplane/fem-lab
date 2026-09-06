import { expect, test, type Page } from '@playwright/test';

/** A provider stream, never a live API request. The tool still runs against real browser wasm. */
function response(tool: boolean): string {
  const block = tool ? { type: 'tool_use', id: 'box', name: 'geometry_addBox', input: {} } : { type: 'text', text: '' };
  const events = [
    { type: 'message_start', message: { id: 'test', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: block },
    { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify({ name: 'ai-body', size: ['1 m', '1 m', '1 m'], at: null }) } : { type: 'text_delta', text: 'Added the body.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

async function assistantTurn(page: Page) {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.addInitScript(() => localStorage.setItem('femlab.ai.key', 'test-key'));
  let request = 0;
  await page.route('https://api.anthropic.com/v1/messages', (route) => route.fulfill({
    status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: response(request++ === 0),
  }));
  await page.goto('./');
  await page.waitForFunction(async () => typeof window.fem !== 'undefined' && Boolean(await window.fem.query.capabilities()));
  await page.evaluate(() => window.fem.model.new({ name: 'turn-undo' }));
  await page.evaluate(() => window.fem.dispatch({ cmd: 'panel.toggle', panel: 'assistant', open: true }));
  const drawer = page.locator('.assistant');
  await drawer.locator('textarea').fill('Add one body');
  await drawer.locator('button.send').click();
  await expect(drawer.locator('.diff')).toContainText('geometry.addBox');
  return drawer;
}

test('@cpu Assistant turn undo preserves later human edits and reports why it cannot run', async ({ page }) => {
  const drawer = await assistantTurn(page);
  await page.evaluate(() => window.fem.geometry.addBox({ name: 'human-body', size: ['2 m', '1 m', '1 m'] }));
  await drawer.locator('.undo').click();
  await expect(drawer.locator('.diff')).toContainText('Journal changed after this turn');
  await expect(drawer.locator('.undo')).toBeDisabled();
  const model = await page.evaluate(() => window.fem.query.model()) as { bodies: { name: string }[] };
  expect(model.bodies.map((body) => body.name)).toEqual(['ai-body', 'human-body']);
});

test('@cpu Assistant turn undo removes its Commands once and disables the old card', async ({ page }) => {
  const drawer = await assistantTurn(page);
  await drawer.locator('.undo').click();
  await expect(drawer.locator('.undo')).toHaveText('Turn undone');
  await expect(drawer.locator('.undo')).toBeDisabled();
  const model = await page.evaluate(() => window.fem.query.model()) as { bodies: { name: string }[] };
  expect(model.bodies).toEqual([]);
});
