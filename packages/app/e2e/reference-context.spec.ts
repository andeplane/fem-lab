// #512: inspect the real Assistant request, after references resolve through its owned registry.
// Only the remote provider is replaced. The production WASM generates and solves the Mesh.
import type { ResultSummary } from '@femlab/registry';
import { expect, test, type Page } from './fixtures';

declare global { interface Window { referenceRequests: string[] } }

async function contextSent(page: Page, text: string): Promise<Record<string, unknown>> {
  const count = await page.evaluate(() => window.referenceRequests.length);
  const drawer = page.locator('.assistant');
  await drawer.locator('textarea').fill(text);
  await drawer.locator('textarea').press('Enter');
  await expect.poll(() => page.evaluate(() => window.referenceRequests.length)).toBe(count + 1);
  await expect(drawer.locator('.thinking')).toHaveCount(0);
  const request = await page.evaluate(() => JSON.parse(window.referenceRequests.at(-1)!)) as { input: { role?: string; content: string | { type: string; text?: string }[] }[] };
  const user = request.input.filter(message => message.role === 'user').at(-1)!;
  const content = typeof user.content === 'string' ? user.content : user.content.find(block => block.type === 'input_text')!.text!;
  const block = content.match(/<context>\n([\s\S]*?)\n<\/context>/);
  return block ? JSON.parse(block[1]!) : {};
}

test('@cpu Result and Mesh chips send accurate retained context after re-solve and drawer reopen', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('femlab.ai.key.openai', 'test-only');
    localStorage.setItem('femlab.ai.model', 'gpt-5.4-mini');
    localStorage.setItem('femlab.tour.dismissed', '1');
    window.referenceRequests = [];
    const original = window.fetch.bind(window);
    window.fetch = async (input, options) => {
      if (!String(input).includes('api.openai.com/v1/responses')) return original(input, options);
      window.referenceRequests.push(String(options?.body));
      const events = [
        { type: 'response.output_text.delta', delta: 'Context received.' },
        { type: 'response.completed', response: { output: [], usage: { input_tokens: 4, output_tokens: 4, input_tokens_details: { cached_tokens: 0 } } } },
      ];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    };
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined');
  const original = await page.evaluate(async () => {
    await window.fem.dispatch({ cmd: 'project.new', name: 'reference contexts' });
    await window.fem.geometry.addBox({ name: 'beam', size: ['1 m', '100 mm', '100 mm'] });
    await window.fem.material.add({ name: 'steel', E: '210 GPa', nu: 0.3, rho: '7850 kg/m^3' });
    await window.fem.material.assign({ material: 'steel', bodies: ['beam'] });
    await window.fem.mesh.set({ mesher: { kind: 'lattice', size: { nx: 4, ny: 1, nz: 1 } }, order: 1 });
    await window.fem.constraint.fix({ name: 'root', on: 'beam.xmin' });
    await window.fem.load.traction({ name: 'tip', on: 'beam.xmax', total: ['0 N', '0 N', '-1 kN'] });
    await window.fem.step.add({ name: 'static', procedure: 'static', constraints: ['root'], loads: ['tip'] });
    await window.fem.step.add({ name: 'modes', procedure: 'modal', constraints: ['root'], loads: [], nModes: 2 });
    await window.fem.solve.run({ step: 'static', solver: 'cpu-direct' });
    return await window.fem.query.result() as ResultSummary;
  });
  const fieldButton = page.locator('.tree button[data-cmd="chat.insertMention"][title="Reference σ_vM in chat"]');
  await fieldButton.click(); // Opens and buffers before the drawer has mounted.
  const drawer = page.locator('.assistant');
  const ref = `result:id:${original.resultId}`;
  await expect(drawer.locator('.token')).toHaveAttribute('data-ref', ref);
  await expect(drawer.locator('.token')).toContainText(`@result:static (${original.resultId})`);
  await drawer.getByTitle('Close the assistant').click();
  await expect(drawer).toBeHidden();
  await page.locator('.tree button[data-cmd="chat.insertMention"][title="Reference mesh in chat"]').click();
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('.tokens .token')).toHaveCount(2);
  await expect(drawer.locator('.token').first()).toHaveAttribute('data-ref', ref);
  await page.evaluate(async () => {
    await window.fem.load.traction({ name: 'tip', on: 'beam.xmax', total: ['0 N', '0 N', '-2 kN'] });
    await window.fem.solve.run({ step: 'static', solver: 'cpu-direct' });
  });
  const latest = await page.evaluate(() => window.fem.query.result()) as ResultSummary;
  expect(latest.resultId).not.toBe(original.resultId);
  const context = await contextSent(page, 'Compare this retained solve and Mesh.');
  expect(context[ref]).toEqual({ ...original, stale: true });
  const mesh = await page.evaluate(() => window.fem.query.mesh());
  const model = await page.evaluate(() => window.fem.query.model());
  expect(context['mesh:mesh']).toEqual({ settings: model.meshSettings, summary: mesh });
  await expect(drawer).not.toContainText('nothing in the Model is called');

  await page.evaluate(() => window.fem.solve.run({ step: 'modes', solver: 'cpu-direct' }));
  const modal = await page.evaluate(() => window.fem.query.result()) as ResultSummary;
  await page.locator('.tree button[data-cmd="chat.insertMention"][title="Reference mode 1 in chat"]').click();
  const modalRef = `result:id:${modal.resultId}`;
  await expect(drawer.locator('.token')).toHaveAttribute('data-ref', modalRef);
  const modeContext = await contextSent(page, 'Explain the first mode.');
  expect(modeContext[modalRef]).toEqual(modal);
  expect(modal.frequencies).toHaveLength(2);

  // A reset clears retained solves; the old target must be unresolved, never rebound.
  await page.evaluate(() => window.fem.model.new({ name: 'cleared' }));
  const cleared = await contextSent(page, `Inspect @${modalRef}`);
  expect(cleared).toEqual({});
  await expect(drawer).toContainText(modalRef);
  await page.screenshot({ path: testInfo.outputPath('resolved-reference-contexts.png') });
});
