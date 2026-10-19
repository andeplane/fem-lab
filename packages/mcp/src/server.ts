// The MCP server: the registry's own tool definitions, `run_script`, and one file export scoped
// to `--project`. Every tool is a Command or a Query, so what an editor can call here is exactly
// what the app's buttons dispatch and what `femlab run` replays (ADR 0003, plan B §4.4).
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  FemError,
  HOST_COMMANDS,
  HOST_QUERIES,
  boundedModelFileText,
  type ModelFile,
  type ScriptValidator,
  RUN_SCRIPT,
  type ScriptResult,
  Registry,
  toToolDefinitions,
  commandNameFor,
  type EngineSchema,
  type EngineTransport,
  type HostContext,
  type HostDef,
  type AbaqusConversion,
  type AbaqusDependencies,
  type AbaqusIo,
} from '@femlab/registry';
import { z } from 'zod';
import engineSchema from '../../registry/src/generated/engine.schema.json' with { type: 'json' };
import type { EngineHandle, EngineProvider } from './engine';
import { runScript, type ScriptDeps } from './script';
import { nodeScriptValidator } from './script-validation';
import { nodeAbaqusIo } from './abaqus-files';
import { nodeProjectFiles, type ProjectFiles } from './project-files';

export const SCHEMA = engineSchema as unknown as EngineSchema;
export const SERVER_NAME = 'femlab';
export const SERVER_VERSION = '0.1.0';

/** What `export.file` writes: the engine's own formats plus the two reads of the Journal. */
export const EXPORT_FORMATS = ['vtu', 'msh', 'inp', 'stl', 'report', 'script', 'journal'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ServerDeps {
  engine: EngineProvider;
  script?: ScriptDeps;
  validator?: Pick<ScriptValidator, 'validate'>;
  /** Absolute path of the folder `export.file` may write into; without one it refuses. */
  project?: string | undefined;
  /** Optional I/O injection for a scoped host; production binds the configured project folder. */
  abaqusIo?: AbaqusIo;
  /** Retained project capability, injected independently of the engine. */
  projectFiles?: ProjectFiles;
}

/** One MCP tool as the protocol spells it (`inputSchema`, not Anthropic's `input_schema`). */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const RESOURCES = [
  { uri: 'femlab://model', name: 'model', description: 'query.model: the whole Model in one read.', mimeType: 'application/json' },
  { uri: 'femlab://journal', name: 'journal', description: 'query.journal: every applied Command with the Model hash after it.', mimeType: 'application/json' },
  { uri: 'femlab://schema', name: 'schema', description: 'The engine schema document: every Command, Query and response.', mimeType: 'application/json' },
];

/** The text of one export, from the engine or from the Journal. */
export async function exportText(engine: EngineHandle, format: ExportFormat, step?: string): Promise<string> {
  if (format === 'journal') return boundedModelFileText(await engine.modelFile() as ModelFile, true);
  if (format === 'script') return ((await engine.query({ query: 'query.script' })) as { text: string }).text;
  const ack = (await engine.dispatch({ cmd: 'mesh.export', format, ...(step === undefined ? {} : { step }) })) as {
    output: { text: string };
  };
  return ack.output.text;
}

/** `export.file`, the one tool that touches the file system; `export_file` to the AI. */
function exportFileCommand(deps: ScopedDeps): HostDef {
  return {
    name: 'export.file',
    execution: 'modelWrite',
    description:
      'Write one export into the project folder: the mesh (vtu, msh, inp, stl), the Markdown calculation note (report), the Journal as a TypeScript script, or the femlab/1 model file. A model file must fit the 16 MiB UTF-8 limit including pretty formatting and its trailing newline; refusal occurs before any file write. `path` is relative to the folder the server was started with; paths that leave it and final-component symbolic links are refused by a retained directory capability. Absolute symbolic links are refused; relative directory links must remain inside the project. Exports are limited to 64 MiB. Returns the path written and its size.',
    schema: z.object({ format: z.enum(EXPORT_FORMATS), path: z.string(), step: z.string().optional() }),
    tool: true,
    run: async ({ format, path: rel, step }) => {
      const text = await exportText(deps.engine, format, step);
      await deps.projectFiles.write(rel, new TextEncoder().encode(text));
      return { path: rel, bytes: Buffer.byteLength(text) };
    },
  } as HostDef;
}

/**
 * The registry this host serves: every engine Command and Query over the wasm engine, plus the
 * headless host Commands for scripts, catalogue materials, Abaqus import and scoped exports.
 * No view, no selection, no panels: this host has no screen to move.
 */
type ScopedDeps = Omit<ServerDeps, 'engine' | 'projectFiles'> & { engine: EngineHandle; projectFiles: ProjectFiles };

export function createRegistry(input: ServerDeps): Registry {
  const deps = { ...input, projectFiles: input.projectFiles ?? nodeProjectFiles(input.project) };
  // The public registry can describe tools without a lease. Every invocation must acquire
  // one, and nested script calls use the private registry bound to that same request.
  const unavailable = (): never => { throw new FemError('session.expired', 'no request lease'); };
  const registry = scopedRegistry({ ...deps, engine: { dispatch: unavailable, query: unavailable, replaceCommands: unavailable, captureImport: unavailable, modelFile: unavailable, release: unavailable } });
  const request = async <T>(run: (scoped: Registry) => Promise<T>): Promise<T> => {
    await deps.projectFiles.ready();
    const engine = await deps.engine.acquire();
    try { return await run(scopedRegistry({ ...deps, engine })); }
    finally { await engine.release(); }
  };
  registry.dispatch = input => { const command = structuredClone(input); return request(scoped => scoped.dispatch(command)); };
  registry.query = input => { const query = structuredClone(input); return request(scoped => scoped.query(query)); };
  return registry;
}

function scopedRegistry(deps: ScopedDeps): Registry {
  let registry: Registry;
  const validator = deps.validator ?? nodeScriptValidator();
  const abaqus: HostContext['abaqus'] = { capture: () => {
    const engine = deps.engine.captureImport();
    return {
      io: deps.abaqusIo ?? nodeAbaqusIo(deps.project, deps.projectFiles),
      dependencies: async source => await engine.query({ query: 'query.abaqusDependencies', ...source }) as AbaqusDependencies,
      convert: async query => await engine.query(query) as AbaqusConversion,
      replace: commands => engine.replaceCommands(commands),
    };
  } };
  const host = {
    transport: deps.engine as unknown as EngineTransport,
    abaqus,
    script: {
      validate: (code: string, timeoutMs?: number) => validator.validate(code, timeoutMs),
      run: (code: string, timeoutMs?: number) =>
        runScript(
          code,
          (cmd) => registry.dispatch(cmd),
          (q) => registry.query(q),
          timeoutMs,
          deps.script,
        ),
    },
  } as unknown as HostContext;
  const script = HOST_COMMANDS.filter((d) => d.name === 'script.run').map((d) => ({
    ...d,
    description: 'First parse and type-check against the generated fem API with a separate 10000 ms validation deadline; invalid source returns diagnostics without executing. Then run TypeScript against the asynchronous fem API in an isolated QuickJS runtime. Only registry Commands/Queries, console and setTimeout/clearTimeout are available; no Node globals, imports, filesystem or network APIs. File exports use export.file and its host project policy. timeoutMs is greater than 0 and at most 30000 (default 30000), including startup. Timeout terminates the script and refuses further Commands; already admitted Commands may finish and are not rolled back. Nested script.run is refused. Returns { result, console, error? }; Commands enter the Journal like any other.',
  }));
  registry = new Registry({ schema: SCHEMA, host, hostCommands: [...script, ...HOST_COMMANDS.filter(d => d.name === 'file.importAbaqus' || d.name === 'material.addFromLibrary'), exportFileCommand(deps)], hostQueries: HOST_QUERIES.filter((d) => d.name === 'query.validateScript') });
  return registry;
}

/** The tool list, in MCP's spelling. */
export function toolList(registry: Registry): McpTool[] {
  return toToolDefinitions(registry).map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }));
}

