import { describe, expect, it, vi } from 'vitest';
import schema from '../src/generated/engine.schema.json';
import { FemError } from '../src/error';
import { HOST_COMMANDS, HOST_QUERIES } from '../src/host-commands';
import { Registry, type EngineSchema } from '../src/registry';
import { EXPORT_FORMATS, extremesCsv, pathCsv, reactionsCsv } from '../src/host-commands';
import { ACK, FOLDER, MODEL_FILE, PATH, PROJECT, RESULT, fakeHost, fakeTransport } from './fakes';

const engineSchema = schema as unknown as EngineSchema;
const make = (folderOpen = false) => {
  const transport = fakeTransport();
  const host = fakeHost(transport, folderOpen);
  return { transport, host, registry: new Registry({ schema: engineSchema, host }) };
};
const schemaCommands = engineSchema.commands.oneOf.map((v) => v.properties['cmd']!.const!);
const schemaQueries = engineSchema.queries.oneOf.map((v) => v.properties['query']!.const!);

/** One valid input per host Command; a Command without a sample fails the exhaustive test below. */
const SAMPLES: Record<string, Record<string, unknown>> = {
  'view.fit': {},
  'view.setCamera': { position: [0, 0, 0], target: [1, 1, 1] },
  'view.preset': { view: 'iso' },
  'view.setProjection': { projection: 'orthographic' },
  'view.showField': { field: 'displacement' },
  'view.setLegend': { colormap: 'viridis', bands: null, range: 'auto' },
  'view.setDeformScale': { scale: 'auto' },
  'view.setClip': { plane: { normal: [0, 0, 1], offset: 0 } },
  'view.toggle': { layer: 'mesh' },
  'view.setVisible': { bodies: ['beam'], on: false },
  'view.setTheme': { theme: 'dark' },
  'view.animate': { step: 'static', playing: true },
  'selection.set': { bodies: ['beam'], mode: 'add' },
  'selection.clear': {},
  'selection.setPickTarget': { target: 'face' },
  'panel.toggle': { panel: 'palette', open: true },
  'panel.resize': { panel: 'tree', size: 300 },
  'query.validateScript': { code: '1 + 1' },
  'script.run': { code: '1 + 1', timeoutMs: 100 },
  'script.stop': {},
  'script.setSource': { code: 'fem.model.new({ name: "a" })', append: true },
  'chat.send': { text: 'hello @body:beam' },
  'chat.insertMention': { ref: 'body:beam' },
  'chat.clear': {},
  'skill.invoke': { name: 'beam-theory-check', args: 'beam' },
  'clipboard.copy': { what: { kind: 'text', text: 'plain' } },
  'file.open': { json: JSON.stringify(MODEL_FILE) },
  'file.save': {},
  'file.export': { spec: { format: 'vtu' } },
  'file.shareLink': {},
  'file.autosave': { on: true },
  'file.read': { path: 'AGENTS.md' },
  'file.write': { path: 'reports/a.md', text: '# a' },
  'folder.open': { picker: true },
  'folder.close': {},
  'folder.refresh': {},
  'project.new': { name: 'beam' },
  'project.open': { id: 'p1' },
  'project.rename': { name: 'beam-2' },
  'project.delete': { id: 'p1' },
  'project.save': {},
  'example.open': { name: 'cantilever' },
  'solve.cancel': {},
  'ai.setKey': { key: null },
  'ai.setModel': { model: 'claude-opus-5' },
};

