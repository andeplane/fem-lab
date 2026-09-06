import { expect, test } from '@playwright/test';

test('@cpu script validation uses a lazy worker and rejects invalid code before Model mutation', async ({ page }) => {
  const validationRequests: string[] = [];
  page.on('request', (request) => { if (request.url().includes('script-validation.worker')) validationRequests.push(request.url()); });
  await page.goto('./');
  await page.waitForFunction(async () => typeof window.fem !== 'undefined' && Boolean(await window.fem.query.capabilities()));
  await page.evaluate(() => window.fem.model.new({ name: 'validation seed' }));
  expect(validationRequests).toEqual([]);
  const result = await page.evaluate(async () => {
    const before = await window.fem.query.journal();
    const code = 'await fem.model.new({ name: "must not happen" });\nawait fem.geometry.notReal({});';
    const diagnostic = await window.fem.registry.query({ query: 'query.validateScript', code });
    const rejected = await window.fem.dispatch({ cmd: 'script.run', code });
    const after = await window.fem.query.journal();
    const valid = await window.fem.registry.query({ query: 'query.validateScript', code: 'return (await fem.query.model()).name;' });
    const executed = await window.fem.dispatch({ cmd: 'script.run', code: 'return (await fem.query.model()).name;' });
    return { before, after, diagnostic, rejected, valid, executed };
  });
  expect(validationRequests.length).toBeGreaterThan(0);
  expect(result.after).toEqual(result.before);
  expect(result.diagnostic).toMatchObject({ ok: false, diagnostics: [{ code: 'TS2339', where: { line: 2, column: 20 } }] });
  expect(result.rejected).toMatchObject({ error: expect.stringContaining('script.validation') });
  expect(result.valid).toEqual({ ok: true, diagnostics: [] });
  expect(result.executed).toMatchObject({ result: 'validation seed', console: [] });
});