/** Run one tool by its MCP name; a Query reads, anything else dispatches. */
export async function callTool(registry: Registry, name: string, args: Record<string, unknown>): Promise<unknown> {
  const command = commandNameFor(name, registry);
  if (command === undefined) {
    throw new FemError('not-found', `no tool named '${name}'`, name, 'list the tools again: the server declares them from the engine schema');
  }
  return command.startsWith('query.') ? registry.query({ query: command, ...args }) : registry.dispatch({ cmd: command, ...args });
}

export async function readResource(registry: Registry, uri: string): Promise<string> {
  if (uri === 'femlab://schema') return JSON.stringify(SCHEMA);
  const known = RESOURCES.map((r) => r.uri);
  if (!known.includes(uri)) {
    throw new FemError('not-found', `no resource at '${uri}'`, uri, `known resources: ${known.join(', ')}`);
  }
  const query = uri === 'femlab://model' ? 'query.model' : 'query.journal';
  return JSON.stringify(await registry.query({ query }), null, 2);
}

/** An error as the text an editor shows: the engine's structured shape wherever there is one. */
export function errorText(e: unknown): string {
  const err = e as { code?: string; cause?: string; where?: string | null; suggestion?: string | null; message?: string };
  const body = err.code === undefined ? { code: 'internal', cause: err.message ?? String(e) } : err;
  return JSON.stringify(body, null, 2);
}

/** The MCP `Server`, with the four handlers this host answers. */
export function createServer(deps: ServerDeps): { server: Server; registry: Registry; ready: Promise<void> } {
  const files = deps.projectFiles ?? nodeProjectFiles(deps.project);
  const registry = createRegistry({ ...deps, projectFiles: files });
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} } },
  );
  const ready = files.ready();
  const connect = server.connect.bind(server);
  // A custom embedded host calling server.connect directly gets the same startup barrier.
  server.connect = async transport => { await ready; await connect(transport); };
  server.onclose = () => files.close();
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: toolList(registry) }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const value = await callTool(registry, req.params.name, req.params.arguments ?? {});
      return { ...(req.params.name === RUN_SCRIPT && (value as ScriptResult)?.error ? { isError: true } : {}), content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text' as const, text: errorText(e) }] };
    }
  });
  server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: RESOURCES }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => ({
    contents: [{ uri: req.params.uri, mimeType: 'application/json', text: await readResource(registry, req.params.uri) }],
  }));
  return { server, registry, ready };
}
