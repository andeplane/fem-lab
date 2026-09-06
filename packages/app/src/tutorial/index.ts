// The tutorial system's public surface (PLAN.md 5.10). The coordinator mounts it with one line:
//
//   import { TutorialPanel, Tour } from './tutorial';
//   …
//   <TutorialPanel registry={registry} store={store} />
//   <Tour store={store} />
//
// in `App.tsx` (or `main.tsx`, alongside the other overlays) — nothing else in this module
// reaches into `src/ui/**` or `src/ai/**`.
export { TutorialPanel } from './TutorialPanel';
export { Tour } from './Tour';
export { TutorialRunner, matches, parseTutorialHash, savedStep, tutorialHash, type RunnerDeps } from './runner';
export { candidates, fieldsOf, formHintsOf, nameOf, overlaps, place, rectOf, resolve, type Box, type Placement } from './target';
export { TUTORIALS, tutorialById } from './tutorials';
export type { Step, StepExpect, Tutorial, TutorialCommand } from './types';
