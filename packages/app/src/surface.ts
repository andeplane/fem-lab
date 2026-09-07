import type { Surface } from '@femlab/registry';
/** Immutable rendered input, tagged as geometry or a built mesh. */
export interface AppSurface extends Surface { source: 'mesh' | 'geometry' }
