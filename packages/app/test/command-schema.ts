// Independent JSON Schema oracle: never use the form renderer's fieldsOf/default helpers.
import { Ajv2020 } from 'ajv/dist/2020.js';
import schema from '../../registry/src/generated/engine.schema.json';
import type { JsonSchema } from '@femlab/registry';

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
export const validCommand = ajv.compile(schema.commands);

/** A minimal structural witness for every variant, derived from the registry contract. */
export function exampleFor(node: JsonSchema, defs = schema.commands.$defs as Record<string, JsonSchema>): unknown {
  if (typeof node['$ref'] === 'string') return exampleFor(defs[node['$ref'].split('/').at(-1)!]!, defs);
  if ('const' in node) return node['const'];
  if (Array.isArray(node['enum'])) return node['enum'][0];
  const alternatives = node['oneOf'] ?? node['anyOf'];
  if (Array.isArray(alternatives)) return exampleFor(alternatives.find(v => v.type !== 'null') ?? alternatives[0], defs);
  const type = Array.isArray(node['type']) ? node['type'].find(v => v !== 'null') : node['type'];
  if (type === 'object' || node['properties']) {
    const properties = (node['properties'] ?? {}) as Record<string, JsonSchema>;
    return Object.fromEntries(((node['required'] ?? []) as string[]).map(key => [key, exampleFor(properties[key]!, defs)]));
  }
  if (type === 'array') {
    const tuple = node['prefixItems'];
    if (Array.isArray(tuple)) return tuple.map(v => exampleFor(v, defs));
    return Array.from({ length: Number(node['minItems'] ?? 0) }, () => exampleFor(node['items'] as JsonSchema, defs));
  }
  if (type === 'number' || type === 'integer') return Number(node['minimum'] ?? node['exclusiveMinimum'] ?? 0) + 1;
  if (type === 'boolean') return true;
  if (type === 'string') return 'example';
  if (type === 'null') return null;
  return {};
}
