import { expect, test } from './fixtures';

test('@cpu an Assistant turn continues across its nested script replacement', async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('femlab.ai.key.openai', 'test-only');
    localStorage.setItem('femlab.ai.model', 'gpt-5.4-mini');
    const original = window.fetch.bind(window);
    let round = 0;
    window.fetch = async (input, options) => {
      if (!String(input).includes('api.openai.com/v1/responses')) return original(input, options);
      const calls = [
        { name: 'run_script', arguments: JSON.stringify({ code: 'await fem.model.new({name:"assistant-owned"});' }) },
        { name: 'geometry_addBox', arguments: JSON.stringify({ name: 'after-replacement', size: ['1 m', '1 m', '1 m'] }) },
      ];
      const call = calls[round++];
      const events = [
        ...(!call ? [{ type: 'response.output_text.delta', delta: 'Finished both operations.' }] : []),
        { type: 'response.completed', response: { output: call ? [{ type: 'function_call', call_id: `call-${round}`, ...call }] : [], usage: { input_tokens: 4, output_tokens: 4, input_tokens_details: { cached_tokens: 0 } } } },
      ];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    };
  });
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem?.dispatch === 'function');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'panel.toggle', panel: 'assistant', open: true }));
  const drawer = page.locator('aside.assistant');
  await drawer.locator('textarea').fill('Create a model and add the body.');
  await drawer.locator('textarea').press('Enter');
  await expect.poll(() => page.evaluate(async () => (await window.fem.query.model()).bodies.map(body => body.name))).toEqual(['after-replacement']);
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText('Finished both operations.');
  await expect(drawer.locator('[data-status="succeeded"]')).toHaveCount(2);
});

test('@cpu a delayed Assistant tool is revoked by an unrelated replacement', async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('femlab.ai.key.openai', 'test-only');
    localStorage.setItem('femlab.ai.model', 'gpt-5.4-mini');
    const original = window.fetch.bind(window);
    window.fetch = async (input, options) => {
      if (!String(input).includes('api.openai.com/v1/responses')) return original(input, options);
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; }, start(controller) {
        const emit = (event: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        emit({ type: 'response.output_text.delta', delta: 'Waiting before the tool.' });
        // Ignore the AbortSignal; the SDK may still cancel its reader before this late reply.
        (window as unknown as { finishOldResponse(): void }).finishOldResponse = () => {
          if (cancelled) return;
          emit({ type: 'response.completed', response: { output: [{ type: 'function_call', call_id: 'late', name: 'geometry_remove', arguments: '{"name":"shared"}' }] } });
          controller.close();
        };
      } });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    };
  });
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem?.dispatch === 'function');
  await page.evaluate(async () => {
    await window.fem.model.new({ name: 'old' });
    await window.fem.geometry.addBox({ name: 'shared', size: ['1 m', '1 m', '1 m'] });
    await window.fem.dispatch({ cmd: 'panel.toggle', panel: 'assistant', open: true });
  });
  const drawer = page.locator('aside.assistant');
  await drawer.locator('textarea').fill('Remove the body.');
  await drawer.locator('textarea').press('Enter');
  await expect(drawer).toContainText('Waiting before the tool.');
  await page.evaluate(async () => {
    await window.fem.model.new({ name: 'new' });
    await window.fem.geometry.addBox({ name: 'shared', size: ['2 m', '1 m', '1 m'] });
    (window as unknown as { finishOldResponse(): void }).finishOldResponse();
  });
  await expect(drawer.locator('.thinking')).toHaveCount(0);
  expect((await page.evaluate(() => window.fem.query.model())).bodies.map(body => body.name)).toEqual(['shared']);
  expect((await page.evaluate(() => window.fem.query.journal())).entries.map(entry => entry.cmd.cmd)).toEqual(['model.new', 'geometry.addBox']);
});
