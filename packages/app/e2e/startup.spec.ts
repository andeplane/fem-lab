import { createHash } from 'node:crypto';
import { expect, test } from './fixtures';

declare global {
  interface Window { startupWorkerEvents: { worker: number; op: string }[] }
}
async function watchWorkers(context: import('@playwright/test').BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    window.startupWorkerEvents = [];
    const ids = new WeakMap<Worker, number>(); let next = 0;
    const id = (worker: Worker) => { let n = ids.get(worker); if (n === undefined) { n = ++next; ids.set(worker, n); } return n; };
    const post = Worker.prototype.postMessage; const terminate = Worker.prototype.terminate;
    Worker.prototype.postMessage = function(message: unknown, options?: StructuredSerializeOptions | Transferable[]) {
      if (typeof message === 'object' && message !== null && 'op' in message && typeof message.op === 'string') window.startupWorkerEvents.push({ worker: id(this), op: message.op });
      Reflect.apply(post, this, [message, options]);
    };
    Worker.prototype.terminate = function() { window.startupWorkerEvents.push({ worker: id(this), op: 'terminate' }); Reflect.apply(terminate, this, []); };
  });
}
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

test('@cpu Start and persisted Recent precede a held real WASM response and retain drafts across publication', async ({ page, context }, info) => {
  await watchWorkers(context);
  await page.goto('./'); await page.waitForFunction(() => typeof window.fem !== 'undefined');
  const saved = await page.evaluate(async () => {
    await window.fem.dispatch({ cmd: 'project.new', name: 'startup saved project' });
    await window.fem.geometry.addBox({ name: 'box', size: ['1 m', '2 m', '3 m'] });
    const metadata = await window.fem.dispatch({ cmd: 'project.save' });
    return { metadata, journal: await window.fem.query.journal() };
  });
  const held = gate(); const requested = gate(); const receipts: { url: string; bytes: number; sha256: string }[] = [];
  await context.route('**/*.wasm', async route => {
    const response = await route.fetch(); const body = await response.body();
    receipts.push({ url: route.request().url(), bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') });
    requested.release(); await held.promise; await route.fulfill({ response, body });
  });
  try {
    await page.reload({ waitUntil: 'domcontentloaded' }); await requested.promise;
    await expect(page.locator('.start')).toBeVisible({ timeout: 2000 });
    await expect(page.locator('.recent-name')).toContainText('startup saved project');
    expect(await page.evaluate(() => typeof window.fem)).toBe('undefined');
    expect(await page.evaluate(() => window.startupWorkerEvents.map(event => event.op))).toEqual(['create']);
    for (const cmd of ['project.new', 'project.open', 'account.open', 'file.open', 'form.open', 'panel.toggle']) {
      for (const button of await page.locator(`.start button[data-cmd="${cmd}"]`).all()) await expect(button).toBeDisabled();
    }
    const name = page.getByRole('textbox', { name: 'project name', exact: true }); const ask = page.getByRole('textbox', { name: 'describe the part', exact: true });
    const originalName = await name.elementHandle(); const originalAsk = await ask.elementHandle();
    await name.fill('kept startup draft'); await ask.fill('kept startup question'); await ask.press('Enter'); await name.focus();
    expect(await page.evaluate(() => window.startupWorkerEvents.map(event => event.op))).toEqual(['create']);
    await info.attach('held-start.png', { body: await page.screenshot(), contentType: 'image/png' });
    held.release(); await page.waitForFunction(() => typeof window.fem !== 'undefined');
    expect(await originalName!.evaluate(element => element === document.querySelector('[aria-label="project name"]'))).toBe(true);
    expect(await originalAsk!.evaluate(element => element === document.querySelector('[aria-label="describe the part"]'))).toBe(true);
    await expect(name).toHaveValue('kept startup draft'); await expect(ask).toHaveValue('kept startup question'); await expect(name).toBeFocused();
    expect(await page.evaluate(() => window.fem.registry.query({ query: 'query.workspaceStatus' }))).toEqual({ ready: true, phase: 'ready' });
    await expect(page.locator('.startup-status')).toHaveCount(0);
    await info.attach('published-start.png', { body: await page.screenshot(), contentType: 'image/png' });
    await page.locator('.recent-open').click();
    await expect(page.locator('.shell')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.fem.query.journal())).toEqual(saved.journal);
    expect(await page.evaluate(async () => (await window.fem.query.model()).bodies.map(body => body.name))).toEqual(['box']);
  } finally {
    held.release();
    await info.attach('held-wasm-startup.json', { body: JSON.stringify({ saved, responses: receipts, workerEvents: await page.evaluate(() => window.startupWorkerEvents).catch(() => []) }, null, 2), contentType: 'application/json' });
  }
});

test('@cpu cancelling held startup fences late WASM completion, then real loading failure remains retryable', async ({ page, context }, info) => {
  await watchWorkers(context);
  const held = gate(); const requested = gate(); const lateCompleted = gate(); let requests = 0; const bodies: { request: number; sha256: string }[] = [];
  await context.route('**/*.wasm', async route => {
    const request = ++requests;
    if (request === 2) { await route.abort('failed'); return; }
    const response = await route.fetch(); const body = await response.body(); bodies.push({ request, sha256: createHash('sha256').update(body).digest('hex') });
    if (request === 1) { requested.release(); await held.promise; }
    try { await route.fulfill({ response, body }); } catch (error) { if (request !== 1) throw error; } // The cancelled Worker no longer owns its request.
    finally { if (request === 1) lateCompleted.release(); }
  });
  try {
    await page.goto('./', { waitUntil: 'domcontentloaded' }); await requested.promise;
    await expect(page.locator('.start')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel startup', exact: true }).click();
    await expect(page.locator('.startup-status')).toContainText('Workspace startup cancelled.');
    expect(await page.evaluate(() => window.startupWorkerEvents)).toEqual([{ worker: 1, op: 'create' }, { worker: 1, op: 'terminate' }]);
    await info.attach('cancelled-start.png', { body: await page.screenshot(), contentType: 'image/png' });
    held.release(); await lateCompleted.promise;
    expect(await page.evaluate(() => typeof window.fem)).toBe('undefined');
    await page.getByRole('button', { name: 'Retry startup', exact: true }).click();
    await expect(page.locator('.startup-status')).toContainText('Could not start the workspace.');
    await expect(page.locator('.notes.bad')).toContainText('internal');
    await info.attach('failed-start.png', { body: await page.screenshot(), contentType: 'image/png' });
    expect(await page.evaluate(() => typeof window.fem)).toBe('undefined');
    await page.getByRole('button', { name: 'Retry startup', exact: true }).click();
    await page.waitForFunction(() => typeof window.fem !== 'undefined');
    expect(requests).toBe(3);
    const events = await page.evaluate(() => window.startupWorkerEvents);
    expect(events.filter(event => event.op === 'create').map(event => event.worker)).toEqual([1, 2, 3]);
    expect(events.filter(event => event.worker === 1).map(event => event.op)).toEqual(['create', 'terminate']);
    expect(await page.evaluate(() => window.fem.registry.query({ query: 'query.workspaceStatus' }))).toEqual({ ready: true, phase: 'ready' });
  } finally {
    held.release(); await info.attach('cancel-and-retry-startup.json', { body: JSON.stringify({ requests, bodies, events: await page.evaluate(() => window.startupWorkerEvents).catch(() => []) }, null, 2), contentType: 'application/json' });
  }
});
