import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AbaqusConversionReport, JournalDump, ModelFile, ModelSummary, ResultField, ResultSummary } from '@femlab/registry';
import { loadEngine } from '../src/engine';
import { createRegistry } from '../src/server';

const here = fileURLToPath(new URL('../src', import.meta.url));
const staticFixture = fileURLToPath(new URL('../../../crates/engine/tests/fixtures/abaqus-static/bar-hex-mm-n.inp', import.meta.url));
const meshFixture = fileURLToPath(new URL('../../../crates/engine/tests/fixtures/abaqus/sparse-label-tet.inp', import.meta.url));
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const axial = (result: ResultSummary) => {
  const ux = result.extremes.find(row => row.field === 'displacement' && row.component === 0)!;
  expect(ux.max.unit).toBe('m');
  expect(ux.max.value).toBeCloseTo(5e-7, 13);
  expect(result.reactions.reduce((sum, row) => sum + row.total[0].value, 0)).toBeCloseTo(-1000, 5);
  expect(result.stale).toBe(false);
};

it('imports a scoped nested include deck, solves, exports and replays after the whole submission is deleted', async () => {
  const project = await mkdtemp(path.join(tmpdir(), 'femlab-504-mcp-')); directories.push(project);
  const source = path.join(project, 'submission');
  const deck = await readFile(staticFixture, 'utf8');
  const nodeHeader = '*NODE\n';
  const elementHeader = '*ELEMENT,TYPE=C3D8,ELSET=SOLID\n';
  const node = deck.indexOf(nodeHeader);
  const element = deck.indexOf(elementHeader);
  const sets = deck.indexOf('*NSET,NSET=ROOT\n');
  const material = deck.indexOf('*MATERIAL');
  expect(node).toBeGreaterThan(0); expect(element).toBeGreaterThan(node); expect(sets).toBeGreaterThan(element); expect(material).toBeGreaterThan(sets);
  const nodes = deck.slice(node + nodeHeader.length, element);
  const elements = deck.slice(element + elementHeader.length, sets);
  const root = '** Independent MCP include smoke\n*INCLUDE,INPUT=Parts/Mesh.inc\n';
  const mesh = deck.slice(0, node) + '*NODE,INPUT=Nodes.inc\n*ELEMENT,TYPE=C3D8,ELSET=SOLID,INPUT=Elements.inc\n' + deck.slice(sets, material) + '*INCLUDE,INPUT=Material.inp\n';
  const physics = deck.slice(material);
  await mkdir(path.join(source, 'Parts'), { recursive: true });
  await writeFile(path.join(source, 'Root.inp'), root);
  await writeFile(path.join(source, 'Parts/Mesh.inc'), mesh);
  await writeFile(path.join(source, 'Nodes.inc'), nodes);
  await writeFile(path.join(source, 'Elements.inc'), elements);
  await writeFile(path.join(source, 'Material.inp'), physics);
  const digest = createHash('sha256').update(root).digest('hex');
  const registry = createRegistry({ engine: loadEngine(here), project });
  const imported = await registry.dispatch({ cmd: 'file.importAbaqus', path: 'submission/Root.inp', name: 'MCP imported bar', body: 'bar', mode: 'static', unitLength: '1 mm', unitForce: '1 N', unitTime: '1 s' }) as { report: AbaqusConversionReport };
  expect(imported.report).toMatchObject({ sha256: digest, inputBytes: [root, mesh, nodes, elements, physics].reduce((sum, text) => sum + Buffer.byteLength(text), 0), sourceNodes: 12, activeNodes: 12, sourceElements: 2, analysisConfigured: true, unitLength: { value: 0.001, unit: 'm' }, unitForce: { value: 1, unit: 'N' }, unitTime: { value: 1, unit: 's' }, analysis: { material: 'STEEL', step: 'AXIAL', finalEquilibriumOnly: true } });
  const model = await registry.query({ query: 'query.model' }) as ModelSummary;
  expect(model).toMatchObject({ name: 'MCP imported bar', steps: [{ name: 'AXIAL', solved: false }] });
  expect(await registry.query({ query: 'query.mesh' })).toMatchObject({ nodes: 12, elements: 2 });
  await rm(source, { recursive: true });
  await registry.dispatch({ cmd: 'solve.run', step: 'AXIAL', solver: 'cpu-direct' });
  axial(await registry.query({ query: 'query.result', step: 'AXIAL' }) as ResultSummary);
  const stress = await registry.query({ query: 'query.field', step: 'AXIAL', field: 'stress' }) as ResultField;
  expect(stress.unit).toBe('Pa'); expect(stress.components).toBe(6); expect(stress.values.length).toBeGreaterThan(0); expect(stress.values.length % 6).toBe(0);
  stress.values.forEach((value, component) => expect(Math.abs(value - (component % 6 === 0 ? 1e5 : 0))).toBeLessThan(1e-5));
  await registry.dispatch({ cmd: 'export.file', format: 'journal', path: 'bar.femlab.json' });
  const text = await readFile(path.join(project, 'bar.femlab.json'), 'utf8');
  expect(text).not.toContain(source);
  expect(text).not.toContain('*NODE');
  const file = JSON.parse(text) as ModelFile;
  expect(file.format).toBe('femlab/1');
  const importedMesh = file.journal.entries.map(entry => entry.cmd).find(command => command.cmd === 'mesh.set');
  if (importedMesh?.cmd !== 'mesh.set' || importedMesh.mesher.kind !== 'imported') throw new Error('imported mesh missing');
  expect(importedMesh.mesher.provenance).toMatchObject({
    sha256: digest, sourceName: 'Root.inp',
    sourceFiles: {
      'Parts/Mesh.inc': createHash('sha256').update(mesh).digest('hex'),
      'Nodes.inc': createHash('sha256').update(nodes).digest('hex'),
      'Elements.inc': createHash('sha256').update(elements).digest('hex'),
      'Material.inp': createHash('sha256').update(physics).digest('hex'),
    },
  });
  expect(Object.keys(importedMesh.mesher.provenance?.sourceFiles ?? {})).toHaveLength(4);
  const replay = await loadEngine(here).acquire();
  try {
    await replay.replaceCommands(file.journal.entries.map(entry => entry.cmd));
    expect(await replay.query({ query: 'query.model' })).toMatchObject({ hash: model.hash });
    axial(await replay.query({ query: 'query.result', step: 'AXIAL' }) as ResultSummary);
    expect((await replay.query({ query: 'query.field', step: 'AXIAL', field: 'stress' }) as ResultField).values).toEqual(stress.values);
  } finally { await replay.release(); }

  const before = await registry.query({ query: 'query.journal' }) as JournalDump;
  const result = await registry.query({ query: 'query.result', step: 'AXIAL' });
  for (const { overrides, expected } of [
    { overrides: { text: deck.replace('*STATIC', '*DYNAMIC') }, expected: { code: 'unsupported' } },
    { overrides: { unitForce: '1 kg' }, expected: { code: 'unit.dimension', where: 'unitForce' } },
    { overrides: { unitForce: '0 N' }, expected: { code: 'schema', where: 'unitForce' } },
    { overrides: { mode: 'mesh' }, expected: { code: 'schema', where: 'unitForce' } },
  ]) {
    const command = { cmd: 'file.importAbaqus', text: deck, name: 'rejected', body: 'bar', mode: 'static', unitLength: '1 mm', unitForce: '1 N' };
    await expect(registry.dispatch({ ...command, ...overrides })).rejects.toMatchObject(expected);
    expect(await registry.query({ query: 'query.journal' })).toEqual(before);
    expect(await registry.query({ query: 'query.result', step: 'AXIAL' })).toEqual(result);
  }
});

