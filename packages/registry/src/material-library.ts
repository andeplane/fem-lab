import { FemError } from './error';
import type { Command, MaterialLibrary } from './generated/engine';
import type { EngineTransport } from './transport';

/** Copy the selected entry as a whole; the current Step must not discard unused data. */
export async function addLibraryMaterial(transport: EngineTransport, entry: string, name: string): Promise<unknown> {
  const library = await transport.query({ query: 'query.materialLibrary', name: entry }) as MaterialLibrary;
  if (library.entries.length !== 1)
    throw new FemError('not-found', 'select exactly one material catalogue entry', 'entry', 'query.materialLibrary with a canonical entry id');
  const selected = library.entries[0]!;
  const command: Extract<Command, { cmd: 'material.add' }> = { cmd: 'material.add', name, source: selected.materialAddSource };
  for (const property of ['E', 'rho', 'alpha', 'k', 'cp', 'yield'] as const) {
    const reported = selected[property];
    if (reported != null) {
      const value = reported.value;
      command[property] = typeof value === 'string' ? value : `${value.value} ${value.unit}`;
    }
  }
  if (selected.nu != null) {
    const value = selected.nu.value;
    // The built-in catalogue emits dimensionless ratios in explicit unit-1 parts.
    // Refuse another representation rather than stripping or guessing a unit factor.
    if (typeof value === 'string' || value.unit !== '1')
      throw new FemError('schema', 'catalogue Poisson ratio must be reported in unit 1', 'nu', 'query.materialLibrary with a supported built-in entry');
    command.nu = value.value;
  }
  return transport.dispatch(command);
}
