import { readFile } from 'node:fs/promises';
import type { JournalEntry, MaterialLibrary, ModelFile, ModelSummary } from '@femlab/registry';
import { expect, test } from './fixtures';

const cases = [
  { entry: 's355j2', expected: { E: '210 GPa', nu: 0.3, rho: '7850 kg/m^3', alpha: '0.000012 1/K', yield: '355 MPa' } },
  { entry: '6061-t6-sheet', expected: { E: '68.3 GPa', nu: 0.33, rho: '2710 kg/m^3', alpha: '0.0000227 1/K', k: '152 W/(m K)', cp: '879 J/(kg K)', yield: '248 MPa' } },
];

for (const { entry, expected } of cases) test(`@cpu catalogue ${entry} preserves every sourced value through a browser file restore`, async ({ page }, info) => {
  await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed', '1'));
  await page.goto('./');
  await page.waitForFunction(() => !!window.fem);
  await page.evaluate(() => window.fem.dispatch({ cmd: 'project.new', name: 'catalogue regression' }));
  const catalogue = await page.evaluate(entry => window.fem.registry.query({ query: 'query.materialLibrary', name: entry }), entry) as MaterialLibrary;
  const validation = await page.evaluate(entry => window.fem.registry.query({ query: 'query.validateScript', code: `await fem.material.addFromLibrary({ entry: '${entry}', name: 'material' });` }), entry);
  expect(validation).toMatchObject({ ok: true });
  await page.evaluate(entry => window.fem.dispatch({ cmd: 'material.addFromLibrary', entry, name: 'material' }), entry);
  const before = await page.evaluate(() => window.fem.registry.query({ query: 'query.model' })) as ModelSummary;
  const journal = await page.evaluate(() => window.fem.registry.query({ query: 'query.journal' })) as { entries: JournalEntry[] };
  expect(journal.entries.at(-1)!.cmd).toEqual({ cmd: 'material.add', name: 'material', source: catalogue.entries[0]!.materialAddSource, ...expected });
  const pending = page.waitForEvent('download');
  await page.evaluate(() => window.fem.dispatch({ cmd: 'file.save', name: 'catalogue.femlab.json', to: 'download' }));
  const filename = info.outputPath(`${entry}.femlab.json`);
  await (await pending).saveAs(filename);
  const json = await readFile(filename, 'utf8');
  const saved = JSON.parse(json) as ModelFile;
  expect(saved.journal.entries).toEqual(journal.entries);
  await page.evaluate(() => window.fem.dispatch({ cmd: 'project.new', name: 'replacement' }));
  await page.evaluate(json => window.fem.dispatch({ cmd: 'file.open', json }), json);
  const restored = await page.evaluate(() => window.fem.registry.query({ query: 'query.model' })) as ModelSummary;
  expect(restored.hash).toBe(before.hash);
  expect(restored.materials).toEqual(before.materials);
});
