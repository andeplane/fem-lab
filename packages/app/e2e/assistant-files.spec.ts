import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from './fixtures';

test.use({ trace: 'on' });

test('@cpu Assistant file cards use actual deliveries and exclude a cancelled recording', async ({ page }, testInfo) => {
  const bindingHashes = {
    portable: createHash('sha256').update(await readFile(new URL('../src/generated/wasm/femlab_engine_wasm_bg.wasm', import.meta.url))).digest('hex'),
    threaded: createHash('sha256').update(await readFile(new URL('../src/generated/wasm-threads/femlab_engine_wasm_bg.wasm', import.meta.url))).digest('hex'),
  };
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const wasm: Promise<{ url: string; sha256: string }>[] = [];
  page.on('response', response => {
    if (/femlab_engine_wasm_bg.*\.wasm/.test(response.url())) wasm.push(response.body().then(bytes => ({ url: response.url(), sha256: createHash('sha256').update(bytes).digest('hex') })));
  });
  await page.addInitScript(() => {
    localStorage.setItem('femlab.ai.key.openai', 'test-only');
    localStorage.setItem('femlab.ai.model', 'gpt-5.4-mini');
    localStorage.setItem('femlab.tour.dismissed', '1');
    const original = window.fetch.bind(window);
    let requests = 0;
    const calls = [
      { name: 'file_save', input: {} },
      { name: 'run_script', input: { code: 'await fem.file.save({ name: "script-output.femlab.json" }); throw new Error("after delivery");' } },
      { name: 'file_export', input: { spec: { format: 'webm', width: 640, height: 360, duration: 4, fps: 10 } } },
    ];
    window.fetch = async (input, options) => {
      if (!String(input).includes('api.openai.com/v1/responses')) return original(input, options);
      const index = requests++;
      const call = index % 2 === 0 ? calls[Math.floor(index / 2)] : undefined;
      const events = [
        { type: 'response.output_text.delta', delta: call ? 'Running the requested file operation.' : 'Operation finished.' },
        { type: 'response.completed', response: {
          output: call ? [{ type: 'function_call', call_id: `file-${index}`, name: call.name, arguments: JSON.stringify(call.input) }] : [],
          usage: { input_tokens: 4, output_tokens: 4, input_tokens_details: { cached_tokens: 0 } },
        } },
      ];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    };
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined');
  const runtimeCapabilities = await page.evaluate(() => ({
    isolated: crossOriginIsolated === true,
    sharedMemory: typeof SharedArrayBuffer === 'function',
  }));
  // Runtime selection precedes solving: requesting one thread still uses the threaded
  // binary on an isolated origin. Accept only that selected binary, never either hash.
  const expectedMode = runtimeCapabilities.isolated && runtimeCapabilities.sharedMemory ? 'threaded' : 'portable';
  const expectedWasm = bindingHashes[expectedMode];
  const source = JSON.parse(await readFile(new URL('../../../crates/engine/benches/journals/cantilever-modal.json', import.meta.url), 'utf8')) as { cmd: Record<string, unknown> }[];
  const commands = source.map(({ cmd }) => cmd.cmd === 'model.new' ? { ...cmd, name: 'assistant-files' }
    : cmd.cmd === 'mesh.set' ? { ...cmd, mesher: { kind: 'lattice', size: { nx: 4, ny: 1, nz: 1 } } }
      : cmd.cmd === 'step.add' ? { ...cmd, nModes: 2 }
        : cmd.cmd === 'solve.run' ? { ...cmd, gpu: false, threads: 1 } : cmd);
  await page.evaluate(async commands => {
    for (const cmd of commands) await window.fem.dispatch(cmd as { cmd: string });
    await window.fem.dispatch({ cmd: 'view.animate', step: 'modes', mode: 1, playing: false, frame: 25 });
    await window.fem.dispatch({ cmd: 'panel.toggle', panel: 'assistant', open: true });
  }, commands);
  await expect(page.locator('.deform-bar')).toBeVisible();
  const before = await page.evaluate(async () => ({ journal: await window.fem.query.journal(), view: await window.fem.registry.query({ query: 'query.view' }) }));
  const drawer = page.locator('aside.assistant');
  const composer = drawer.locator('textarea');
  const firstDownload = page.waitForEvent('download');
  await composer.fill('Save this Model with its default filename');
  await composer.press('Enter');
  const first = await firstDownload;
  expect(first.suggestedFilename()).toBe('assistant-files.femlab.json');
  const firstBytes = await readFile((await first.path())!);
  expect(JSON.parse(firstBytes.toString()).journal.entries).toEqual(before.journal.entries);
  await expect(drawer.locator('.thinking')).toHaveCount(0);
  await expect.soft(drawer.locator('.files-row .path')).toHaveText(['assistant-files.femlab.json']);
  await drawer.locator('.files-row [data-cmd="clipboard.copy"]').first().click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('assistant-files.femlab.json');
  await testInfo.attach('default-save-receipt.png', { body: await page.screenshot(), contentType: 'image/png' });
  await testInfo.attach('assistant-files.femlab.json', { body: firstBytes, contentType: 'application/json' });

  const scriptDownload = page.waitForEvent('download');
  await composer.fill('Save through a script that then fails');
  await composer.press('Enter');
  const script = await scriptDownload;
  expect(script.suggestedFilename()).toBe('script-output.femlab.json');
  const scriptBytes = await readFile((await script.path())!);
  expect(scriptBytes).toEqual(firstBytes);
  await testInfo.attach('script-output.femlab.json', { body: scriptBytes, contentType: 'application/json' });
  await expect(drawer.locator('[data-status="failed"]')).toContainText('after delivery');
  await expect(drawer.locator('.thinking')).toHaveCount(0);
  await expect.soft(drawer.locator('.files-row .path')).toHaveText(['assistant-files.femlab.json', 'script-output.femlab.json']);

  const downloads: string[] = [];
  const onDownload = (download: { suggestedFilename(): string }) => downloads.push(download.suggestedFilename());
  page.on('download', onDownload);
  await composer.fill('Export a movie, then cancel the recording');
  await composer.press('Enter');
  await expect(drawer.locator('.thinking')).toContainText('file.export');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'panel.toggle', panel: 'export', open: true }));
  await page.getByRole('button', { name: 'cancel recording', exact: true }).click();
  await expect(drawer.locator('.thinking')).toHaveCount(0);
  await page.evaluate(() => window.fem.dispatch({ cmd: 'panel.toggle', panel: 'export', open: false }));
  await expect.soft(drawer.locator('.files-row .path')).toHaveText(['assistant-files.femlab.json', 'script-output.femlab.json']);
  expect(downloads).toEqual([]);
  expect(await page.evaluate(async () => ({ journal: await window.fem.query.journal(), view: await window.fem.registry.query({ query: 'query.view' }) }))).toEqual(before);
  page.off('download', onDownload);
  const runtime = await Promise.all(wasm);
  expect(runtime.length).toBeGreaterThan(0);
  expect(new Set(runtime.map(item => item.sha256))).toEqual(new Set([expectedWasm]));
  const shownFiles = await drawer.locator('.files-row').evaluateAll(rows => rows.map(row => ({ name: row.querySelector('.path')?.textContent, destination: row.querySelector('.faint')?.textContent, command: row.querySelector('button')?.dataset['cmd'] })));
  expect(shownFiles).toEqual([
    { name: 'assistant-files.femlab.json', destination: 'download', command: 'clipboard.copy' },
    { name: 'script-output.femlab.json', destination: 'download', command: 'clipboard.copy' },
  ]);
  await testInfo.attach('file-delivery-receipts.json', { body: JSON.stringify({ expectedMode, runtimeCapabilities, bindingHashes, expectedWasm, runtime, shownFiles, defaultFilename: first.suggestedFilename(), scriptFilename: script.suggestedFilename(), bytes: firstBytes.length, sha256: createHash('sha256').update(firstBytes).digest('hex'), cancelledDownloads: downloads, before }, null, 2), contentType: 'application/json' });
  await testInfo.attach('completed-and-cancelled-files.png', { body: await page.screenshot(), contentType: 'image/png' });
});
