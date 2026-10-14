// Conditional presentation of one Material Command, driven by its schema metadata. Hidden
// values remain in the form's full argument object and are submitted unchanged.
import type { JsonSchema, ModelSummary } from '@femlab/registry';
import { MATERIAL_PHYSICS, type MaterialPhysics, type Defs, type Field, getAt, resolve } from './schema';

/** Physics selected by the Model's Steps and by properties already present in the definition. */
export function materialPhysicsFor(model: ModelSummary | null, values: Record<string, unknown>, fields: Field[], defs: Defs): MaterialPhysics[] {
  const selected = new Set<MaterialPhysics>();
  const procedure = resolve((defs['Procedure'] ?? {}) as JsonSchema, defs);
  const variants = (procedure['oneOf'] ?? []) as JsonSchema[];
  const steps = model?.steps ?? [];
  const loads = model?.loads ?? [];
  for (const step of steps) {
    const metadata = variants.find(v => v['const'] === step.procedure);
    const stepPhysics = (metadata?.['x-material-physics'] ?? []) as MaterialPhysics[];
    for (const tag of stepPhysics) selected.add(tag);
    const predecessor = 'after' in step ? steps.find(source => source.name === step.after) : undefined;
    if (stepPhysics.includes('stiffness') && (predecessor?.procedure === 'heat-steady' || predecessor?.procedure === 'heat-transient')) selected.add('expansion');
    // Only active Loads affect a Step; an unused gravity/temperature definition does not.
    for (const load of loads) {
      if (!step.loads.includes(load.name)) continue;
      if (load.kind === 'gravity') selected.add('mass');
      if (load.kind === 'temperature') selected.add('expansion');
    }
  }
  const existing = (list: Field[]): void => {
    for (const field of list) {
      const value = getAt(values, field.path);
      if (value !== undefined && value !== null && value !== '' && field.physics && field.physics !== 'common') selected.add(field.physics);
      if (field.kind === 'object') existing(field.fields);
    }
  };
  existing(fields);
  if (selected.size === 0) selected.add('stiffness');
  return [...selected].filter(tag => MATERIAL_PHYSICS.includes(tag));
}

/** A selected group keeps required child fields visible: an Orthotropic block needs its nine
 * stiffness values even when the person is adding directional conductivity for heat. */
export function materialFieldsFor(fields: Field[], selected: readonly MaterialPhysics[], nested = false): Field[] {
  const visible = fields
    .filter(field => !field.physics || field.physics === 'common' || selected.includes(field.physics) || nested && field.required)
    .map(field => field.kind === 'object' ? { ...field, fields: materialFieldsFor(field.fields, selected, true) } : field);
  if (nested) return visible;
  const grouped = visible.filter(field => field.physics && field.physics !== 'common')
    .sort((a, b) => selected.indexOf(a.physics as MaterialPhysics) - selected.indexOf(b.physics as MaterialPhysics));
  let next = 0;
  return visible.map(field => field.physics && field.physics !== 'common' ? grouped[next++]! : field);
}
