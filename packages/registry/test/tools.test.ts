import { describe, expect, it } from 'vitest';
import schema from '../src/generated/engine.schema.json';
import { Registry, type EngineSchema } from '../src/registry';
import { RUN_SCRIPT, TOOL_NAME, commandNameFor, inlineDefs, stripDiscriminator, toToolDefinitions, toolInputSchema, toolNameFor } from '../src/tools';
import { fakeHost } from './fakes';

const engineSchema = schema as unknown as EngineSchema;
const registry = new Registry({ schema: engineSchema, host: fakeHost() });

const hasRef = (node: unknown): boolean =>
  Array.isArray(node) ? node.some(hasRef) : !!node && typeof node === 'object' && Object.entries(node).some(([k, v]) => k === '$ref' || hasRef(v));

describe('toToolDefinitions', () => {
  const tools = toToolDefinitions(registry);
  const { commands, queries } = registry.list();
  const exposed = [...commands, ...queries].filter((d) => d.tool);

  it('has one tool per exposed Command/Query plus run_script', () => {
    expect(tools).toHaveLength(exposed.length + 1);
    expect(tools.map((t) => t.name).sort()).toEqual([...exposed.map((d) => toolNameFor(d.name)), RUN_SCRIPT].sort());
    expect(tools.find((t) => t.name === 'ai_setKey')).toBeUndefined();
    expect(tools.find((t) => t.name === 'plugin_load')).toBeUndefined();
    expect(tools.find((t) => t.name === 'script_run')).toBeUndefined();
  });

  it('names match the Anthropic rule and round-trip through commandNameFor', () => {
    for (const t of tools) {
      expect(t.name).toMatch(TOOL_NAME);
      expect(t.description.length).toBeGreaterThanOrEqual(80);
      expect(commandNameFor(t.name, registry)).toBeDefined();
    }
    expect(commandNameFor(RUN_SCRIPT, registry)).toBe('script.run');
    expect(commandNameFor('geometry_addBox', registry)).toBe('geometry.addBox');
    expect(commandNameFor('query_model', registry)).toBe('query.model');
    expect(commandNameFor('no_such_tool', registry)).toBeUndefined();
  });

  it('input schemas have no discriminator, and $refs only to carried recursive defs', () => {
    for (const t of tools) {
      expect(t.input_schema['type'], t.name).toBe('object');
      for (const key of ['anyOf', 'oneOf', 'allOf']) expect(t.input_schema, t.name).not.toHaveProperty(key);
      const props = t.input_schema['properties'] as Record<string, unknown> | undefined;
      if (props) {
        expect(props).not.toHaveProperty('cmd');
        expect(props).not.toHaveProperty('query');
      }
      const { $defs, ...rest } = t.input_schema as { $defs?: Record<string, unknown> };
      if ($defs) for (const name of Object.keys($defs)) expect(JSON.stringify(rest) + JSON.stringify($defs)).toContain(`#/$defs/${name}`);
      else expect(hasRef(rest)).toBe(false);
    }
    const addBox = tools.find((t) => t.name === 'geometry_addBox')!;
    expect(addBox.input_schema['required']).toEqual(['name', 'size']);
    // Q_length inlined down to Quantity's anyOf, with the dimension note kept
    const size = (addBox.input_schema['properties'] as Record<string, { items: Record<string, unknown> }>)['size']!;
    expect(size.items).toMatchObject({ 'x-dimension': 'length', anyOf: expect.any(Array) });
    // the CSG tree stays a $ref to a carried def
    const add = tools.find((t) => t.name === 'geometry_add')!;
    expect(add.input_schema['$defs']).toHaveProperty('ShapeSpec');
    expect(tools.find((t) => t.name === 'query_model')!.input_schema).toEqual({ description: expect.any(String), type: 'object', properties: {}, required: [], 'x-returns': 'ModelSummary' });
  });

  it('run_script wraps script.run, and is absent when there is no script.run', () => {
    const run = tools.find((t) => t.name === RUN_SCRIPT)!;
    expect(run.input_schema['required']).toEqual(['code']);
    expect(run.description).toContain('fem.d.ts');
    const bare = new Registry({ schema: engineSchema, host: fakeHost(), hostCommands: [], hostQueries: [] });
    expect(toToolDefinitions(bare).find((t) => t.name === RUN_SCRIPT)).toBeUndefined();
  });
});

