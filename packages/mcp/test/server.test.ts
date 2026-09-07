// The MCP host with a fake engine: the tool list is the registry, every tool call routes to a
// Command or a Query, `run_script` runs TypeScript, and `export_file` stays inside --project.
import { RUN_SCRIPT, toolNameFor } from '@femlab/registry';
import { mkdtemp, readFile, symlink, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { missingEngine, wasmCandidates, WASM_ENTRY, loadEngine, type EngineHandle, type EngineProvider } from '../src/engine';
import { projectFrom, start } from '../src/cli';
import { describe as describeError, runScript } from '../src/script';
import {
  callTool,
  createRegistry,
  createServer,
  errorText,
  exportText,
  readResource,
  resolveInProject,
  RESOURCES,
  toolList,
  type ServerDeps,
} from '../src/server';

const MODEL = { name: 'beam', revision: 1, hash: 'abc', bodies: [], warnings: [] };

/** An engine that records what it was asked and answers plausibly. */
function fakeEngine(): EngineHandle & EngineProvider & { seen: unknown[] } {
  const seen: unknown[] = [];
  return {
    seen,
    acquire: async function () { return this; },
    release: async () => undefined,
    dispatch: (cmd) => {
      seen.push(cmd);
      if (cmd['cmd'] === 'material.add' && (cmd['nu'] === undefined || Number(cmd['nu']) < 0)) {
        return Promise.reject({ code: 'schema', cause: 'nu must be present and nonnegative', where: 'nu' });
      }
      return Promise.resolve({ seq: seen.length, revision: seen.length, hash: 'abc', warnings: [], output: { type: 'export', text: `<${String(cmd['format'])}>` } });
    },
    query: (q) => {
      seen.push(q);
      if (q['query'] === 'query.script') return Promise.resolve({ text: 'await fem.model.new({ name: "beam" });\n' });
      if (q['query'] === 'query.journal') return Promise.resolve({ entries: [], revision: 0 });
      return Promise.resolve(MODEL);
    },
    modelFile: () => ({ format: 'femlab/1', model: MODEL }),
  };
}

const scratch = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'femlab-mcp-'));

describe('the tool list', () => {
  it('is the registry: every engine Command and Query, plus run_script and export_file', () => {
    const tools = toolList(createRegistry({ engine: fakeEngine() }));
    const names = tools.map((t) => t.name);
    expect(names).toContain(toolNameFor('geometry.addBox'));
    expect(names).toContain(toolNameFor('query.report'));
    expect(names).toContain(toolNameFor('solve.run'));
    expect(names).toContain('export_file');
    expect(names).toContain(RUN_SCRIPT);
    // no view, no selection, no panels: this host has no screen to move
    expect(names.filter((n) => n.startsWith('view_') || n.startsWith('selection_'))).toEqual([]);
    // MCP's own rules: unique names, a real description, a self-contained object schema
    expect(new Set(names).size).toBe(names.length);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
      expect(t.description.length).toBeGreaterThanOrEqual(80);
      expect(t.inputSchema.properties).not.toHaveProperty('cmd');
      expect(t.inputSchema.required ?? []).not.toContain('cmd');
      expect(t.inputSchema.properties).not.toHaveProperty('query');
      expect(t.inputSchema.required ?? []).not.toContain('query');
    }
    // Journal inputs retain their nested Command discriminators; only the tool's own
    // discriminator is supplied by its MCP name instead of an argument.
    const diff = tools.find((t) => t.name === toolNameFor('query.journalDiff'))!;
    expect(diff.inputSchema.properties).toHaveProperty('base');
    expect(JSON.stringify(diff.inputSchema)).toContain('"cmd"');
  });
});

