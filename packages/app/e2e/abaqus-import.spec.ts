import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Command, JournalDump, ModelFile, ModelSummary, OpenProject, ResultSummary } from '@femlab/registry';
import { expect, test, type Page } from './fixtures';

const fixture = fileURLToPath(new URL('../../../crates/engine/tests/fixtures/abaqus-static/bar-hex-mm-n.inp', import.meta.url));
const meshFixture = fileURLToPath(new URL('../../../crates/engine/tests/fixtures/abaqus/sparse-label-tet.inp', import.meta.url));
const input = (text: string, name = 'Imported axial bar') => ({ cmd: 'file.importAbaqus', text, name, body: 'bar', mode: 'static', unitLength: '1 mm', unitForce: '1 N' });
const q = <T>(page: Page, query: string) => page.evaluate(query => window.fem.registry.query({ query }), query) as Promise<T>;

function axial(result: ResultSummary): void {
  const ux = result.extremes.find(row => row.field === 'displacement' && row.component === 0)!;
  expect(ux.max.unit).toBe('m');
  expect(ux.max.value).toBeCloseTo(5e-7, 13);
  expect(result.reactions.reduce((sum, row) => sum + row.total[0].value, 0)).toBeCloseTo(-1000, 5);
  expect(result.stale).toBe(false);
}

async function start(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1800, height: 1100 });
  await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined');
}

async function deferFileRead(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      if (this.name !== 'late.inp') return original.call(this);
      return new Promise<ArrayBuffer>(resolve => { (window as unknown as { releaseAbaqusRead(): Promise<void> }).releaseAbaqusRead = async () => resolve(await original.call(this)); });
    };
  });
}

