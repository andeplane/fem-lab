import type { AxialRow, MaterialRow, ModelSummary, Valued } from '@femlab/registry';
import { procedureInfo } from './procedures';

export interface MaterialProperty {
  key: string;
  text: string;
  usedBy: string[];
}

const quantity = (v: Valued): string => `${Number(v.value.toPrecision(4))} ${v.unit}`;
const axial = (v: AxialRow): string => Array.isArray(v) ? `[${v.map(quantity).join(', ')}]` : quantity(v);

/** Every configured property in a stable order; absent properties never become placeholders. */
export function materialProperties(material: MaterialRow, model?: ModelSummary): MaterialProperty[] {
  const usage = material.assignedTo.length === 0 ? [] : (model?.steps ?? []).map((step) => {
    const info = procedureInfo(step.procedure);
    const properties = new Set(info.materialProperties);
    // E/G/nu inside an orthotropic block are stiffness properties; heat only reads its k.
    if (properties.has('E')) {
      for (const key of ['E1', 'E2', 'E3', 'G12', 'G13', 'G23', 'nu12', 'nu13', 'nu23']) properties.add(key);
      const activeLoads = model!.loads.filter((load) => step.loads.includes(load.name));
      if (activeLoads.some((load) => load.kind === 'gravity')) properties.add('rho');
    }
    if (properties.has('alpha')) {
      const activeTemperature = model!.loads.some((load) => load.kind === 'temperature' && step.loads.includes(load.name));
      const predecessor = model!.steps.find((previous) => previous.name === step.after);
      const heatPredecessor = predecessor && procedureInfo(predecessor.procedure).materialProperties.includes('k');
      if (!activeTemperature && !heatPredecessor) properties.delete('alpha');
    }
    if ((properties.has('E') && material.orthotropic) || (properties.has('k') && Array.isArray(material.k)) || (properties.has('alpha') && Array.isArray(material.alpha))) properties.add('orientation');
    if (!material.plasticity) { properties.delete('yield'); properties.delete('plasticity'); }
    return { name: step.name, properties };
  });
  const parts: MaterialProperty[] = [];
  const add = (key: string, text: string) => parts.push({ key, text, usedBy: usage.filter((step) => step.properties.has(key)).map((step) => step.name) });
  if (material.E) add('E', `E ${quantity(material.E)}`);
  if (material.nu != null) add('nu', `ν ${material.nu}`);
  if (material.orthotropic) {
    for (const key of ['E1', 'E2', 'E3', 'G12', 'G13', 'G23'] as const) add(key, `${key} ${quantity(material.orthotropic[key])}`);
    for (const key of ['nu12', 'nu13', 'nu23'] as const) add(key, `${key.replace('nu', 'ν')} ${material.orthotropic[key]}`);
  }
  if (material.orientation) add('orientation', `axes ${Number(material.orientation.degrees.toPrecision(4))}°`);
  if (material.rho) add('rho', `ρ ${quantity(material.rho)}`);
  if (material.alpha) add('alpha', `α ${axial(material.alpha)}`);
  if (material.k) add('k', `k ${axial(material.k)}`);
  if (material.cp) add('cp', `cp ${quantity(material.cp)}`);
  if (material.yield) add('yield', `yield ${quantity(material.yield)}`);
  if (material.plasticity) add('plasticity', 'plasticity');
  if (material.source) add('source', `source ${material.source}`);
  return parts;
}

/** Picker hints describe thermal-only materials without requiring a stiffness property. */
export function materialPickerSummary(material: MaterialRow): string {
  if (material.E) return `E ${quantity(material.E)}`;
  if (material.orthotropic) return `E1 ${quantity(material.orthotropic.E1)}`;
  if (material.k) return `k ${axial(material.k)}`;
  if (material.rho) return `ρ ${quantity(material.rho)}`;
  return 'no properties';
}
