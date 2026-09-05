// The built-in tutorials (PLAN.md 5.10). Each is data (`packages/app/tutorials/*.json`); adding
// one is adding a file here, not writing a component. Vite bundles JSON imports directly, so
// there is no fetch and no build step, unlike the Examples gallery's Journals.
import cantilever from '../../tutorials/cantilever.json';
import plateWithHole from '../../tutorials/plate-with-hole.json';
import readAResult from '../../tutorials/read-a-result.json';
import thermalBar from '../../tutorials/thermal-bar.json';
import type { Tutorial } from './types';

export const TUTORIALS: Tutorial[] = [cantilever, plateWithHole, thermalBar, readAResult] as Tutorial[];

export function tutorialById(id: string): Tutorial | undefined {
  return TUTORIALS.find((t) => t.id === id);
}