test('@cpu inline mesh mode imports only participating tetrahedron nodes and exact Set mappings', async ({ page }) => {
  await start(page);
  await page.getByTitle('Import Abaqus .inp', { exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import Abaqus input deck', exact: true });
  await dialog.getByRole('button', { name: 'Mesh and Sets', exact: true }).click();
  await dialog.getByLabel('Project name').fill('Sparse tetrahedron');
  await dialog.getByLabel('Body name').fill('tet');
  await dialog.getByLabel('One source length unit').fill('1 cm');
  await dialog.getByRole('button', { name: 'Paste inline deck', exact: true }).click();
  await dialog.getByLabel('Abaqus input text').fill(await readFile(meshFixture, 'utf8'));
  await dialog.getByRole('button', { name: 'Import deck', exact: true }).click();
  const report = page.getByRole('dialog', { name: 'Abaqus import report', exact: true });
  await expect(report).toBeVisible();
  await expect(report).toContainText('tet.nset_SAME');
  await expect(report).toContainText('tet.elset_SAME');
  await expect(report).toContainText('99');
  await expect(report).toContainText('physically unanalysed');
  const model = await q<ModelSummary>(page, 'query.model');
  expect(model.name).toBe('Sparse tetrahedron');
  expect(model.materials).toEqual([]);
  expect(model.steps).toEqual([]);
  const mesh = await q<{ nodes: number; elements: number; bbox: { value: number; unit: string }[] }>(page, 'query.mesh');
  expect(mesh.nodes).toBe(4); expect(mesh.elements).toBe(1);
  expect(mesh.bbox.slice(3)).toEqual([{ value: 0.01, unit: 'm' }, { value: 0.01, unit: 'm' }, { value: 0.01, unit: 'm' }]);
  await report.getByTitle('Close Abaqus import report', { exact: true }).click();
  await expect(page.locator('.topbar button[data-cmd="solve.run"]')).toBeDisabled();
});

test('@cpu Abaqus picker imports explicit units, solves, edits source with undo/redo, and reopens a portable saved file', async ({ page }, info) => {
  test.setTimeout(120_000);
  await start(page);
  await page.getByTitle('Import Abaqus .inp', { exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import Abaqus input deck', exact: true });
  await expect(dialog.getByLabel('One source length unit')).toHaveValue('');
  await dialog.getByLabel('Project name').fill('Imported axial bar');
  await dialog.getByLabel('Body name').fill('bar');
  await dialog.getByRole('button', { name: 'Linear static analysis', exact: true }).click();
  await expect(dialog.getByLabel('One source force unit')).toHaveValue('');
  await expect(dialog.getByRole('button', { name: 'Choose .inp and import', exact: true })).toBeDisabled();
  await dialog.getByLabel('One source length unit').fill('1 mm');
  await dialog.getByLabel('One source force unit').fill('1 N');
  const chosen = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Choose .inp and import', exact: true }).click();
  await (await chosen).setFiles(fixture);
  const report = page.getByRole('dialog', { name: 'Abaqus import report', exact: true });
  await expect(report).toBeVisible();
  await expect(report).toContainText('12');
  await expect(report).toContainText('bar.nset_ROOT');
  await expect(report).toContainText('bar.nset_TIP');
  await expect(report).toContainText('STEEL');
  await expect(report).toContainText('AXIAL');
  await report.screenshot({ path: info.outputPath('abaqus-import-report.png') });
  const model = await q<ModelSummary>(page, 'query.model');
  expect(model.name).toBe('Imported axial bar');
  expect(model.materials[0]!.name).toBe('STEEL');
  expect(model.steps[0]!.solved).toBe(false);
  expect(model.warnings).toEqual([]);
  const mesh = await q<{ nodes: number; elements: number; bbox: { value: number; unit: string }[] }>(page, 'query.mesh');
  expect(mesh.nodes).toBe(12); expect(mesh.elements).toBe(2);
  expect(mesh.bbox[3]!).toEqual({ value: 1, unit: 'm' });
  await report.getByTitle('Close Abaqus import report', { exact: true }).click();
  await expect(page.locator('aside.tree')).toContainText('STEEL');
  await expect(page.locator('aside.tree')).toContainText('AXIAL');
  await expect(page.locator('aside.tree')).toContainText('bar.nset_ROOT');
  await expect(page.locator('.topbar button[data-cmd="solve.run"]')).toBeEnabled();
  await expect(page.locator('canvas')).toBeVisible();
  await page.locator('canvas').screenshot({ path: info.outputPath('imported-hex-mesh.png') });
  await page.evaluate(() => window.fem.dispatch({ cmd: 'solve.run', step: 'AXIAL', solver: 'cpu-direct' }));
  axial(await q<ResultSummary>(page, 'query.result'));

  // A second authored deck changes x coordinates while retaining source labels, connectivity
  // and every named analysis target. This exercises supported whole-source mesh replacement.
  const text = await readFile(fixture, 'utf8');
  const longer = text.replace('L=1000 mm', 'L=2000 mm').replaceAll(',1000,', ',2000,').replaceAll(',500,', ',1000,');
  await page.evaluate(async text => {
    const bytes = new TextEncoder().encode(text);
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
    const converted = await window.fem.registry.query({ query: 'query.convertAbaqus', text, sha256, name: 'second source', body: 'bar', mode: 'static', unitLength: '1 mm', unitForce: '1 N' }) as { commands: Command[] };
    await window.fem.dispatch(converted.commands.find(command => command.cmd === 'mesh.set')!);
  }, longer);
  expect((await q<ModelSummary>(page, 'query.model')).hash).not.toBe(model.hash);
  expect((await q<ResultSummary>(page, 'query.result')).stale).toBe(true);
  expect((await q<{ bbox: { value: number }[] }>(page, 'query.mesh')).bbox[3]!.value).toBe(2);
  await page.evaluate(() => window.fem.dispatch({ cmd: 'journal.undo', steps: 1 }));
  expect((await q<ModelSummary>(page, 'query.model')).hash).toBe(model.hash);
  expect((await q<{ bbox: { value: number }[] }>(page, 'query.mesh')).bbox[3]!.value).toBe(1);
  await page.evaluate(() => window.fem.dispatch({ cmd: 'journal.redo', steps: 1 }));
  expect((await q<{ bbox: { value: number }[] }>(page, 'query.mesh')).bbox[3]!.value).toBe(2);
  await page.evaluate(() => window.fem.dispatch({ cmd: 'journal.undo', steps: 1 }));

  const downloaded = page.waitForEvent('download');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'file.save', name: 'bar.femlab.json', to: 'download' }));
  const saved = info.outputPath('bar.femlab.json'); await (await downloaded).saveAs(saved);
  const json = await readFile(saved, 'utf8');
  const file = JSON.parse(json) as ModelFile;
  expect(file.format).toBe('femlab/1');
  expect(json).not.toContain(fixture);
  expect(json).not.toContain('*NODE');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'project.new', name: 'replacement' }));
  await page.evaluate(json => window.fem.dispatch({ cmd: 'file.open', json }), json);
  await expect(page.getByRole('dialog', { name: 'Abaqus import report', exact: true })).toBeHidden();
  expect((await q<{ nodes: number; elements: number }>(page, 'query.mesh')).nodes).toBe(12);
  await page.evaluate(() => window.fem.dispatch({ cmd: 'solve.run', step: 'AXIAL', solver: 'cpu-direct' }));
  axial(await q<ResultSummary>(page, 'query.result'));
});

