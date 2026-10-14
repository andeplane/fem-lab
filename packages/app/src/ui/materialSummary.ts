import type { AxialRow, MaterialRow, Valued } from '@femlab/registry';

export interface MaterialProperty {
  key: string;
  text: string;
}

const quantity = (v: Valued): string => `${Number(v.value.toPrecision(4))} ${v.unit}`;
const axial = (v: AxialRow): string => Array.isArray(v) ? `[${v.map(quantity).join(', ')}]` : quantity(v);

/** Every configured property in a stable order; absent properties never become placeholders. */
export function materialProperties(material: MaterialRow): MaterialProperty[] {
  const parts: MaterialProperty[] = [];
  const add = (key: string, text: string) => parts.push({ key, text });
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