describe('calling a tool', () => {
  it('routes a Query to query and a Command to dispatch, and names an unknown tool', async () => {
    const engine = fakeEngine();
    const registry = createRegistry({ engine });
    expect(await callTool(registry, 'query_model', {})).toEqual(MODEL);
    await callTool(registry, 'geometry_addBox', { name: 'beam', size: ['1 m', '1 m', '1 m'] });
    expect(engine.seen).toEqual([{ query: 'query.model' }, { cmd: 'geometry.addBox', name: 'beam', size: ['1 m', '1 m', '1 m'] }]);
    await expect(callTool(registry, 'no_such_tool', {})).rejects.toMatchObject({ code: 'not-found' });
  });

  it('validates without engine access and refuses invalid scripts before worker execution', async () => {
    const engine = fakeEngine();
    const registry = createRegistry({ engine });
    const validation = await callTool(registry, 'validate_script', { code: 'await fem.material.add({ name: "x", E: "1 Pa" });' }) as { ok: boolean; diagnostics: { cause: string }[] };
    expect(validation.ok).toBe(false);
    expect(validation.diagnostics.some((item) => item.cause.includes('nu'))).toBe(true);
    expect(engine.seen).toEqual([]);
    const outcome = await callTool(registry, RUN_SCRIPT, { code: 'await fem.model.new({ name: "would mutate" });\nawait fem.geometry.notReal({});' }) as { error: string };
    expect(outcome.error).toContain('script.validation');
    expect(engine.seen).toEqual([]);
  });

  it('runs TypeScript through run_script, with the console and the errors the person wrote', async () => {
    const engine = fakeEngine();
    const registry = createRegistry({ engine });
    const out = (await callTool(registry, RUN_SCRIPT, {
      code: 'const n: number = 2;\nconsole.log("size", n);\nawait fem.geometry.addBox({ name: "b", size: ["1 m", "1 m", "1 m"] });\nreturn (await fem.query.model()).name;',
    })) as { result: unknown; console: string[] };
    expect(out.result).toBe('beam');
    expect(out.console).toEqual(['size 2']);
    expect(engine.seen).toContainEqual({ cmd: 'geometry.addBox', name: 'b', size: ['1 m', '1 m', '1 m'] });
    const bad = (await callTool(registry, RUN_SCRIPT, { code: 'await fem.material.add({ name: "x", E: "1 Pa" });' })) as { error: string };
    expect(bad.error).toContain('script.validation');
    expect(engine.seen).not.toContainEqual(expect.objectContaining({ cmd: 'material.add' }));
    const runtime = await callTool(registry, RUN_SCRIPT, { code: 'await fem.material.add({ name: "x", E: "1 Pa", nu: -0.1 });' }) as { error: string };
    expect(runtime.error).toContain('schema: nu must be present and nonnegative');
  });
});

describe('run_script on its own', () => {
  const nothing = () => Promise.resolve(null);

  it('reports a syntax error, a thrown error and a timeout without hanging', async () => {
    expect((await runScript('const = ;', nothing, nothing)).error).toContain('Unexpected token');
    const thrown = await runScript('throw new Error("boom");', nothing, nothing);
    expect(thrown.error).toContain('boom');
    const slow = await runScript('await new Promise((r) => setTimeout(r, 50));', nothing, nothing, 1);
    expect(slow.error).toBe('the script did not finish within 0.001 s');
  });

  it('sends back only what survives JSON, and logs every console level', async () => {
    const out = await runScript('console.warn("a"); console.error(1); console.debug({ x: 1 }); console.info(undefined); return () => 1;', nothing, nothing);
    expect(out.console).toEqual(['a', '1', '{"x":1}', 'undefined']);
    expect(out.result).toBe('() => 1');
    expect((await runScript('const cyclic: any = {}; cyclic.self = cyclic; return cyclic;', nothing, nothing)).result).toBe('[object Object]');
    expect((await runScript('const nothing = 1;', nothing, nothing)).result).toBe(null);
  });

  it('names the line a thrown error came from when the stack carries one', () => {
    expect(describeError({ message: 'x', stack: 'Error: x\n    at <anonymous>:5:3' })).toBe('x (line 2)');
    expect(describeError('plain')).toBe('plain');
  });
});

