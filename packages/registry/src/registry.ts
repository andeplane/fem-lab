import { z } from 'zod';
import type { Ack, Command, Query, QueryResult, ExecutionPolicy } from './generated/engine';
import { FemError, nearest } from './error';
import type { EngineTransport } from './transport';
import { HOST_COMMANDS, HOST_QUERIES, type HostContext } from './host-commands';

export type Provider = 'engine' | 'host';
export type JsonSchema = Record<string, unknown>;

export interface CommandDef {
  /** `geometry.addBox` */
  name: string;
  /** The AI's tool description. */
  description: string;
  /** Engine: the `oneOf` variant (with `$ref`s into `Registry.defs`); host: `z.toJSONSchema`. */
  schema: JsonSchema;
  provider: Provider;
  /** Required lifetime/execution classification; never inferred from a command name. */
  execution: ExecutionPolicy;
  /** Engine Commands except `journal.*`; host Commands never. */
  journaled: boolean;
  /** Exposed to the AI (false for `ai.setKey` and for `x-status: stub` variants). */
  tool: boolean;
  /** Host Commands only; engine ones go through the transport. Input is zod-validated first. */
  run?: (input: unknown) => Promise<unknown>;
}
export type QueryDef = Omit<CommandDef, 'journaled'>;

/** A host Command or Query as `host-commands.ts` declares it: zod schema in, `HostContext` call out. */
export interface HostDef<S extends z.ZodType = z.ZodType> {
  execution: ExecutionPolicy;
  name: string;
  description: string;
  schema: S;
  tool: boolean;
  run(input: z.output<S>, ctx: HostContext): unknown;
}

interface Variant {
  /** Present on every variant: `crates/femlab/tests/schema_is_current.rs` asserts ≥ 80 characters. */
  description: string;
  properties: Record<string, { const?: string }>;
  required?: string[];
  'x-execution'?: ExecutionPolicy;
  'x-status'?: string;
  'x-returns'?: string;
  [k: string]: unknown;
}
/** The shape of `engine.schema.json` this package reads; the rest is opaque to it. */
export interface EngineSchema {
  schemaVersion: number;
  commands: { oneOf: Variant[]; $defs?: Record<string, unknown> };
  queries: { oneOf: Variant[]; $defs?: Record<string, unknown> };
}

export interface RegistryOptions {
  schema: EngineSchema;
  host: HostContext;
  hostCommands?: HostDef[];
  hostQueries?: HostDef[];
}

/**
 * Engine Commands ∪ host Commands behind one `dispatch`, one `query`, one list. The engine
 * provider is the transport (Rust validates); the host provider is a table of zod-validated
 * functions over `HostContext`. A host Query with an engine Query's name wraps it
 * (`query.capabilities` merges engine and browser facts).
 */
export class Registry {
  private readonly commands = new Map<string, CommandDef>();
  private readonly queries = new Map<string, QueryDef>();
  /** The engine's `$defs`, for inlining `$ref`s into self-contained tool schemas. */
  readonly defs: Record<string, unknown>;
  private readonly transport: EngineTransport;

  constructor({ schema, host, hostCommands = HOST_COMMANDS, hostQueries = HOST_QUERIES }: RegistryOptions) {
    this.transport = host.transport;
    this.defs = { ...schema.commands.$defs, ...schema.queries.$defs };
    for (const v of schema.commands.oneOf) {
      const name = v.properties['cmd']!.const!;
      this.commands.set(name, { ...engineDef(name, v), journaled: !name.startsWith('journal.') });
    }
    for (const v of schema.queries.oneOf) {
      const name = v.properties['query']!.const!;
      this.queries.set(name, engineDef(name, v));
    }
    for (const d of hostCommands) this.commands.set(d.name, { ...hostDef(d, host), journaled: false });
    for (const d of hostQueries) this.queries.set(d.name, hostDef(d, host));
  }

  list(): { commands: CommandDef[]; queries: QueryDef[] } {
    return { commands: [...this.commands.values()], queries: [...this.queries.values()] };
  }

  describe(name: string): CommandDef | QueryDef {
    const def = this.commands.get(name) ?? this.queries.get(name);
    if (!def) throw this.unknown(name, 'name', [...this.commands.keys(), ...this.queries.keys()]);
    return def;
  }

  /** The single entry point for the UI, `window.fem`, the script Worker and the AI. */
  async dispatch(cmd: { cmd: string } & Record<string, unknown>): Promise<Ack | unknown> {
    const def = this.commands.get(cmd.cmd);
    if (!def) throw this.unknown(cmd.cmd, 'cmd', this.commands.keys());
    if (def.provider === 'engine') return this.transport.dispatch(cmd as unknown as Command);
    const { cmd: _, ...input } = cmd;
    return def.run!(input);
  }

  async query(q: { query: string } & Record<string, unknown>): Promise<QueryResult | unknown> {
    const def = this.queries.get(q.query);
    if (!def) throw this.unknown(q.query, 'query', this.queries.keys());
    if (def.provider === 'engine') return this.transport.query(q as unknown as Query);
    const { query: _, ...input } = q;
    return def.run!(input);
  }

  private unknown(name: string, where: string, known: Iterable<string>): FemError {
    return new FemError('not-found', `'${name}' is not a registered Command or Query`, where, `known names: ${nearest(name, known)}`);
  }
}

function engineDef(name: string, v: Variant): QueryDef {
  return { name, execution: executionPolicy(v['x-execution'], name), description: v.description, schema: v, provider: 'engine', tool: v['x-status'] !== 'stub' };
}

function hostDef(d: HostDef, ctx: HostContext): QueryDef {
  const { $schema: _, ...schema } = z.toJSONSchema(d.schema);
  return {
    name: d.name,
    execution: executionPolicy(d.execution, d.name),
    description: d.description,
    schema,
    provider: 'host',
    tool: d.tool,
    run: async (input) => {
      const parsed = d.schema.safeParse(input);
      if (!parsed.success) throw schemaError(d.name, parsed.error);
      return d.run(parsed.data, ctx);
    },
  };
}

/** zod's first issue as the engine's structured error: `where` is the field path. */
function schemaError(name: string, error: z.ZodError): FemError {
  const first = error.issues[0]!;
  const where = first.path.length > 0 ? first.path.join('.') : null;
  return new FemError('schema', `${name}: ${first.message}`, where, `check the parameters of ${name} with describe('${name}') and re-issue it`);
}

/** JS/plugin schema inputs also fail closed; TypeScript alone cannot enforce wire metadata. */
function executionPolicy(value: unknown, name: string): ExecutionPolicy {
  switch (value) {
    case 'modelRead': case 'modelWrite': case 'sessionView': case 'workspace':
    case 'replacement': case 'producer': case 'control': return value;
    default: throw new FemError('schema', `${name}: missing or invalid execution policy`, 'execution');
  }
}
