import { expect, test } from './fixtures';

// Hold the real SDK's SSE response open so assertions cannot pass by buffering the whole turn.
test('@cpu streams bounded tool cards and queues/interrupts with Enter', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('femlab.ai.key.openai', 'test-only');
    localStorage.setItem('femlab.ai.model', 'gpt-5.4-mini');
    const original = window.fetch.bind(window);
    let requests = 0;
    window.fetch = async (input, options) => {
      if (!String(input).includes('api.openai.com/v1/responses')) return original(input, options);
      requests++;
      const first = requests === 1;
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        const emit = (event: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        emit({ type: 'response.output_text.delta', delta: first ? 'Sizing **108 mm** walls.' : 'Queued message received.' });
        if (first) {
          emit({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'draft', name: 'script_run', arguments: '' } });
          emit({ type: 'response.function_call_arguments.delta', output_index: 1, delta: JSON.stringify({ code: '// ' + 'large argument '.repeat(1500) }) });
          options?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true });
        } else {
          emit({ type: 'response.completed', response: { output: [], usage: { input_tokens: 4, output_tokens: 4, input_tokens_details: { cached_tokens: 0 } } } });
          controller.close();
        }
      } });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    };
  });
  await page.setViewportSize({ width: 1100, height: 850 });
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'panel.toggle', panel: 'assistant', open: true }));
  const drawer = page.locator('aside.assistant');
  const composer = drawer.locator('textarea');
  await expect(drawer.getByLabel('Assistant model')).toHaveValue('gpt-5.4-mini');
  await composer.fill('build the walls');
  await composer.press('Enter');
  await expect(drawer.locator('.prose strong')).toHaveText('108 mm');
  const card = drawer.locator('[data-status="preparing"]');
  await expect(card).toBeVisible();
  await expect(card.getByLabel('Tool arguments')).toContainText('large argument');
  expect(await card.getByLabel('Tool arguments').evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  const bounds = await drawer.evaluate(el => {
    const card = el.querySelector('.card')!.getBoundingClientRect();
    const args = el.querySelector('.args')!.getBoundingClientRect();
    const thinking = el.querySelector('.thinking')!.getBoundingClientRect();
    return { contained: args.bottom <= card.bottom && args.right <= card.right, separated: card.bottom <= thinking.top };
  });
  expect(bounds).toEqual({ contained: true, separated: true });
  await composer.fill('use mortar joints');
  await composer.press('Enter');
  await expect(drawer.locator('.queued')).toContainText('use mortar joints');
  await expect(card).toBeVisible();
  await composer.press('Enter');
  await expect(drawer.locator('.queued')).toHaveCount(0);
  await expect(drawer.locator('[data-status="cancelled"]')).toHaveCount(1);
  await expect(drawer).toContainText('Queued message received.');
  await expect(drawer.locator('.bubble')).toHaveCount(2);
  await expect(drawer.locator('.thinking')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/assistant-streaming.png' });
});
