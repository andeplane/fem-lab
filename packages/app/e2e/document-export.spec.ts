import { readFile } from 'node:fs/promises';
import type { Command } from '@femlab/registry';
import { MAX_MODEL_FILE_BYTES } from '@femlab/registry';
import { expect, test } from './fixtures';

test('@cpu checked SI document download remains available after a display formatting error', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('femlab.tour.dismissed', '1'); localStorage.setItem('femlab.autosave', 'off'); });
  await page.goto('./');
  await page.waitForFunction(() => Boolean(window.fem));
  const commands = JSON.parse(await readFile(new URL('../../../crates/engine/tests/fixtures/document-display-overflow.json', import.meta.url), 'utf8')) as Command[];
  await page.evaluate(async commands => { for (const command of commands) await window.fem.dispatch(command); }, commands.slice(0, -1));
  const failure = await page.evaluate(async command => {
    try { await window.fem.dispatch(command); return null; }
    catch (error) { const value = error as { code: string; where: string }; return { code: value.code, where: value.where }; }
  }, commands.at(-1)!);
  expect(failure).toEqual({ code: 'unit.display', where: 'displayUnits' });
  const before = await page.evaluate(async () => ({ document: await window.fem.query.document(), journal: await window.fem.query.journal(), results: await window.fem.query.results() }));
  expect(before.document.file.model.units).toMatchObject({ length: 'mm', force: 'mN' });
  expect(before.document.file.model.loads).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'plus', total: [1e307, 0, 0] }), expect.objectContaining({ name: 'minus', total: [-1e307, 0, 0] })]));
  const downloadReady = page.waitForEvent('download');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'file.save', name: 'recovery.femlab.json', to: 'download' }));
  const download = await downloadReady;
  expect(download.suggestedFilename()).toBe('recovery.femlab.json');
  const path = await download.path();
  expect(path).not.toBeNull();
  const text = await readFile(path!, 'utf8');
  expect(Buffer.byteLength(text)).toBeLessThan(MAX_MODEL_FILE_BYTES);
  expect(JSON.parse(text)).toEqual(before.document.file);
  const script = await page.evaluate(() => window.fem.query.script());
  for (const format of ['journal', 'script'] as const) {
    const exportedReady = page.waitForEvent('download');
    await page.evaluate(format => window.fem.dispatch({ cmd: 'file.export', spec: { format }, to: 'download' }), format);
    const exported = await exportedReady;
    expect(exported.suggestedFilename()).toBe(`${before.document.file.model.name}.${format === 'journal' ? 'femlab.json' : 'ts'}`);
    const exportedPath = await exported.path();
    expect(exportedPath).not.toBeNull();
    const exportedText = await readFile(exportedPath!, 'utf8');
    if (format === 'journal') {
      expect(Buffer.byteLength(exportedText)).toBeLessThan(MAX_MODEL_FILE_BYTES);
      expect(JSON.parse(exportedText)).toEqual(before.document.file);
    } else expect(exportedText).toBe(script.text);
  }
  expect(await page.evaluate(async () => ({ document: await window.fem.query.document(), journal: await window.fem.query.journal(), results: await window.fem.query.results() }))).toEqual(before);
});