describe('export_file', () => {
  it('writes each format into the project folder and refuses to leave it', async () => {
    const root = await scratch();
    const engine = fakeEngine();
    const registry = createRegistry({ engine, project: root });
    const wrote = (await callTool(registry, 'export_file', { format: 'msh', path: 'out/mesh.msh' })) as { path: string; bytes: number };
    expect(wrote).toEqual({ path: 'out/mesh.msh', bytes: 5 });
    expect(await readFile(path.join(root, 'out', 'mesh.msh'), 'utf8')).toBe('<msh>');
    await callTool(registry, 'export_file', { format: 'report', path: 'note.md', step: 'static' });
    expect(engine.seen).toContainEqual({ cmd: 'mesh.export', format: 'report', step: 'static' });
    await callTool(registry, 'export_file', { format: 'script', path: 'model.ts' });
    expect(await readFile(path.join(root, 'model.ts'), 'utf8')).toContain('await fem.model.new');
    await callTool(registry, 'export_file', { format: 'journal', path: 'model.femlab.json' });
    expect(await readFile(path.join(root, 'model.femlab.json'), 'utf8')).toContain('"femlab/1"');
    // the path rules: `..`, absolute paths and a symlink out of the folder
    await expect(callTool(registry, 'export_file', { format: 'msh', path: '../escape.msh' })).rejects.toMatchObject({ code: 'file.scope' });
    await expect(callTool(registry, 'export_file', { format: 'msh', path: '/etc/passwd' })).rejects.toMatchObject({ code: 'file.scope' });
    const outside = await scratch();
    await symlink(outside, path.join(root, 'link'), 'dir');
    await expect(callTool(registry, 'export_file', { format: 'msh', path: 'link/escape.msh' })).rejects.toMatchObject({ code: 'file.scope' });
    // a folder deeper inside the project is fine, link or not
    await mkdir(path.join(root, 'deep'), { recursive: true });
    await symlink(path.join(root, 'deep'), path.join(root, 'inner'), 'dir');
    await callTool(registry, 'export_file', { format: 'msh', path: 'inner/mesh.msh' });
    expect(await readFile(path.join(root, 'deep', 'mesh.msh'), 'utf8')).toBe('<msh>');
    // and a bad format is a schema error from the registry, before anything is written
    await expect(callTool(registry, 'export_file', { format: 'png', path: 'x.png' })).rejects.toMatchObject({ code: 'schema' });
  });

  it('rejects file links, including dangling links, without changing their targets', async () => {
    const root = await scratch();
    const outside = await scratch();
    const registry = createRegistry({ engine: fakeEngine(), project: root });
    const victim = path.join(outside, 'victim.md');
    await writeFile(victim, 'keep me');
    await symlink(victim, path.join(root, 'report.md'), 'file');
    await expect(callTool(registry, 'export_file', { format: 'report', path: 'report.md' })).rejects.toMatchObject({ code: 'file.scope' });
    expect(await readFile(victim, 'utf8')).toBe('keep me');
    await symlink(path.join(outside, 'missing.md'), path.join(root, 'dangling.md'), 'file');
    await expect(callTool(registry, 'export_file', { format: 'report', path: 'dangling.md' })).rejects.toMatchObject({ code: 'file.scope' });
    expect(await readdir(outside)).toEqual(['victim.md']);
    await writeFile(path.join(root, 'regular.md'), 'a longer old report');
    await callTool(registry, 'export_file', { format: 'report', path: 'regular.md' });
    expect(await readFile(path.join(root, 'regular.md'), 'utf8')).toBe('<report>');
    await symlink(path.join(root, 'regular.md'), path.join(root, 'internal.md'), 'file');
    await expect(callTool(registry, 'export_file', { format: 'report', path: 'internal.md' })).rejects.toMatchObject({ code: 'file.scope' });
  });

  it('validates existing directory links before creating nested directories', async () => {
    const root = await scratch();
    const outside = await scratch();
    const registry = createRegistry({ engine: fakeEngine(), project: root });
    await symlink(outside, path.join(root, 'escape'), 'dir');
    await expect(callTool(registry, 'export_file', { format: 'report', path: 'escape/new/deep/report.md' })).rejects.toMatchObject({ code: 'file.scope' });
    expect(await readdir(outside)).toEqual([]);
    await callTool(registry, 'export_file', { format: 'report', path: 'new/deep/report.md' });
    expect(await readFile(path.join(root, 'new/deep/report.md'), 'utf8')).toBe('<report>');
    await writeFile(path.join(root, 'file'), 'not a directory');
    await expect(resolveInProject(root, 'file/child/report.md')).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it('allows concurrent exports to create a shared nested directory', async () => {
    const root = await scratch();
    const registry = createRegistry({ engine: fakeEngine(), project: root });
    const files = Array.from({ length: 8 }, (_, i) => `new/deep/report-${i}.md`);
    await Promise.all(files.map((file) => callTool(registry, 'export_file', { format: 'report', path: file })));
    for (const file of files) expect(await readFile(path.join(root, file), 'utf8')).toBe('<report>');
  });

  it('refuses every write when the server was started without a project folder', async () => {
    const registry = createRegistry({ engine: fakeEngine() });
    await expect(callTool(registry, 'export_file', { format: 'msh', path: 'x.msh' })).rejects.toMatchObject({ code: 'file.scope' });
    await expect(resolveInProject(undefined, 'x')).rejects.toMatchObject({ code: 'file.scope' });
  });

  it('takes the mesh formats from the engine and the two Journal ones from the Journal', async () => {
    const engine = fakeEngine();
    expect(await exportText(engine, 'vtu')).toBe('<vtu>');
    expect(await exportText(engine, 'script')).toContain('fem.model.new');
    expect(await exportText(engine, 'journal')).toContain('"femlab/1"');
  });
});

describe('resources', () => {
  it('serve the Model, the Journal and the schema, and name an unknown uri', async () => {
    const registry = createRegistry({ engine: fakeEngine() });
    expect(RESOURCES.map((r) => r.uri)).toEqual(['femlab://model', 'femlab://journal', 'femlab://schema']);
    expect(JSON.parse(await readResource(registry, 'femlab://model'))).toEqual(MODEL);
    expect(JSON.parse(await readResource(registry, 'femlab://journal'))).toEqual({ entries: [], revision: 0 });
    expect(JSON.parse(await readResource(registry, 'femlab://schema'))).toHaveProperty('commands');
    await expect(readResource(registry, 'femlab://nope')).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('errors an editor sees', () => {
  it('keep the engine shape, and wrap anything else', () => {
    expect(JSON.parse(errorText({ code: 'schema', cause: 'nu must be present and nonnegative' }))).toMatchObject({ code: 'schema' });
    expect(JSON.parse(errorText(new Error('boom')))).toEqual({ code: 'internal', cause: 'boom' });
    expect(JSON.parse(errorText('bare'))).toEqual({ code: 'internal', cause: 'bare' });
  });
});

describe('the engine handle', () => {
  it('looks in the override, next to dist and in the checkout, and says so when it finds nothing', () => {
    delete process.env['FEMLAB_WASM'];
    const plain = wasmCandidates('/opt/femlab/dist');
    expect(plain).toEqual([path.join('/opt/femlab/dist/wasm-node', WASM_ENTRY), path.join('/tools/wasm-node', WASM_ENTRY)]);
    process.env['FEMLAB_WASM'] = '/elsewhere';
    expect(wasmCandidates('/opt/femlab/dist')[0]).toBe(path.join('/elsewhere', WASM_ENTRY));
    delete process.env['FEMLAB_WASM'];
    const why = missingEngine('/opt/femlab/dist').message;
    expect(why).toContain('node tools/build-wasm.mjs');
    expect(why).toContain(WASM_ENTRY);
    expect(() => loadEngine('/opt/femlab/dist')).toThrow('cannot find the engine');
  });
});

describe('start-up', () => {
  it('resolves --project, refuses a missing one, and connects the server to its transport', async () => {
    expect(projectFrom([])).toBeUndefined();
    expect(projectFrom(['--project', 'x'])).toBe(path.resolve('x'));
    expect(() => projectFrom(['--project'])).toThrow('--project needs a directory');
    expect(() => projectFrom(['--project', '--verbose'])).toThrow('--project needs a directory');
    const transport = { start: vi.fn(() => Promise.resolve()), send: vi.fn(() => Promise.resolve()), close: vi.fn(() => Promise.resolve()) };
    const load = vi.fn((): EngineProvider => fakeEngine());
    await start(['--project', '.'], '/here', load, () => transport);
    expect(load).toHaveBeenCalledWith('/here');
    expect(transport.start).toHaveBeenCalled();
  });

  it('builds a Server with the four handlers this host answers', () => {
    const deps: ServerDeps = { engine: fakeEngine() };
    const { server, registry } = createServer(deps);
    expect(server).toBeDefined();
    expect(toolList(registry).length).toBeGreaterThan(30);
  });
});


it('refuses executing a described export handler outside request admission', async () => {
  const registry = createRegistry({ engine: fakeEngine() });
  await expect(registry.describe('export.file').run!({ format: 'journal', path: 'model.json' }))
    .rejects.toMatchObject({ code: 'session.expired' });
});