test('@cpu invalid inline imports and unsupported database files retain the solved project; scripts use the same inline Command', async ({ page }) => {
  test.setTimeout(120_000);
  await start(page);
  await page.evaluate(() => window.fem.dispatch({ cmd: 'file.openExample', name: 'cantilever' }));
  const before = await q<ModelSummary>(page, 'query.model');
  const journal = await q<JournalDump>(page, 'query.journal');
  const result = await q<ResultSummary>(page, 'query.result');
  const project = await q<OpenProject>(page, 'query.project');
  for (const text of ['*PART,NAME=P\n', '*NODE\n1,0,0,0\n', 'x'.repeat(16 * 1024 * 1024 + 1)]) {
    const error = await page.evaluate(async command => { try { await window.fem.dispatch(command); return null; } catch (error) { return (error as { code: string }).code; } }, input(text));
    expect(error).not.toBeNull();
    expect((await q<ModelSummary>(page, 'query.model')).hash).toBe(before.hash);
    expect(await q<JournalDump>(page, 'query.journal')).toEqual(journal);
    expect(await q<ResultSummary>(page, 'query.result')).toEqual(result);
    expect((await q<OpenProject>(page, 'query.project')).id).toBe(project.id);
  }
  await page.evaluate(() => window.fem.dispatch({ cmd: 'form.open', command: 'file.importAbaqus', args: { name: 'odb', body: 'bar', mode: 'static', unitLength: '1 mm', unitForce: '1 N', picker: true } }));
  const chosen = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose .inp and import', exact: true }).click();
  await (await chosen).setFiles({ name: 'results.odb', mimeType: 'application/octet-stream', buffer: Buffer.from([0xff, 0]) });
  await expect(page.getByRole('dialog', { name: 'Import Abaqus input deck', exact: true }).getByRole('alert')).toContainText('binary Abaqus results database');
  expect((await q<ModelSummary>(page, 'query.model')).hash).toBe(before.hash);
  await page.getByTitle('Close Abaqus import', { exact: true }).click();
  const text = (await readFile(fixture, 'utf8')).replace('*ELEMENT,TYPE=C3D8', '9999,9000,0,0\n*ELEMENT,TYPE=C3D8');
  const code = `await fem.file.importAbaqus(${JSON.stringify({ ...input(text), cmd: undefined })}); await fem.solve.run({step:"AXIAL",solver:"cpu-direct"}); return await fem.query.result({step:"AXIAL"});`;
  const scripted = await page.evaluate(code => window.fem.dispatch({ cmd: 'script.run', code }), code) as { error?: string; result: ResultSummary };
  expect(scripted.error).toBeUndefined(); axial(scripted.result);
  await expect(page.getByRole('dialog', { name: 'Abaqus import report', exact: true })).toContainText('9999');
  await expect(page.getByRole('dialog', { name: 'Abaqus import report', exact: true })).toContainText('physically unanalysed');
  const physical = await q<{ nodes: number; bbox: { value: number }[] }>(page, 'query.mesh');
  expect(physical.nodes).toBe(12); expect(physical.bbox[3]!.value).toBe(1);
});

