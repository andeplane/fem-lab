import type { HostDef } from '@femlab/registry';
import { z } from 'zod';
import { panelsReducer, type Store } from '../store';

export const TOUR_DISMISSED_KEY = 'femlab.tour.dismissed';
export const TOUR_STOPS = [
  { title: 'Add geometry', panel: 'tree.geometry', target: '.tree [data-opens="geometry.addBox"]', text: 'Start with a Body. Choose + add body in Geometry and pick box. Fill its dimensions in Properties, check the translucent preview, then choose Add body. Nothing is added until Add body; include units such as mm or m.' },
  { title: 'Define and assign a Material', panel: 'tree.materials', target: '.tree [data-opens="material.add"]', text: 'Add the material properties your analysis needs, then assign that Material to your Body. Creating a Material alone does not assign it. The cantilever tutorial shows both operations.' },
  { title: 'Choose a Mesh', panel: 'tree.mesh', target: '.tree [data-opens="mesh.set"]', text: 'Choose a mesher, element size and order. Start with a modest mesh, inspect its coverage, and refine later to check how the answer changes.' },
  { title: 'Restrain the intended motion', panel: 'tree.constraints', target: '.tree [data-opens="constraint.fix"]', text: 'Add Constraints on named faces or Sets. A static model needs enough support to stop rigid motion. Fix a support face rather than every node of the Body.' },
  { title: 'Apply a Load', panel: 'tree.loads', target: '.tree [data-opens="load.pressure"]', text: 'Choose the load type, target, direction and units. Pressure, total force and gravity describe different inputs. A Load is not active until a Step lists it.' },
  { title: 'Define an analysis Step', panel: 'tree.steps', target: '.tree [data-opens="step.add"]', text: 'Add a Step, choose its procedure, and select the Constraints and Loads to activate. Start with static equilibrium for the cantilever. Read warnings before solving.' },
  { title: 'Solve the Step', target: '.topbar [data-cmd="solve.run"]', text: 'Choose Solve after the required definitions are ready. The solver checks the Model and reports errors with suggested fixes. Solving runs locally and does not require AI or sign-in.' },
  { title: 'Read and check Results', target: '.bottom', text: 'Open Results and Checks. Read units, reactions and displacement values; deformation may be magnified. Compare with a known answer and a finer mesh before trusting a contour.' },
] as const;

export interface TourHost {
  preferences: Pick<Storage, 'getItem' | 'setItem'>;
  openCantilever(): Promise<void>;
}

/** View-only onboarding, using the existing dismissal preference and tutorial runner. */
export function tourCommands(store: Store, host: TourHost): HostDef[] {
  const dismiss = (): void => {
    try { host.preferences.setItem(TOUR_DISMISSED_KEY, '1'); } catch { /* Storage denial does not block local work. */ }
  };
  return [
    {
      name: 'tour.show', execution: 'sessionView', tool: true,
      description: 'Show or revisit one stop of the local modeling tour. Omitted step starts at Geometry. Explicit opens work after dismissal without resetting the saved preference; automatic opens respect it. Expands the relevant Model-tree group. View state only: never creates a Model, runs AI or enters the Journal.',
      schema: z.strictObject({ step: z.number().int().min(0).max(TOUR_STOPS.length - 1).default(0), automatic: z.boolean().default(false) }),
      run: (input) => {
        const { step, automatic } = input as { step: number; automatic: boolean };
        if (automatic) {
          // A tutorial can create the first Model itself. Do not interrupt that workflow.
          if (store.state.panels['tutorial']) return { visible: false };
          try { if (host.preferences.getItem(TOUR_DISMISSED_KEY) === '1') return { visible: false }; } catch { /* Show once in this activation when preferences are unavailable. */ }
        }
        const panels = panelsReducer(store.state.panels, 'tour', true), stop = TOUR_STOPS[step]!;
        if ('panel' in stop) panels[stop.panel] = true;
        store.set({ tourStep: step, panels });
        return { visible: true, step };
      },
    },
    {
      name: 'tour.dismiss', execution: 'sessionView', tool: true,
      description: 'Dismiss the modeling tour and remember that choice in this browser when storage is available. It remains reopenable from Tutorials. Does not change the Model, draft, account or Journal.',
      schema: z.strictObject({}),
      run: () => {
        dismiss();
        store.togglePanel('tour', false);
        return { visible: false };
      },
    },
    {
      name: 'tour.startCantilever', execution: 'sessionView', tool: true,
      description: 'Open the existing local cantilever tutorial at its first step and dismiss the modeling tour. Opening it performs no engineering Command and preserves the current Model. Tutorial Commands run only after an explicit Do it for me action; use a new project to keep an existing Model.',
      schema: z.strictObject({}),
      run: async () => {
        await host.openCantilever();
        dismiss();
        store.set({ tutorialStart: store.state.tutorialStart + 1, panels: panelsReducer(store.state.panels, 'tutorial', true) });
        return { tutorial: 'cantilever' };
      },
    },
  ];
}