describe('inlineDefs / stripDiscriminator', () => {
  it('inlines chains and keeps sibling keywords', () => {
    const defs = { A: { $ref: '#/$defs/B', description: 'an A' }, B: { type: 'string' } };
    expect(inlineDefs({ properties: { x: { $ref: '#/$defs/A' } } }, defs)).toEqual({ properties: { x: { type: 'string', description: 'an A' } } });
  });
  it('carries recursive defs, including ones only reachable from a carried def', () => {
    const defs = { Tree: { anyOf: [{ type: 'number' }, { type: 'array', items: { $ref: '#/$defs/Tree' } }, { $ref: '#/$defs/Leaf' }] }, Leaf: { $ref: '#/$defs/Colour' }, Colour: { type: 'string' } };
    const out = inlineDefs({ properties: { t: { $ref: '#/$defs/Tree' } } }, defs);
    expect(out['$defs']).toEqual({ Tree: { anyOf: [{ type: 'number' }, { type: 'array', items: { $ref: '#/$defs/Tree' } }, { type: 'string' }] } });
  });
  it('handles diamonds without looping and dangling refs without throwing', () => {
    const diamond = { A: { anyOf: [{ $ref: '#/$defs/B' }, { $ref: '#/$defs/C' }] }, B: { $ref: '#/$defs/D' }, C: { $ref: '#/$defs/D' }, D: { type: 'string' } };
    expect(inlineDefs({ $ref: '#/$defs/A' }, diamond)).toEqual({ anyOf: [{ type: 'string' }, { type: 'string' }] });
    expect(inlineDefs({ $ref: '#/$defs/A' }, { A: { $ref: '#/$defs/Missing' } })).toEqual({});
  });
  it('detects mutual recursion (a cycle longer than one hop) and carries both defs', () => {
    const mutual = { A: { type: 'array', items: { $ref: '#/$defs/B' } }, B: { anyOf: [{ type: 'number' }, { $ref: '#/$defs/A' }] } };
    expect(inlineDefs({ properties: { a: { $ref: '#/$defs/A' } } }, mutual)).toEqual({ properties: { a: { $ref: '#/$defs/A' } }, $defs: mutual });
  });
  it('strips cmd and query and tolerates a schema without properties', () => {
    expect(stripDiscriminator({ type: 'object', properties: { cmd: { const: 'a.b' }, n: { type: 'number' } }, required: ['cmd', 'n'] })).toEqual({ type: 'object', properties: { n: { type: 'number' } }, required: ['n'] });
    expect(stripDiscriminator({ anyOf: [] })).toEqual({ anyOf: [], properties: {}, required: [] });
  });
});


describe('provider object unions', () => {
  it('exports every field choice and keeps the original runtime validation', async () => {
    const field = toToolDefinitions(registry).find((t) => t.name === 'view_showField')!.input_schema;
    expect(field).toEqual({ type: 'object', properties: {
      field: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      component: expect.objectContaining({ type: 'integer' }), step: { type: 'string' },
    }, required: ['field'] });
    await registry.dispatch({ cmd: 'view.showField', field: null });
    await registry.dispatch({ cmd: 'view.showField', field: 'displacement', component: 2, step: 'static' });
    await expect(registry.dispatch({ cmd: 'view.showField', field: 123 })).rejects.toMatchObject({ code: 'schema' });
  });

  it('projects oneOf branches, removes discriminators and deduplicates shared types', () => {
    expect(toolInputSchema({ description: 'choice', oneOf: [
      { type: 'object', properties: { cmd: { const: 'x' }, common: { type: 'string' }, a: { type: 'number' } }, required: ['cmd', 'common', 'a'] },
      { type: 'object', properties: { cmd: { const: 'x' }, common: { type: 'string' }, b: { type: 'boolean' } }, required: ['cmd', 'common'] },
    ] })).toEqual({ description: 'choice', type: 'object', properties: {
      common: { type: 'string' }, a: { type: 'number' }, b: { type: 'boolean' },
    }, required: ['common'] });
  });
});
