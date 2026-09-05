// The Tutorial format of PLAN.md 5.10: a Tutorial is data, never code, so a new one is a JSON
// file in `packages/app/tutorials/` and nothing here changes. A Step names one Command, says
// why, and optionally highlights the control that emits it or performs it itself ("do it for
// me"); a step with `expect: null` is read-only explanation that advances on Next alone.

/** What `runner.ts` dispatches for "do it for me" — a Command in the app's own wire shape. */
export type TutorialCommand = { cmd: string } & Record<string, unknown>;

/**
 * What a step is waiting for in the Journal: the newest entry whose Command name is `cmd` and
 * whose fields listed in `match` are equal (`===`) to the entry's. Fields absent from `match`
 * are not compared, so a step can watch `material.add` without caring what E was typed.
 */
export interface StepExpect {
  cmd: string;
  match?: Partial<Record<string, unknown>>;
}

export interface Step {
  title: string;
  /** Markdown-lite: plain text with `` `code` `` spans; rendered as text, not parsed, for now. */
  explain: string;
  /** `null` for a read-only step (Results/Checks explanations): Next always advances it. */
  expect: StepExpect | null;
  /** A `data-cmd` value (preferred) or a raw CSS selector, for the pulsing highlight. */
  highlight?: string;
  /** What "do it for me" dispatches. Omitted on read-only steps. */
  doIt?: TutorialCommand;
  /** KaTeX-ready text (rendered plain for now); typically the closing step of a tutorial. */
  theory?: string;
}

export interface Tutorial {
  id: string;
  title: string;
  minutes: number;
  summary: string;
  steps: Step[];
}
