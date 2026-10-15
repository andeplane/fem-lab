// Procedure presentation comes from the engine schema, shared by scripts, AI tools and hosts.
// Filtering changes what the form draws; the full Command remains intact for Apply and Revert.
import type { JsonSchema } from '@femlab/registry';
import schema from '../../../registry/src/generated/runtime-schema';
import { type Defs, type Field, resolve } from './schema';

export interface ProcedureInfo {
  name: string;
  hint: string;
  /** Includes supported optional laws and alternatives, rather than requiring every key. */
  materialProperties: string[];
  materialNeeds: string[];
  results: string[];
}

/** Unknown procedures retain their name and leave unsupported metadata empty. */
export function procedureInfo(name: string, defs: Defs = schema.commands.$defs): ProcedureInfo {
  const procedure = defs['Procedure'] as JsonSchema | undefined;
  const variants = (procedure?.['oneOf'] ?? []) as JsonSchema[];
  const chosen = variants.find((variant) => variant['const'] === name);
  return {
    name,
    hint: String(chosen?.['description'] ?? '').split('\n').join(' '),
    materialProperties: (chosen?.['x-material-properties'] ?? []) as string[],
    materialNeeds: (chosen?.['x-material-needs'] ?? []) as string[],
    results: (chosen?.['x-results'] ?? []) as string[],
  };
}

/** What an engineer needs to supply and what this analysis will produce. */
export function procedureSummary(name: string, defs?: Defs): string {
  const info = procedureInfo(name, defs);
  return [name, ...(info.materialNeeds.length ? [`needs ${info.materialNeeds.join(', ')}`] : []), ...(info.results.length ? [`gives ${info.results.join(', ')}`] : [])].join(' · ');
}

/** Common fields and those of the chosen procedure, in schema order. Unchosen means all. */
export function procedureFields(fields: Field[], variant: JsonSchema, defs: Defs, name: unknown): Field[] {
  const properties = variant['properties'] as Record<string, JsonSchema>;
  const procedure = resolve(properties['procedure']!, defs);
  const variants = (procedure['oneOf'] ?? []) as JsonSchema[];
  if (!variants.some((v) => v['const'] === name)) return fields;
  return fields.filter((field) => {
    const tags = properties[field.path[0]!]!['x-procedures'] as string[] | undefined;
    return tags === undefined || tags.includes('*') || tags.includes(String(name));
  });
}