test('@cpu cancelling a picker and switching projects during an actual deferred File read cannot publish an import', async ({ page }) => {
  test.setTimeout(90_000);
  await deferFileRead(page);
  await start(page);
  await page.evaluate(() => window.fem.dispatch({ cmd: 'file.openExample', name: 'cantilever' }));
  const before = await q<ModelSummary>(page, 'query.model');
  const args = { name: 'late import', body: 'bar', mode: 'static', unitLength: '1 mm', unitForce: '1 N', picker: true };
  await page.evaluate(args => window.fem.dispatch({ cmd: 'form.open', command: 'file.importAbaqus', args }), args);
  let chosen = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose .inp and import', exact: true }).click();
  await (await chosen).element().evaluate(input => input.dispatchEvent(new Event('cancel')));
  expect((await q<ModelSummary>(page, 'query.model')).hash).toBe(before.hash);
  chosen = page.waitForEvent('filechooser');
  const pending = page.evaluate(async args => {
    try { await window.fem.dispatch({ cmd: 'file.importAbaqus', ...args }); return null; }
    catch (error) { return (error as { code: string }).code; }
  }, args);
  await (await chosen).setFiles({ name: 'late.inp', mimeType: 'text/plain', buffer: await readFile(fixture) });
  await page.waitForFunction(() => typeof (window as unknown as { releaseAbaqusRead?: unknown }).releaseAbaqusRead === 'function');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'project.new', name: 'new active project' }));
  const next = await q<ModelSummary>(page, 'query.model');
  await page.evaluate(() => (window as unknown as { releaseAbaqusRead(): Promise<void> }).releaseAbaqusRead());
  expect(await pending).toBe('session.expired');
  await expect.poll(async () => (await q<ModelSummary>(page, 'query.model')).hash).toBe(next.hash);
  expect((await q<ModelSummary>(page, 'query.model')).name).toBe('new active project');
});

