import type { JsonSchema, Registry } from './registry';

/** Anthropic's `Tool` shape; the SDK type is structurally identical, so no SDK dependency here. */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

/** Anthropic's tool-name rule. */
export const TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;
/** `script.run` is exposed under the name Anthropic's guidance and PLAN 4.2 use. */
export const RUN_SCRIPT = 'run_script';

export function toolNameFor(cmd: string): string {
  return cmd === 'script.run' ? RUN_SCRIPT : cmd === 'query.validateScript' ? 'validate_script' : cmd.replace(/\./g, '_');
}

/** Reverse lookup in the registry, not string replacement (a name could contain `_`). */
export function commandNameFor(tool: string, registry: Registry): string | undefined {
  const { commands, queries } = registry.list();
  return [...commands, ...queries].find((d) => toolNameFor(d.name) === tool)?.name;
}

const refName = (ref: string) => ref.slice('#/$defs/'.length);

/** Defs that can reach themselves (`ShapeSpec` is a CSG tree) cannot be inlined finitely. */
function recursiveDefs(defs: Record<string, unknown>): Set<string> {
  const edges = new Map<string, Set<string>>();
  const collect = (node: unknown, acc: Set<string>): Set<string> => {
    if (Array.isArray(node)) node.forEach((n) => collect(n, acc));
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === '$ref' && typeof v === 'string') acc.add(refName(v));
        else collect(v, acc);
      }
    }
    return acc;
  };
  for (const [name, def] of Object.entries(defs)) edges.set(name, collect(def, new Set()));
  const reaches = (from: string, target: string, seen: Set<string>): boolean => {
    for (const next of edges.get(from) ?? []) {
      if (next === target) return true;
      if (!seen.has(next)) {
        seen.add(next);
        if (reaches(next, target, seen)) return true;
      }
    }
    return false;
  };
  return new Set([...edges.keys()].filter((n) => reaches(n, n, new Set())));
}

/**
 * Make a schema self-contained: every `$ref` to a non-recursive def is replaced by the def's
 * body (sibling keywords such as `description` kept); recursive defs stay as `$ref`s and are
 * carried along in a minimal `$defs`, which is still one self-contained JSON Schema.
 */
export function inlineDefs(schema: JsonSchema, defs: Record<string, unknown>): JsonSchema {
  const recursive = recursiveDefs(defs);
  const needed = new Set<string>();
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const { $ref, ...rest } = node as { $ref?: string } & Record<string, unknown>;
    const walked = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, walk(v)]));
    if (typeof $ref !== 'string') return walked;
    const name = refName($ref);
    if (recursive.has(name)) {
      needed.add(name);
      return { $ref, ...walked };
    }
    return { ...(walk(defs[name]) as JsonSchema), ...walked };
  };
  const out = walk(schema) as JsonSchema;
  const carried: Record<string, unknown> = {};
  for (const name of needed) carried[name] = walk(defs[name]); // may grow `needed`; Set iteration sees additions
  return needed.size > 0 ? { ...out, $defs: carried } : out;
}

/** Drop the `cmd`/`query` discriminator: the tool name carries it. */
export function stripDiscriminator(schema: JsonSchema): JsonSchema {
  const { properties = {}, required = [], ...rest } = schema as { properties?: Record<string, unknown>; required?: string[] };
  const { cmd: _c, query: _q, ...props } = properties;
  return { ...rest, properties: props, required: required.filter((r) => r !== 'cmd' && r !== 'query') };
}

/**
 * Providers require an object root and Anthropic rejects root combinators. Project an object
 * union onto its properties: shared required fields stay required, branch-only fields become
 * optional, and differing property types become nested unions. The registry still validates
 * branch relationships against the original schema before dispatching a call.
 */
export function toolInputSchema(schema: JsonSchema): JsonSchema {
  const { anyOf, oneOf, ...rest } = schema;
  const variants = (anyOf ?? oneOf) as JsonSchema[] | undefined;
  if (!variants) return stripDiscriminator(schema);
  const branches = variants.map(toolInputSchema);
  const properties: Record<string, unknown> = {};
  const names = new Set(branches.flatMap((b) => Object.keys(b['properties'] as object)));
  for (const name of names) {
    const choices = branches.map((b) => (b['properties'] as Record<string, unknown>)[name]).filter((v) => v !== undefined);
    const unique = [...new Map(choices.map((v) => [JSON.stringify(v), v])).values()];
    properties[name] = unique.length === 1 ? unique[0] : { anyOf: unique };
  }
  const required = [...names].filter((name) => branches.every((b) => (b['required'] as string[]).includes(name)));
  return { ...rest, type: 'object', properties, required };
}

/** The AI's tool list: every `tool: true` Command and Query, plus `run_script` for `script.run`. */
export function toToolDefinitions(registry: Registry): ToolDefinition[] {
  const { commands, queries } = registry.list();
  const script = commands.find((d) => d.name === 'script.run');
  return [...commands, ...queries]
    .filter((d) => d.tool)
    .map((d) => ({ name: toolNameFor(d.name), description: d.description, input_schema: toolInputSchema(inlineDefs(d.schema, registry.defs)) }))
    .concat(script ? [{ name: RUN_SCRIPT, description: script.description, input_schema: script.schema }] : []);
}