describe('Registry', () => {
  it('lists every schema Command and Query plus every host Command and Query', () => {
    const { registry } = make();
    const { commands, queries } = registry.list();
    const names = commands.map((c) => c.name);
    for (const n of schemaCommands) expect(names).toContain(n);
    for (const h of HOST_COMMANDS) expect(names).toContain(h.name);
    expect(commands).toHaveLength(schemaCommands.length + HOST_COMMANDS.length);
    const qnames = queries.map((q) => q.name);
    for (const n of schemaQueries) expect(qnames).toContain(n);
    for (const h of HOST_QUERIES) expect(qnames).toContain(h.name);
    // query.capabilities is the one host Query that wraps the engine's
    expect(queries).toHaveLength(schemaQueries.length + HOST_QUERIES.length - 1);
    expect(registry.describe('query.capabilities').provider).toBe('host');
  });

  it('flags engine Commands as journaled except journal.*, host Commands never, stubs not tools', () => {
    const { registry } = make();
    const { commands } = registry.list();
    for (const c of commands) {
      if (c.provider === 'host') expect(c.journaled).toBe(false);
      else expect(c.journaled).toBe(!c.name.startsWith('journal.'));
    }
    expect(registry.describe('plugin.load').tool).toBe(false);
    expect(registry.describe('ai.setKey').tool).toBe(false);
    expect(registry.describe('geometry.addBox').tool).toBe(true);
    expect(registry.describe('geometry.addBox').description.length).toBeGreaterThan(80);
    expect(registry.describe('view.fit').schema).not.toHaveProperty('$schema');
  });

  it('describe throws a structured not-found error with known names', () => {
    const { registry } = make();
    let err: unknown;
    try {
      registry.describe('geometry.addSphere');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FemError);
    expect((err as FemError).toJSON()).toMatchObject({ code: 'not-found', where: 'name' });
    expect((err as FemError).suggestion).toContain('geometry.addBox');
    expect((err as FemError).suggestion).not.toContain('view.fit');
  });

  it('routes engine Commands and Queries to the transport untouched', async () => {
    const { registry, transport } = make();
    const cmd = { cmd: 'geometry.addBox', name: 'beam', size: ['1 m', '1 m', '1 m'] };
    await expect(registry.dispatch(cmd)).resolves.toEqual(ACK);
    expect(transport.dispatch).toHaveBeenCalledWith(cmd);
    await registry.query({ query: 'query.model' });
    expect(transport.query).toHaveBeenCalledWith({ query: 'query.model' });
  });

  it('rejects unknown Commands and Queries before the transport sees them', async () => {
    const { registry, transport } = make();
    await expect(registry.dispatch({ cmd: 'geometry.addSphere' })).rejects.toMatchObject({ code: 'not-found', where: 'cmd' });
    await expect(registry.query({ query: 'query.nothing' })).rejects.toMatchObject({ code: 'not-found', where: 'query' });
    expect(transport.dispatch).not.toHaveBeenCalled();
    expect(transport.query).not.toHaveBeenCalled();
  });

  it('validates host Command input with zod and reports the engine error shape', async () => {
    const { registry, host } = make();
    const err = await registry.dispatch({ cmd: 'view.setTheme', theme: 'sepia' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FemError);
    expect(JSON.parse(JSON.stringify(err))).toEqual({
      code: 'schema',
      cause: expect.stringContaining('view.setTheme'),
      where: 'theme',
      suggestion: expect.stringContaining("describe('view.setTheme')"),
    });
    expect(host.view.setTheme).not.toHaveBeenCalled();
    // a non-object input has no path: `where` is null
    const bad = (await registry.dispatch({ cmd: 'view.setCamera', position: 'here' }).catch((e: unknown) => e)) as FemError;
    expect(bad.where).toBe('position');
    const root = (await registry.query({ query: 'query.screenshot', width: 'wide' }).catch((e: unknown) => e)) as FemError;
    expect(root.code).toBe('schema');
    // a union that matches no member reports at the root: `where` is null
    const union = (await registry.dispatch({ cmd: 'view.showField', nothing: true }).catch((e: unknown) => e)) as FemError;
    expect(union.toJSON()).toMatchObject({ code: 'schema', where: null });
  });

  it('dispatches every host Command to the HostContext and none to the transport', async () => {
    const { registry, transport } = make();
    for (const h of HOST_COMMANDS) {
      expect(SAMPLES, `missing sample for ${h.name}`).toHaveProperty(h.name);
      await registry.dispatch({ cmd: h.name, ...SAMPLES[h.name] });
    }
    expect(transport.dispatch).not.toHaveBeenCalled();
    for (const h of HOST_QUERIES) await registry.query({ query: h.name, ...SAMPLES[h.name] });
    expect(transport.dispatch).not.toHaveBeenCalled();
  });

  it('validates scripts before execution and returns diagnostics without engine mutation', async () => {
    const { registry, host, transport } = make();
    const invalid = { ok: false, diagnostics: [{ code: 'TS2339', cause: 'unknown API', where: { line: 1, column: 1 }, hint: 'fix the call' }] };
    vi.mocked(host.script.validate).mockResolvedValue(invalid);
    await expect(registry.query({ query: 'query.validateScript', code: 'wrong', timeoutMs: 200 })).resolves.toEqual(invalid);
    expect(host.script.validate).toHaveBeenCalledWith('wrong', 200);
    await expect(registry.dispatch({ cmd: 'script.run', code: 'wrong' })).resolves.toMatchObject({ error: 'script.validation: correct validation diagnostics before running', diagnostics: invalid.diagnostics });
    expect(host.script.run).not.toHaveBeenCalled();
    expect(transport.dispatch).not.toHaveBeenCalled();
    expect(transport.query).not.toHaveBeenCalled();
  });

  it('host Queries read the HostContext and query.capabilities merges engine and browser facts', async () => {
    const { registry, host } = make(true);
    await expect(registry.query({ query: 'query.capabilities' })).resolves.toEqual({ gpu: false, threads: 4, engineVersion: '0', schemaVersion: '1', webgpu: true, crossOriginIsolated: true, userAgent: 'test', engine: 'local' });
    await expect(registry.query({ query: 'query.selection' })).resolves.toMatchObject({ refs: ['body:beam', 'face:beam.top'] });
    await expect(registry.query({ query: 'query.skills' })).resolves.toEqual([{ name: 'beam-theory-check', description: expect.any(String), when: 'a beam', source: 'builtin' }]);
    await expect(registry.query({ query: 'query.folder' })).resolves.toEqual(FOLDER);
    await expect(registry.query({ query: 'query.view' })).resolves.toMatchObject({ position: [1, 2, 3] });
    await expect(registry.query({ query: 'query.screenshot', width: 800 })).resolves.toEqual({ png: 'data:image/png;base64,QUJD' });
    expect(host.view.screenshot).toHaveBeenCalledWith({ width: 800 });
  });

  it('view.* and selection.* pass their arguments through', async () => {
    const { registry, host } = make();
    await registry.dispatch({ cmd: 'panel.resize', panel: 'properties', size: 360 });
    expect(host.panels.resize).toHaveBeenCalledWith('properties', 360);
    await registry.dispatch({ cmd: 'view.toggle', layer: 'edges', on: false });
    expect(host.view.toggle).toHaveBeenCalledWith('edges', false);
    await registry.dispatch({ cmd: 'view.setClip', plane: null });
    expect(host.view.setClip).toHaveBeenCalledWith(null);
    await registry.dispatch({ cmd: 'view.showField', field: null });
    expect(host.view.showField).toHaveBeenCalledWith({ field: null });
    await registry.dispatch({ cmd: 'selection.set', faces: ['beam.top'] });
    expect(host.selection.set).toHaveBeenCalledWith({ faces: ['beam.top'] });
    await registry.dispatch({ cmd: 'script.setSource', code: 'x' });
    expect(host.script.setSource).toHaveBeenCalledWith('x', undefined);
  });

  it('skill.invoke returns the body or a not-found error listing the skills', async () => {
    const { registry } = make();
    await expect(registry.dispatch({ cmd: 'skill.invoke', name: 'beam-theory-check' })).resolves.toEqual({ name: 'beam-theory-check', body: '# Steps', source: 'builtin', args: '' });
    await expect(registry.dispatch({ cmd: 'skill.invoke', name: 'nope' })).rejects.toMatchObject({ code: 'not-found', suggestion: 'known skills: beam-theory-check' });
  });

  it('clipboard.copy writes selection chips, a mention, the script, or text', async () => {
    const { registry, host } = make();
    const copy = (what: unknown) => registry.dispatch({ cmd: 'clipboard.copy', what });
    await expect(copy({ kind: 'selection' })).resolves.toEqual({ text: '@body:beam @face:beam.top' });
    await expect(copy({ kind: 'mention', ref: 'set:beam.top' })).resolves.toEqual({ text: '@set:beam.top' });
    await expect(copy({ kind: 'script' })).resolves.toEqual({ text: 'fem.model.new({ name: "beam" })' });
    await expect(copy({ kind: 'text', text: 'hi' })).resolves.toEqual({ text: 'hi' });
    expect(host.clipboard.writeText).toHaveBeenCalledTimes(4);
  });

  it('file.open imports from json, folder path or picker; example.open fetches then imports', async () => {
    const { registry, host, transport } = make(true);
    await registry.dispatch({ cmd: 'file.open', json: JSON.stringify(MODEL_FILE) });
    await registry.dispatch({ cmd: 'file.open', path: './models/beam.json' });
    expect(host.folder.readText).toHaveBeenCalledWith('models/beam.json');
    await expect(registry.dispatch({ cmd: 'file.open', json: 'not json' })).rejects.toMatchObject({ code: 'schema', where: 'json' });
    await expect(registry.dispatch({ cmd: 'file.open', path: '../secret.json' })).rejects.toMatchObject({ code: 'file.scope' });
    await registry.dispatch({ cmd: 'file.open', picker: true });
    expect(host.files.pick).toHaveBeenCalled();
    await registry.dispatch({ cmd: 'example.open', name: 'cantilever' });
    expect(host.examples.fetch).toHaveBeenCalledWith('cantilever');
    expect(transport.importFile).toHaveBeenCalledTimes(4);
  });

  it('file.save and file.export deliver to the open folder when there is one, else download', async () => {
    const closed = make(false);
    await expect(closed.registry.dispatch({ cmd: 'file.save' })).resolves.toEqual({ name: 'beam.femlab.json', to: 'download' });
    expect(closed.host.files.download).toHaveBeenCalledWith('beam.femlab.json', 'application/json', expect.stringContaining('"femlab/1"'));
    await expect(closed.registry.dispatch({ cmd: 'file.export', spec: { format: 'vtu' } })).resolves.toEqual({ name: 'beam.vtu', to: 'download' });
    expect(closed.host.files.download).toHaveBeenCalledWith('beam.vtu', 'application/xml', new Uint8Array([1, 2]));

    const open = make(true);
    await expect(open.registry.dispatch({ cmd: 'file.save', name: 'v2.json' })).resolves.toEqual({ name: 'v2.json', to: 'folder' });
    expect(open.host.folder.writeText).toHaveBeenCalledWith('v2.json', expect.any(String));
    await open.registry.dispatch({ cmd: 'file.export', spec: { format: 'vtu' } });
    expect(open.host.folder.writeBytes).toHaveBeenCalledWith('beam.vtu', new Uint8Array([1, 2]));
    await expect(open.registry.dispatch({ cmd: 'file.export', spec: { format: 'vtu' }, to: 'download' })).resolves.toMatchObject({ to: 'download' });
    await expect(open.registry.dispatch({ cmd: 'file.shareLink' })).resolves.toEqual({ url: 'https://x/#j' });
    expect(open.host.files.shareLink).toHaveBeenCalledWith(MODEL_FILE);
  });

  it('file.autosave switches the background save without touching what is already saved', async () => {
    const { registry, host } = make();
    await expect(registry.dispatch({ cmd: 'file.autosave', on: false })).resolves.toEqual({ enabled: false });
    expect(host.files.setAutosave).toHaveBeenCalledWith(false);
    // Off stops writing; the projects saved in this browser are still listed and still openable.
    await expect(registry.query({ query: 'query.projects' })).resolves.toEqual({ projects: [PROJECT] });
    await expect(registry.query({ query: 'query.project' })).resolves.toMatchObject({ autosave: false });

    await expect(registry.dispatch({ cmd: 'file.autosave', on: true })).resolves.toEqual({ enabled: true });
    // `on` is required and typed: the schema, not the host, rejects a bad call
    await expect(registry.dispatch({ cmd: 'file.autosave' })).rejects.toMatchObject({ code: 'schema' });
    await expect(registry.dispatch({ cmd: 'file.autosave', on: 'yes' })).rejects.toMatchObject({ code: 'schema' });
  });

  it('project.* is one saved Model in this browser, and query.project* is a view of it', async () => {
    const { registry, host } = make();
    await expect(registry.query({ query: 'query.projects' })).resolves.toEqual({ projects: [PROJECT] });
    await expect(registry.query({ query: 'query.project' })).resolves.toEqual({ ...PROJECT, saving: false, autosave: true });

    await expect(registry.dispatch({ cmd: 'project.new' })).resolves.toMatchObject({ name: 'model', commands: 0 });
    expect(host.projects.new).toHaveBeenCalledWith(undefined);
    await expect(registry.dispatch({ cmd: 'project.new', name: 'corbel' })).resolves.toMatchObject({ name: 'corbel' });

    await expect(registry.dispatch({ cmd: 'project.open', id: 'p9' })).resolves.toMatchObject({ id: 'p9' });
    expect(host.projects.open).toHaveBeenCalledWith('p9');
    await expect(registry.dispatch({ cmd: 'project.open' })).rejects.toMatchObject({ code: 'schema' });

    // `id` defaults to the open project, which is what the top bar's inline field sends
    await expect(registry.dispatch({ cmd: 'project.rename', name: 'ULS' })).resolves.toMatchObject({ name: 'ULS' });
    expect(host.projects.rename).toHaveBeenCalledWith(undefined, 'ULS');
    await expect(registry.dispatch({ cmd: 'project.save' })).resolves.toMatchObject({ id: PROJECT.id, saving: false, journal: MODEL_FILE.journal });

    await registry.dispatch({ cmd: 'project.delete', id: PROJECT.id });
    expect(host.projects.delete).toHaveBeenCalledWith(PROJECT.id);
    await expect(registry.query({ query: 'query.project' })).resolves.toBeNull();
    await expect(registry.query({ query: 'query.projects' })).resolves.toEqual({ projects: [] });
    await expect(registry.dispatch({ cmd: 'project.save' })).resolves.toBeNull();
  });

  it('file.read and file.write stay inside the open folder and refuse big files', async () => {
    const { registry, host } = make(true);
    await expect(registry.dispatch({ cmd: 'file.read', path: 'AGENTS.md' })).resolves.toEqual({ text: 'content of AGENTS.md' });
    await expect(registry.dispatch({ cmd: 'file.read', path: 'big.txt' })).rejects.toMatchObject({ code: 'unsupported' });
    await expect(registry.dispatch({ cmd: 'file.read', path: '/etc/passwd' })).rejects.toMatchObject({ code: 'file.scope' });
    await registry.dispatch({ cmd: 'file.write', path: 'a\\b.md', text: 'x' });
    expect(host.folder.writeText).toHaveBeenCalledWith('a/b.md', 'x');
    await expect(registry.dispatch({ cmd: 'file.write', path: '../b.md', text: 'x' })).rejects.toMatchObject({ code: 'file.scope' });
  });

  it('folder.*, solve.cancel and ai.* call straight through', async () => {
    const { registry, host, transport } = make();
    await registry.dispatch({ cmd: 'folder.open', handle: { kind: 'directory' } });
    expect(host.folder.open).toHaveBeenCalledWith({ handle: { kind: 'directory' } });
    await registry.dispatch({ cmd: 'folder.close' });
    expect(host.folder.close).toHaveBeenCalled();
    await registry.dispatch({ cmd: 'folder.refresh' });
    expect(host.folder.refresh).toHaveBeenCalled();
    await expect(registry.query({ query: 'query.folder' })).resolves.toBeNull();
    await expect(make(true).registry.query({ query: 'query.folder' })).resolves.toEqual(FOLDER);
    await registry.dispatch({ cmd: 'solve.cancel' });
    expect(transport.cancel).toHaveBeenCalled();
    await registry.dispatch({ cmd: 'ai.setKey', key: 'sk' });
    expect(host.ai.setKey).toHaveBeenCalledWith('sk');
    await registry.dispatch({ cmd: 'ai.setModel', model: 'm' });
    expect(host.ai.setModel).toHaveBeenCalledWith('m');
    await expect(registry.dispatch({ cmd: 'script.run', code: '1' })).resolves.toEqual({ result: 1, console: [] });
  });

  it('file.export writes the four formats the engine cannot see, and hands the rest to it', async () => {
    const { registry, host, transport } = make();
    const wrote = (): [string, string, string | Uint8Array] => (host.files.download as unknown as { mock: { calls: [string, string, string | Uint8Array][] } }).mock.calls.at(-1)!;

    await expect(registry.dispatch({ cmd: 'file.export', spec: { format: 'script' } })).resolves.toEqual({ name: 'beam.ts', to: 'download' });
    expect(wrote()).toEqual(['beam.ts', 'text/typescript', 'fem.model.new({ name: "beam" })']);

    await registry.dispatch({ cmd: 'file.export', spec: { format: 'journal' } });
    expect(wrote()[0]).toBe('beam.femlab.json');
    expect(String(wrote()[2])).toContain('"femlab/1"');

    await registry.dispatch({ cmd: 'file.export', spec: { format: 'png' } });
    expect(host.view.screenshot).toHaveBeenCalledWith({ legend: true });
    expect(wrote()).toEqual(['beam.png', 'image/png', new Uint8Array([65, 66, 67])]);
    await registry.dispatch({ cmd: 'file.export', spec: { format: 'png', legend: false } });
    expect(host.view.screenshot).toHaveBeenLastCalledWith({ legend: false });

    await registry.dispatch({ cmd: 'file.export', spec: { format: 'csv' } });
    expect(wrote()[0]).toBe('beam-extremes.csv');
    await registry.dispatch({ cmd: 'file.export', spec: { format: 'csv', table: 'reactions', step: 'static' } });
    expect(wrote()[0]).toBe('beam-reactions.csv');
    expect(transport.query).toHaveBeenCalledWith({ query: 'query.result', step: 'static' });
    await registry.dispatch({ cmd: 'file.export', spec: { format: 'csv', table: 'path', path: { field: 'vonMises', from: ['0 m', '0 m', '0 m'], to: ['1 m', '0 m', '0 m'], n: 3 } } });
    expect(wrote()).toEqual(['beam-path.csv', 'text/csv', pathCsv(PATH)]);

    // the calculation note is an engine export like the mesh ones: `query.report` writes it
    await registry.dispatch({ cmd: 'file.export', spec: { format: 'report' } });
    expect(transport.export).toHaveBeenCalledWith({ format: 'report' });
    await registry.dispatch({ cmd: 'file.export', spec: { format: 'msh' } });
    expect(transport.export).toHaveBeenCalledWith({ format: 'msh' });
  });

  it('the CSV writers carry the numbers the Results tab shows', () => {
    expect(extremesCsv(RESULT).split('\n')).toEqual([
      'field,component,min,minX,minY,minZ,max,maxX,maxY,maxZ,unit',
      'displacement,2,-0.19,1000,50,50,0,0,0,0,mm',
      '',
    ]);
    expect(reactionsCsv(RESULT).split('\n')).toEqual([
      'constraint,fx,fy,fz,unit',
      'root,0,0,1,kN',
      'sum reactions,0,0,1,kN',
      'sum applied,0,0,-1,kN',
      'balance,0,,,',
      '',
    ]);
    expect(pathCsv(PATH)).toBe('s,value (MPa)\n0,0\n0.5,\n1,2\n');
    // A name with a comma in it has to survive the round trip.
    const quoted = reactionsCsv({ ...RESULT, reactions: [{ constraint: 'root, left', total: RESULT.reactions[0]!.total }] });
    expect(quoted).toContain('"root, left"');
  });

  it('query.exportFormats is the Export dialog', async () => {
    const { registry } = make();
    await expect(registry.query({ query: 'query.exportFormats' })).resolves.toEqual({ formats: EXPORT_FORMATS });
    expect(EXPORT_FORMATS.map((f) => f.format)).toContain('stl');
  });

  it('accepts a custom host table', async () => {
    const host = fakeHost();
    const run = vi.fn(() => 'ok');
    const { z } = await import('zod');
    const registry = new Registry({ schema: engineSchema, host, hostCommands: [{ name: 'x.y', description: 'd', schema: z.object({}), tool: true, run }], hostQueries: [] });
    await expect(registry.dispatch({ cmd: 'x.y' })).resolves.toBe('ok');
    expect(run).toHaveBeenCalledWith({}, host);
    expect(registry.list().commands).toHaveLength(schemaCommands.length + 1);
  });
});

it('marks only successful explicit saves and imports, using the captured normalized Journal', async () => {
  const { registry, host, transport } = make(true);
  const captured = { ...MODEL_FILE, journal: { entries: [{ seq: 0, cmd: { cmd: 'model.new' as const, name: 'saved' }, hashAfter: 'saved-hash' }] } };
  const later = { ...MODEL_FILE, journal: { entries: [{ seq: 0, cmd: { cmd: 'model.new' as const, name: 'edited' }, hashAfter: 'edited-hash' }] } };
  vi.mocked(transport.exportFile).mockResolvedValue(captured);
  let finish!: () => void;
  vi.mocked(host.folder.writeText).mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  const saving = registry.dispatch({ cmd: 'file.save', to: 'folder' });
  await vi.waitFor(() => expect(host.folder.writeText).toHaveBeenCalled());
  expect(host.files.markSaved).not.toHaveBeenCalled();
  vi.mocked(transport.exportFile).mockResolvedValue(later);
  finish(); await saving;
  expect(host.files.markSaved).toHaveBeenLastCalledWith(captured.journal);
  vi.mocked(host.files.markSaved).mockClear();
  vi.mocked(host.folder.writeText).mockRejectedValue(new Error('write failed'));
  await expect(registry.dispatch({ cmd: 'file.save', to: 'folder' })).rejects.toThrow('write failed');
  expect(host.files.markSaved).not.toHaveBeenCalled();
  // The engine may normalize omitted/default fields; the imported receipt is authoritative.
  vi.mocked(transport.importFile).mockResolvedValue({ ...ACK, journal: later.journal });
  await registry.dispatch({ cmd: 'file.open', json: JSON.stringify(captured) });
  expect(host.files.markSaved).toHaveBeenLastCalledWith(later.journal);
  vi.mocked(host.files.markSaved).mockClear();
  vi.mocked(transport.importFile).mockRejectedValue(new Error('import failed'));
  await expect(registry.dispatch({ cmd: 'file.open', json: JSON.stringify(captured) })).rejects.toThrow('import failed');
  expect(host.files.markSaved).not.toHaveBeenCalled();
});

it('marks exactly the successful project-save receipt, leaving failures and null saves unchanged', async () => {
  const { registry, host, transport } = make();
  const journal = { entries: [{ seq: 0, cmd: { cmd: 'model.new' as const, name: 'captured' }, hashAfter: 'captured' }] };
  const receipt = { ...PROJECT, saving: false, autosave: false, journal };
  let finish!: (value: typeof receipt) => void;
  vi.mocked(host.projects.save).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const pending = registry.dispatch({ cmd: 'project.save' });
  await vi.waitFor(() => expect(host.projects.save).toHaveBeenCalledOnce());
  expect(host.files.markSaved).not.toHaveBeenCalled();
  // A later edit must not replace the payload that the project actually persisted.
  vi.mocked(transport.exportFile).mockResolvedValue({ ...MODEL_FILE, journal: { entries: [] } });
  finish(receipt);
  await expect(pending).resolves.toEqual(receipt);
  expect(host.files.markSaved).toHaveBeenCalledExactlyOnceWith(journal);
  expect(transport.exportFile).not.toHaveBeenCalled();
  vi.mocked(host.files.markSaved).mockClear();
  vi.mocked(host.projects.save).mockRejectedValueOnce(new Error('storage failed'));
  await expect(registry.dispatch({ cmd: 'project.save' })).rejects.toThrow('storage failed');
  expect(host.files.markSaved).not.toHaveBeenCalled();
  vi.mocked(host.projects.save).mockResolvedValueOnce(null);
  await expect(registry.dispatch({ cmd: 'project.save' })).resolves.toBeNull();
  expect(host.files.markSaved).not.toHaveBeenCalled();
});