for (const producer of ['initiating', 'independent'] as const) test(`@cpu a deferred import preserves same-project edits from the ${producer} producer`, async ({ page }) => {
  test.setTimeout(90_000);
  await deferFileRead(page); await start(page);
  await page.evaluate(() => window.fem.dispatch({ cmd: 'file.openExample', name: 'cantilever' }));
  await page.evaluate(() => window.fem.dispatch({ cmd: 'selection.clear' }));
  const args = { name: 'late import', body: 'bar', mode: 'static', unitLength: '1 mm', unitForce: '1 N', picker: true };
  // Selection is a view-only barrier: the test opens it only once the actual File read has
  // started, so the script's Material edit uses the importing producer during that read.
  const code = `const late = fem.file.importAbaqus(${JSON.stringify(args)}); while (!(await fem.query.selection()).refs.includes("body:beam")) await new Promise(resolve => setTimeout(resolve,10)); await fem.material.add({name:"steel",E:"220 GPa",nu:0.3}); await late;`;
  const chosen = page.waitForEvent('filechooser');
  const pending = producer === 'initiating'
    ? page.evaluate(code => window.fem.dispatch({ cmd: 'script.run', code }), code).then(result => (result as { error?: string }).error ?? null)
    : page.evaluate(async args => { try { await window.fem.dispatch({ cmd: 'file.importAbaqus', ...args }); return null; } catch (error) { return (error as { code: string }).code; } }, args);
  await (await chosen).setFiles({ name: 'late.inp', mimeType: 'text/plain', buffer: await readFile(fixture) });
  await page.waitForFunction(() => typeof (window as unknown as { releaseAbaqusRead?: unknown }).releaseAbaqusRead === 'function');
  if (producer === 'initiating') {
    await page.evaluate(() => window.fem.dispatch({ cmd: 'selection.set', refs: ['body:beam'] }));
    await expect.poll(async () => (await q<ModelSummary>(page, 'query.model')).materials.find(row => row.name === 'steel')!.E).toEqual({ value: 220000, unit: 'MPa' });
  } else await page.evaluate(() => window.fem.dispatch({ cmd: 'material.add', name: 'steel', E: '220 GPa', nu: 0.3 }));
  await page.evaluate(() => window.fem.dispatch({ cmd: 'project.save' }));
  const before = await q<ModelSummary>(page, 'query.model');
  const journal = await q<JournalDump>(page, 'query.journal');
  const result = await q<ResultSummary>(page, 'query.result');
  const project = await q<OpenProject>(page, 'query.project');
  await page.evaluate(() => (window as unknown as { releaseAbaqusRead(): Promise<void> }).releaseAbaqusRead());
  expect(await pending).toContain(producer === 'initiating' ? 'model changed before replacement preparation' : 'session.conflict');
  expect((await q<ModelSummary>(page, 'query.model')).hash).toBe(before.hash);
  expect(await q<JournalDump>(page, 'query.journal')).toEqual(journal);
  expect(await q<ResultSummary>(page, 'query.result')).toEqual(result);
  expect((await q<OpenProject>(page, 'query.project')).id).toBe(project.id);
  await expect(page.getByRole('dialog', { name: 'Abaqus import report', exact: true })).toBeHidden();
  await page.evaluate(() => window.fem.dispatch({ cmd: 'project.new', name: 'check saved edit' }));
  await page.evaluate(id => window.fem.dispatch({ cmd: 'project.open', id }), project.id);
  expect((await q<ModelSummary>(page, 'query.model')).hash).toBe(before.hash);
  expect(await q<JournalDump>(page, 'query.journal')).toEqual(journal);
});

test('@cpu view-only actions during a deferred read allow sequential imports on the initiating producer', async ({ page }) => {
  test.setTimeout(90_000);
  await deferFileRead(page); await start(page);
  await page.evaluate(() => window.fem.dispatch({ cmd: 'file.openExample', name: 'cantilever' }));
  const args = { name: 'first import', body: 'bar', mode: 'static', unitLength: '1 mm', unitForce: '1 N', picker: true };
  const second = { ...input(await readFile(fixture, 'utf8'), 'second awaited import'), cmd: undefined };
  const code = `await fem.file.importAbaqus(${JSON.stringify(args)}); await fem.file.importAbaqus(${JSON.stringify(second)}); return await fem.query.model();`;
  const chosen = page.waitForEvent('filechooser');
  const pending = page.evaluate(code => window.fem.dispatch({ cmd: 'script.run', code }), code);
  await (await chosen).setFiles({ name: 'late.inp', mimeType: 'text/plain', buffer: await readFile(fixture) });
  await page.waitForFunction(() => typeof (window as unknown as { releaseAbaqusRead?: unknown }).releaseAbaqusRead === 'function');
  await page.evaluate(async () => {
    await window.fem.dispatch({ cmd: 'selection.set', refs: ['body:beam'] });
    await window.fem.dispatch({ cmd: 'panel.toggle', panel: 'assistant', open: true });
    await window.fem.dispatch({ cmd: 'view.setMode', mode: 'mesh' });
  });
  await page.evaluate(() => (window as unknown as { releaseAbaqusRead(): Promise<void> }).releaseAbaqusRead());
  const scripted = await pending as { error?: string; result: ModelSummary };
  expect(scripted.error).toBeUndefined();
  expect(scripted.result.name).toBe('second awaited import');
  expect((await q<ModelSummary>(page, 'query.model')).hash).toBe(scripted.result.hash);
  await expect(page.getByRole('dialog', { name: 'Abaqus import report', exact: true })).toBeVisible();
});
