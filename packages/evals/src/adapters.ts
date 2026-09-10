import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FemError, type ErrorCode, type CommandDef, type QueryDef, type ToolDefinition } from '@femlab/registry';
import type { Provider } from '../../app/src/ai/eval-api';
import { credentialAvailability, type EvalAdapter } from './runner';
import { evaluateCase, type RemoteDefinitionSet, type RemoteEngine } from './remote';
import type { EvalCase, EvalEvidence } from './types';

export interface AdapterOptions {
  provider: Provider;
  credential: string | undefined;
  model: string;
  maxTokens: number;
  maxRounds: number;
  timeoutMs: number;
}

interface BrowserDefinitionSnapshot {
  commands: CommandDef[];
  queries: QueryDef[];
  defs: Record<string, unknown>;
}

class BrowserRemote implements RemoteEngine {
  constructor(private readonly context: BrowserContext, private readonly page: Page) {}

  async definitions(): Promise<RemoteDefinitionSet> {
    return await this.page.evaluate(() => {
      const fem = (window as unknown as { fem: { registry: { list(): BrowserDefinitionSnapshot; defs: Record<string, unknown> } } }).fem;
      const serializable = (definition: CommandDef | QueryDef) => ({
        name: definition.name,
        description: definition.description,
        schema: definition.schema,
        provider: definition.provider,
        tool: definition.tool,
      });
      const listed = fem.registry.list();
      return {
        commands: listed.commands.map((definition) => ({ ...serializable(definition), journaled: definition.journaled })),
        queries: listed.queries.map(serializable),
        defs: fem.registry.defs,
      };
    });
  }

  async invoke(command: string, input: Record<string, unknown>): Promise<unknown> {
    const response = await this.page.evaluate(async ({ command: name, input: args }) => {
      const fem = (window as unknown as { fem: { registry: { query(q: Record<string, unknown>): Promise<unknown> }; dispatch(c: Record<string, unknown>): Promise<unknown> } }).fem;
      try {
        const value = name.startsWith('query.')
          ? await fem.registry.query({ query: name, ...args })
          : await fem.dispatch({ cmd: name, ...args });
        return { ok: true as const, value };
      } catch (error) {
        const row = error as { toJSON?: () => unknown; code?: string; cause?: string; where?: string | null; suggestion?: string | null; message?: string };
        return { ok: false as const, error: row.toJSON?.() ?? { code: row.code ?? 'internal', cause: row.cause ?? row.message ?? String(error), where: row.where ?? null, suggestion: row.suggestion ?? null } };
      }
    }, { command, input });
    if (response.ok) return response.value;
    const error = response.error as { code?: string; cause?: string; where?: string | null; suggestion?: string | null };
    throw new FemError((error.code ?? 'internal') as ErrorCode, error.cause ?? 'browser tool call failed', error.where ?? null, error.suggestion ?? null);
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}

/** The actual app registry and wasm Worker in Chromium, one new page/engine per case. */
export class BrowserEvalAdapter implements EvalAdapter {
  readonly host = 'browser' as const;
  readonly live = true;
  private browser: Browser | null = null;

  constructor(private readonly appUrl: string, private readonly options: AdapterOptions) {}

  async availability(): Promise<{ available: true } | { available: false; reason: string }> {
    return credentialAvailability(this.options.credential);
  }

  async execute(spec: EvalCase): Promise<EvalEvidence> {
    this.browser ??= await chromium.launch({ headless: true });
    const context = await this.browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(this.appUrl);
      await page.waitForFunction(() => {
        const fem = (window as unknown as { fem?: { registry?: unknown } }).fem;
        return fem?.registry !== undefined;
      });
      await page.evaluate(async () => {
        const fem = (window as unknown as { fem: { registry: { query(q: Record<string, unknown>): Promise<unknown> } } }).fem;
        await fem.registry.query({ query: 'query.capabilities' });
      });
      return await evaluateCase(new BrowserRemote(context, page), this.options.provider, this.options.model, spec, this.options);
    } catch (error) {
      await context.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
  }
}

function commandFor(tool: string): string {
  if (tool === 'run_script') return 'script.run';
  if (tool === 'validate_script') return 'query.validateScript';
  const split = tool.indexOf('_');
  return split < 0 ? tool : `${tool.slice(0, split)}.${tool.slice(split + 1)}`;
}

class McpRemote implements RemoteEngine {
  private definitions_: RemoteDefinitionSet | null = null;
  constructor(private readonly client: Client, private readonly transport: StdioClientTransport, private readonly project: string) {}

  async definitions(): Promise<RemoteDefinitionSet> {
    if (this.definitions_ !== null) return this.definitions_;
    const listed = await this.client.listTools();
    const tools: ToolDefinition[] = listed.tools.map((tool) => ({ name: tool.name, description: tool.description ?? '', input_schema: tool.inputSchema as Record<string, unknown> }));
    const commands: CommandDef[] = [];
    const queries: QueryDef[] = [];
    for (const tool of tools) {
      const name = commandFor(tool.name);
      const base = { name, description: tool.description, schema: tool.input_schema, provider: 'engine' as const, tool: true };
      if (name.startsWith('query.')) queries.push(base);
      else commands.push({ ...base, journaled: !name.startsWith('journal.') && name !== 'script.run' && name !== 'export.file' });
    }
    this.definitions_ = { commands, queries, defs: {}, tools };
    return this.definitions_;
  }

  async invoke(command: string, input: Record<string, unknown>): Promise<unknown> {
    const definitions = await this.definitions();
    const tool = definitions.tools!.find((candidate) => commandFor(candidate.name) === command);
    if (tool === undefined) throw new FemError('not-found', `the MCP host has no '${command}' capability`, command);
    const response = await this.client.callTool({ name: tool.name, arguments: input }) as { isError?: boolean; content: { type: string; text?: string }[] };
    const text = response.content.find((part) => part.type === 'text')?.text ?? 'null';
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      value = text;
    }
    if (response.isError !== true) return value;
    const error = value as { code?: string; cause?: string; where?: string | null; suggestion?: string | null };
    throw new FemError((error.code ?? 'internal') as ErrorCode, error.cause ?? text, error.where ?? null, error.suggestion ?? null);
  }

  async close(): Promise<void> {
    try {
      await this.client.close();
    } finally {
      await this.transport.close().catch(() => undefined);
      await rm(this.project, { recursive: true, force: true });
    }
  }
}

/** The packed stdio MCP server, restarted for every case so no Model state crosses attempts. */
export class McpEvalAdapter implements EvalAdapter {
  readonly host = 'mcp' as const;
  readonly live = true;

  constructor(private readonly command: string, private readonly args: string[], private readonly cwd: string, private readonly options: AdapterOptions) {}

  async availability(): Promise<{ available: true } | { available: false; reason: string }> {
    return credentialAvailability(this.options.credential);
  }

  async execute(spec: EvalCase): Promise<EvalEvidence> {
    const project = await mkdtemp(path.join(tmpdir(), `femlab-eval-${spec.id}-`));
    const transport = new StdioClientTransport({ command: this.command, args: [...this.args, '--project', project], cwd: this.cwd, stderr: 'pipe' });
    const client = new Client({ name: 'femlab-assistant-eval', version: '1' });
    try {
      await client.connect(transport);
      return await evaluateCase(new McpRemote(client, transport, project), this.options.provider, this.options.model, spec, this.options);
    } catch (error) {
      await transport.close().catch(() => undefined);
      await rm(project, { recursive: true, force: true });
      throw error;
    }
  }

  async close(): Promise<void> {
    // Each case owns and closes its stdio process in `evaluateCase`.
  }
}
