/** The tracker's pure functions, imported by tutorial-coverage.test.ts; tools/tutorial-coverage.mjs is plain ESM. */
declare module '*/tools/tutorial-coverage.mjs' {
  export interface Tutorial {
    id: number;
    vendor: string;
    title: string;
    url: string;
    status_written: 'can-do' | 'variant' | 'partial' | 'cannot';
    needs: number[];
    note?: string;
  }
  export interface Ranked {
    summary: { total: number; doable: number; partly: number; blocked: number };
    ranked: { issue: number; unlocks: number; tutorials: number }[];
  }
  export const DATA_PATH: string;
  export function readTutorials(file?: string): Tutorial[];
  export function rank(tutorials: { needs: number[] }[], closed: { has(issue: number): boolean }): Ranked;
  export function referencedIssues(tutorials: { needs: number[] }[]): number[];
  export function summaryLine(summary: Ranked['summary']): string;
  export function markdown(report: Ranked): string;
  export function text(report: Ranked): string;
  export function fetchClosed(issues: number[], run: () => string): { closed: Set<number>; warnings: string[] };
  export function main(argv: string[], io?: { log?: (s: string) => void; warn?: (s: string) => void; run?: () => string }): Ranked;
}