it('uses the same real inline import in an MCP script for a sparse mesh-only deck', async () => {
  const registry = createRegistry({ engine: loadEngine(here) });
  const text = await readFile(meshFixture, 'utf8');
  const args = { text, name: 'MCP sparse mesh', body: 'tet', mode: 'mesh', unitLength: '1 cm' };
  const scripted = await registry.dispatch({ cmd: 'script.run', code: `const imported = await fem.file.importAbaqus(${JSON.stringify(args)}); return {report:imported.report,mesh:await fem.query.mesh(),model:await fem.query.model()};` }) as { error?: string; result: { report: AbaqusConversionReport; mesh: { nodes: number; elements: number }; model: ModelSummary } };
  expect(scripted.error).toBeUndefined();
  expect(scripted.result.report).toMatchObject({ mode: 'mesh', sourceNodes: 5, activeNodes: 4, sourceElements: 1, sourceLabels: { unusedNodes: [99] }, analysisConfigured: false });
  expect(scripted.result.mesh).toMatchObject({ nodes: 4, elements: 1 });
  expect(scripted.result.model).toMatchObject({ name: 'MCP sparse mesh', materials: [], steps: [] });
});

it.each(['initiating', 'independent'] as const)('preserves an edit by the %s producer admitted while an actual import read is deferred', async producer => {
  const project = await mkdtemp(path.join(tmpdir(), 'femlab-504-admission-')); directories.push(project);
  const engine = loadEngine(here);
  let initiating!: Awaited<ReturnType<typeof engine.acquire>>;
  let release!: (bytes: Uint8Array) => void;
  const bytes = await readFile(meshFixture);
  const pendingRead = new Promise<Uint8Array>(resolve => { release = resolve; });
  let started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const registry = createRegistry({
    engine: { acquire: async () => { initiating = await engine.acquire(); return initiating; } }, project,
    abaqusIo: { pick: async () => null, read: async () => ({ name: 'deferred.inp', size: bytes.length, read: () => { started(); return pendingRead; } }), sha256: async value => createHash('sha256').update(value).digest('hex') },
  });
  await registry.dispatch({ cmd: 'file.importAbaqus', text: await readFile(staticFixture, 'utf8'), name: 'original bar', body: 'bar', mode: 'static', unitLength: '1 mm', unitForce: '1 N' });
  await registry.dispatch({ cmd: 'solve.run', step: 'AXIAL', solver: 'cpu-direct' });
  const pending = registry.dispatch({ cmd: 'file.importAbaqus', path: 'deferred.inp', name: 'late mesh', body: 'tet', mode: 'mesh', unitLength: '1 m' }).then(() => null, error => error as { code: string });
  await reading;
  const writer = producer === 'initiating' ? initiating : await engine.acquire();
  try {
    await writer.dispatch({ cmd: 'material.add', name: 'STEEL', E: '400 GPa', nu: 0 });
    const before = await writer.modelFile();
    const result = await writer.query({ query: 'query.result', step: 'AXIAL' });
    release(bytes);
    expect(await pending).toMatchObject({ code: 'session.conflict' });
    const current = await engine.acquire();
    try {
      expect(await current.modelFile()).toEqual(before);
      expect(await current.query({ query: 'query.result', step: 'AXIAL' })).toEqual(result);
    } finally { await current.release(); }
    await registry.dispatch({ cmd: 'export.file', format: 'journal', path: 'preserved.femlab.json' });
    expect(JSON.parse(await readFile(path.join(project, 'preserved.femlab.json'), 'utf8'))).toEqual(before);
  } finally { if (producer === 'independent') await writer.release(); }
});
