import { expect, test } from '@playwright/test';

test('@cpu @sw production CSP permits engine/script Workers and blocks inline scripts', async ({ page }) => {
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
  const result = await page.evaluate(async () => {
    await window.fem.query.capabilities();
    const policy = document.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"]')!.content;
    const violation = new Promise<string>((resolve) => document.addEventListener('securitypolicyviolation', (event) => resolve(event.effectiveDirective), { once: true }));
    const script = document.createElement('script');
    script.textContent = 'window.inlineScriptExecuted = true';
    document.body.append(script);
    const blocked = await violation;
    script.remove();
    const run = await window.fem.dispatch({ cmd: 'script.run', code: 'return 6 * 7;' });
    return { policy, blocked, ranInline: 'inlineScriptExecuted' in window, run };
  });
  expect(result.policy).toContain("'wasm-unsafe-eval'");
  expect(result.policy).not.toContain("'unsafe-eval'");
  expect(result.blocked).toBe('script-src-elem');
  expect(result.ranInline).toBe(false);
  expect(result.run).toMatchObject({ result: 42, console: [] });
});

test('@cpu browser scripts have hard memory, output, network and deadline boundaries', async ({ page }) => {
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
  const result = await page.evaluate(async () => {
    const network = await window.fem.dispatch({
      cmd: 'script.run',
      code: "return Function('return [typeof fetch, typeof XMLHttpRequest, typeof WebSocket, typeof Worker]')();",
    });
    const memory = await window.fem.dispatch({ cmd: 'script.run', code: 'return "x".repeat(100 * 1024 * 1024);' });
    const output = await window.fem.dispatch({
      cmd: 'script.run',
      code: 'for (let i = 0; i < 20; i++) console.log("x".repeat(100000));',
    });
    const loop = await window.fem.dispatch({ cmd: 'script.run', code: 'while (true) {}', timeoutMs: 100 });
    const recovered = await window.fem.dispatch({ cmd: 'script.run', code: 'return 7;' });
    const capabilities = await window.fem.query.capabilities();
    return { network, memory, output, loop, recovered, capabilities };
  });
  expect(result.network).toMatchObject({ result: ['undefined', 'undefined', 'undefined', 'undefined'] });
  expect(result.memory).toMatchObject({ error: expect.stringContaining('out of memory') });
  expect(result.output).toMatchObject({ error: expect.stringContaining('console limit') });
  expect(result.loop).toMatchObject({ error: expect.stringContaining('within 100 ms') });
  expect(result.recovered).toMatchObject({ result: 7, console: [] });
  expect(result.capabilities).toBeTruthy();
});

test('@cpu rejected file imports retain the Model and current project', async ({ page }) => {
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
  const result = await page.evaluate(async () => {
    await window.fem.model.new({ name: 'keep-this-project' });
    const before = await window.fem.query.model();
    const project = await window.fem.registry.query({ query: 'query.project' });
    const errors: string[] = [];
    for (const json of ['not json', JSON.stringify({ format: 'unknown' }), ' '.repeat(16 * 1024 * 1024 + 1)]) {
      try { await window.fem.dispatch({ cmd: 'file.open', json }); }
      catch (error) { errors.push(String(error)); }
    }
    return { before, after: await window.fem.query.model(), project, afterProject: await window.fem.registry.query({ query: 'query.project' }), errors };
  });
  expect(result.project).not.toBeNull();
  expect(result.afterProject).toEqual(result.project);
  expect(result.after).toEqual(result.before);
  expect(result.errors).toHaveLength(3);
});

// #542: Vite previously inlined this small font as data:, which font-src 'self' blocks.
test('@cpu @sw bundled mathematics fonts load from same-origin assets under the strict CSP', async ({ page }, testInfo) => {
  const fontResponses: { url: string; status: number }[] = [];
  page.on('response', response => {
    if (/KaTeX_Size3-Regular-[^/]+\.woff2$/.test(response.url())) {
      fontResponses.push({ url: response.url(), status: response.status() });
    }
  });
  await page.addInitScript(() => {
    const state = window as typeof window & { fontPolicyViolations: string[] };
    state.fontPolicyViolations = [];
    document.addEventListener('securitypolicyviolation', event => {
      if (event.effectiveDirective === 'font-src') state.fontPolicyViolations.push(event.blockedURI);
    });
  });
  await page.goto('./');
  await page.waitForFunction(() => !!window.fem, undefined, { timeout: 60_000 });
  await page.evaluate(() => window.fem.dispatch({ cmd: 'example.open', name: 'cantilever' }));
  await expect(page.locator('.katex').first()).toBeVisible();
  const loaded = await page.evaluate(async () => {
    const fonts = await document.fonts.load('16px KaTeX_Size3');
    return {
      fonts: fonts.map(font => ({ family: font.family, status: font.status })),
      violations: (window as typeof window & { fontPolicyViolations: string[] }).fontPolicyViolations,
      policy: document.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"]')!.content,
      origin: location.origin,
    };
  });
  expect(loaded.fonts.length).toBeGreaterThan(0);
  expect(loaded.fonts.every(font => font.status === 'loaded')).toBe(true);
  expect(loaded.violations).toEqual([]);
  expect(loaded.policy).toContain("font-src 'self'");
  expect(fontResponses).toEqual([{ url: expect.stringMatching(/\/assets\/KaTeX_Size3-Regular-[^/]+\.woff2$/), status: 200 }]);
  expect(new URL(fontResponses[0]!.url).origin).toBe(loaded.origin);
  await testInfo.attach('mathematics-font-proof.json', { body: JSON.stringify({ ...loaded, fontResponses }, null, 2), contentType: 'application/json' });
  await testInfo.attach('rendered-mathematics.png', { body: await page.screenshot(), contentType: 'image/png' });
});
