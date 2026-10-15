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
export interface HostDef<S extends z.ZodType = z.ZodType, C = HostContext> {
  execution: ExecutionPolicy;
  name: string;
  description: string;
  schema: S;
  tool: boolean;
  run(input: z.output<S>, ctx: C): unknown;
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

/** A real host phase with no engine authority. Definitions use the same validation/router;
 * context contains only that phase's services, never a fabricated HostContext/transport. */
export interface HostOnlyRegistryOptions<C> {
  schema: EngineSchema;
  context: C;
  hostCommands: HostDef<z.ZodType, C>[];
  hostQueries: HostDef<z.ZodType, C>[];
  /** Reject a retained host registry after its owner hands off or is disposed. */
  guard(): void;
  /** Structured readiness failure for an engine operation during this host phase. */
  unavailable(): FemError;
}

/**
 * Engine Commands ∪ host Commands behind one `dispatch`, one `query`, one list. The engine
 * provider is the transport (Rust validates); the host provider is a table of zod-validated
 * functions over `HostContext`. A host Query with an engine Query's name wraps it
 * (`query.capabilities` merges engine and browser facts).
 */
export class Registry<C = HostContext> {
  private readonly commands = new Map<string, CommandDef>();
  private readonly queries = new Map<string, QueryDef>();
  /** The engine's `$defs`, for inlining `$ref`s into self-contained tool schemas. */
  readonly defs: Record<string, unknown>;
  private readonly engine: { transport: EngineTransport } | { unavailable(): FemError };
  private readonly guard: (() => void) | undefined;

  static hostOnly<C>(options: HostOnlyRegistryOptions<C>): Registry<C> { return new Registry<C>(options); }

  constructor(options: RegistryOptions | HostOnlyRegistryOptions<C>) {
    const { schema } = options;
    this.engine = 'host' in options ? { transport: options.host.transport } : { unavailable: options.unavailable };
    this.guard = 'host' in options ? undefined : options.guard;
    this.defs = { ...schema.commands.$defs, ...schema.queries.$defs };
    for (const v of schema.commands.oneOf) {
      const name = v.properties['cmd']!.const!;
      this.commands.set(name, { ...engineDef(name, v), journaled: !name.startsWith('journal.') });
    }
    for (const v of schema.queries.oneOf) {
      const name = v.properties['query']!.const!;
      this.queries.set(name, engineDef(name, v));
    }
    if ('host' in options) {
      const { host, hostCommands = HOST_COMMANDS, hostQueries = HOST_QUERIES } = options;
      for (const d of hostCommands) this.commands.set(d.name, { ...hostDef(d, () => ({ ...host, transport: policyTransport(host.transport, d.execution, d.name) })), journaled: false });
      for (const d of hostQueries) this.queries.set(d.name, hostDef(d, () => ({ ...host, transport: policyTransport(host.transport, d.execution, d.name) })));
    } else {
      for (const d of options.hostCommands) this.commands.set(d.name, { ...hostDef(d, () => { options.guard(); return options.context; }), journaled: false });
      for (const d of options.hostQueries) this.queries.set(d.name, hostDef(d, () => { options.guard(); return options.context; }));
    }
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
    this.guard?.();
    const def = this.commands.get(cmd.cmd);
    if (!def) throw this.unknown(cmd.cmd, 'cmd', this.commands.keys());
    if (def.provider === 'engine') {
      if ('unavailable' in this.engine) throw this.engine.unavailable();
      return this.engine.transport.dispatch(cmd as unknown as Command);
    }
    const { cmd: _, ...input } = cmd;
    return def.run!(input);
  }

  async query(q: { query: string } & Record<string, unknown>): Promise<QueryResult | unknown> {
    this.guard?.();
    const def = this.queries.get(q.query);
    if (!def) throw this.unknown(q.query, 'query', this.queries.keys());
    if (def.provider === 'engine') {
      if ('unavailable' in this.engine) throw this.engine.unavailable();
      return this.engine.transport.query(q as unknown as Query);
    }
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

function hostDef<S extends z.ZodType, C>(d: HostDef<S, C>, context: () => C): QueryDef {
  const { $schema: _, ...schema } = z.toJSONSchema(d.schema);
  const execution = executionPolicy(d.execution, d.name);
  return {
    name: d.name,
    execution,
    description: d.description,
    schema,
    provider: 'host',
    tool: d.tool,
    run: async (input) => {
      const parsed = d.schema.safeParse(input);
      if (!parsed.success) throw schemaError(d.name, parsed.error);
      return d.run(parsed.data, context());
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

/** A handler cannot escalate its declared engine access through HostContext. Bound host
 * services remain injected by the trusted host; they never acquire a different session. */
function policyTransport(transport: EngineTransport, policy: ExecutionPolicy, name: string): EngineTransport {
  const read = ['query', 'surface', 'field', 'exportFile'];
  const allowed: Record<ExecutionPolicy, readonly string[]> = {
    modelRead: read, sessionView: read, modelWrite: [...read, 'dispatch', 'export'],
    replacement: [...read, 'importFile'], workspace: [], producer: [], control: ['cancel'],
  };
  return new Proxy(transport, {
    get(target, key) {
      if (typeof key !== 'string' || !allowed[policy].includes(key)) {
        throw new FemError('schema', `${name}: ${policy} cannot access engine ${String(key)}`, 'execution');
      }
      if (key === 'dispatch') return (command: Command, progress?: Parameters<EngineTransport['dispatch']>[1]) => {
        if (command.cmd === 'model.new') throw new FemError('schema', `${name}: model.new requires replacement ownership`, 'execution');
        return target.dispatch(command, progress);
      };
      const method = target[key as keyof EngineTransport];
      return method.bind(target);
    },
  });
}
