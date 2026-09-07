// The built-in tutorials (PLAN.md 5.10). Each is data (`packages/app/tutorials/*.json`); adding
// one is adding a file here, not writing a component. Vite bundles JSON imports directly, so
// there is no fetch and no build step, unlike the Examples gallery's Journals.
import cantilever from '../../tutorials/cantilever.json';
import heatConduction from '../../tutorials/heat-conduction.json';
import journalAsProgram from '../../tutorials/journal-as-program.json';
import meshConvergence from '../../tutorials/mesh-convergence.json';
import modalAnalysis from '../../tutorials/modal-analysis.json';
import plateWithHole from '../../tutorials/plate-with-hole.json';
import pressureVessel from '../../tutorials/pressure-vessel.json';
import readAResult from '../../tutorials/read-a-result.json';
import symmetryAnd2d from '../../tutorials/symmetry-and-2d.json';
import thermalBar from '../../tutorials/thermal-bar.json';
import thermalStressChaining from '../../tutorials/thermal-stress-chaining.json';
import transientHeat from '../../tutorials/transient-heat.json';
import type { Tutorial } from './types';

// Roughly in the order someone would work through them: build a model, read it, then the
// procedures, then the ones that are about method rather than physics.
export const TUTORIALS: Tutorial[] = [
  cantilever,
  plateWithHole,
  thermalBar,
  readAResult,
  heatConduction,
  modalAnalysis,
  transientHeat,
  meshConvergence,
  symmetryAnd2d,
  journalAsProgram,
  thermalStressChaining,
  pressureVessel,
] as Tutorial[];

export function tutorialById(id: string): Tutorial | undefined {
  return TUTORIALS.find((t) => t.id === id);
}
