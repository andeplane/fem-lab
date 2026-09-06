// The Properties panel is generated from `engine.schema.json`, so the only honest test of it is
// every Command in that schema. Each one is mounted, twice: empty, and pre-filled with a value
// of the wrong shape for every field — a form that throws on a half-typed argument is a form a
// person meets while typing. Any console error, any thrown render, and this fails.
import type { EngineSchema, JsonSchema } from '@femlab/registry';
import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../registry/src/generated/engine.schema.json';
import { Store } from '../src/store';
import { SchemaForm } from '../src/ui/SchemaForm';
import { fieldsOf, type Defs, type Field } from '../src/ui/schema';

const doc = schema as unknown as EngineSchema;
const DEFS: Defs = { ...doc.commands.$defs, ...doc.queries.$defs };
const VARIANTS = new Map<string, JsonSchema>(doc.commands.oneOf.map((v) => [v.properties['cmd']!.const!, v as unknown as JsonSchema]));
const NAMES = [...VARIANTS.keys()];

const query = async () => ({ value: 1, unit: 'Pa' });

/** One value per field that is *not* what the field wants: the state mid-edit, or from a script. */
function wrongValues(fields: Field[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f.path[0]!] = f.kind === 'quantity' ? 'not a number' : f.kind === 'number' ? 'seven' : f.kind === 'enum' ? 42 : { unexpected: 'object' };
  return out;
}

function mount(cmd: string, values: Record<string, unknown>): HTMLElement {
  const store = new Store();
  store.openForm(cmd, values);
  const root = document.createElement('div');
  document.body.append(root);
  render(<SchemaForm s={store.state} store={store} dispatch={async () => undefined} query={query} defs={DEFS} variants={VARIANTS} />, root);
  return root;
}

describe('the generated Properties form, for every Command in the schema', () => {
  let errors: string[];
  beforeEach(() => {
    document.body.innerHTML = '';
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(' ')));
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(' ')));
  });
  afterEach(() => vi.restoreAllMocks());

  it('covers every Command the registry declares, so this list cannot go stale', () => {
    expect(NAMES.length).toBeGreaterThan(30);
    expect(NAMES).toContain('geometry.addBox');
    expect(NAMES).toContain('solve.run');
    expect(NAMES).toContain('study.converge');
  });

  it.each(NAMES)('renders %s with no arguments, and with the wrong ones', (cmd) => {
    const empty = mount(cmd, {});
    // The header names the Command, and the footer says what Apply will record.
    expect(empty.querySelector('.panel-sub')!.textContent).toBe(cmd);
    expect(empty.querySelector('.recorded-cmd')!.textContent).toContain(`fem.${cmd.split('.')[0]}.${cmd.split('.')[1]}(`);
    // Every required field is on screen; optional ones say so.
    const fields = fieldsOf(VARIANTS.get(cmd)!, DEFS);
    const drawn = [...empty.querySelectorAll('.props-body > .field')].map((e) => e.getAttribute('data-field'));
    // Derive the expected properties directly from the source schema, independently
    // of fieldsOf, so a dropped required field cannot validate its own omission.
    const properties = VARIANTS.get(cmd)!['properties'] as Record<string, JsonSchema>;
    expect(drawn).toEqual(Object.entries(properties)
      .filter(([name, property]) => !(['cmd', 'query', 'kind'].includes(name) && property['const'] !== undefined))
      .map(([name]) => name));

    document.body.innerHTML = '';
    const wrong = mount(cmd, wrongValues(fields));
    expect(wrong.querySelector('.apply')).not.toBeNull();
    expect(errors).toEqual([]);
  });

  it('puts a data-cmd on every control of every form, so ADR 0003 holds field by field', () => {
    for (const cmd of NAMES) {
      document.body.innerHTML = '';
      const root = mount(cmd, {});
      const bare = [...root.querySelectorAll('button, input, textarea')].filter((e) => !e.hasAttribute('data-cmd'));
      expect(bare.map((e) => e.outerHTML.slice(0, 80)), cmd).toEqual([]);
    }
  });

  it('labels every field and tags its dimension, so nothing is an unexplained box', () => {
    for (const cmd of NAMES) {
      document.body.innerHTML = '';
      const root = mount(cmd, {});
      for (const head of root.querySelectorAll('.field-head')) {
        expect(head.querySelector('.field-label')!.textContent!.trim().length, cmd).toBeGreaterThan(0);
        expect(head.querySelector('.field-dim')!.textContent!.trim().length, cmd).toBeGreaterThan(0);
      }
    }
  });
});
