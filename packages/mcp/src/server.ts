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
  Registry,
  assertInside,
  toToolDefinitions,
  commandNameFor,
  type EngineSchema,
  type EngineTransport,
  type HostContext,
  type HostDef,
} from '@femlab/registry';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import engineSchema from '../../registry/src/generated/engine.schema.json' with { type: 'json' };
import type { EngineHandle } from './engine';
import { runScript } from './script';

export const SCHEMA = engineSchema as unknown as EngineSchema;
export const SERVER_NAME = 'femlab';
export const SERVER_VERSION = '0.1.0';

/** What `export.file` writes: the engine's own formats plus the two reads of the Journal. */
export const EXPORT_FORMATS = ['vtu', 'msh', 'inp', 'stl', 'report', 'script', 'journal'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ServerDeps {
  engine: EngineHandle;
  /** Absolute path of the folder `export.file` may write into; without one it refuses. */
  project?: string | undefined;
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

/**
 * A path inside the project folder, with the directories it needs.
 *
 * `assertInside` refuses `..`, absolute paths and drive letters; the realpath comparison
 * afterwards refuses the one thing a string check cannot see, a symlink that leaves the folder.
 */
export async function resolveInProject(root: string | undefined, p: string): Promise<string> {
  if (root === undefined) {
    throw new FemError('file.scope', 'this server has no project folder', `path '${p}'`, 'start it with --project <dir>');
  }
  const full = path.join(root, ...assertInside(p));
  await mkdir(path.dirname(full), { recursive: true });
  const [realRoot, realDir] = await Promise.all([realpath(root), realpath(path.dirname(full))]);
  if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) {
    throw new FemError('file.scope', 'that path leaves the project folder through a link', `path '${p}'`, 'write inside the project folder');
  }
  return full;
}

/** The text of one export, from the engine or from the Journal. */
export async function exportText(engine: EngineHandle, format: ExportFormat, step?: string): Promise<string> {
  if (format === 'journal') return `${JSON.stringify(engine.modelFile(), null, 2)}\n`;
  if (format === 'script') return ((await engine.query({ query: 'query.script' })) as { text: string }).text;
  const ack = (await engine.dispatch({ cmd: 'mesh.export', format, ...(step === undefined ? {} : { step }) })) as {
    output: { text: string };
  };
  return ack.output.text;
}

/** `export.file`, the one tool that touches the file system; `export_file` to the AI. */
function exportFileCommand(deps: ServerDeps): HostDef {
  return {
    name: 'export.file',
    description:
      'Write one export into the project folder: the mesh (vtu, msh, inp, stl), the Markdown calculation note (report), the Journal as a TypeScript script, or the femlab/1 model file. `path` is relative to the folder the server was started with; paths that leave it are refused. Returns the path written and its size.',
    schema: z.object({ format: z.enum(EXPORT_FORMATS), path: z.string(), step: z.string().optional() }),
    tool: true,
    run: async ({ format, path: rel, step }) => {
      const text = await exportText(deps.engine, format, step);
      const full = await resolveInProject(deps.project, rel);
      await writeFile(full, text);
      return { path: rel, bytes: Buffer.byteLength(text) };
    },
  } as HostDef;
}

/**
 * The registry this host serves: every engine Command and Query over the wasm engine, plus the
 * two host Commands a headless host can honour — `script.run` (the `run_script` tool) and
 * `export.file`. No view, no selection, no panels: this host has no screen to move.
 */
export function createRegistry(deps: ServerDeps): Registry {
  let registry: Registry;
  const host = {
    transport: deps.engine as unknown as EngineTransport,
    script: {
      run: (code: string, timeoutMs?: number) =>
        runScript(
          code,
          (cmd) => registry.dispatch(cmd),
          (q) => registry.query(q),
          timeoutMs,
        ),
    },
  } as unknown as HostContext;
  const script = HOST_COMMANDS.filter((d) => d.name === 'script.run');
  registry = new Registry({ schema: SCHEMA, host, hostCommands: [...script, exportFileCommand(deps)], hostQueries: [] });
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
export function createServer(deps: ServerDeps): { server: Server; registry: Registry } {
  const registry = createRegistry(deps);
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: toolList(registry) }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const value = await callTool(registry, req.params.name, req.params.arguments ?? {});
      return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text' as const, text: errorText(e) }] };
    }
  });
  server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: RESOURCES }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => ({
    contents: [{ uri: req.params.uri, mimeType: 'application/json', text: await readResource(registry, req.params.uri) }],
  }));
  return { server, registry };
}
