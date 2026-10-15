import { z } from 'zod';
import type { DifferenceCoverage, EngineError, ResultSummary, RetainedResults, Valued, Warning } from './generated/engine';

/** A comparison identifies immutable solves; Step names cannot identify repeated solves. */
export const ComparisonOperand = z.object({
  resultId: z.string().min(1).describe('Immutable solve id from query.results, scoped to the current project engine.'),
  field: z.string().min(1).describe('Retained engine field name from query.result for this id, such as displacement, vonMises, or temperature.'),
  component: z.number().int().nonnegative().optional().describe('Zero-based component. Omit for a scalar, or to show a displacement/mode vector magnitude.'),
});
export const ComparisonConfig = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('single').describe('Restore the existing single-Result view.') }),
  z.object({
    mode: z.literal('sideBySide').describe('Draw two retained surfaces with independent fields and legends, sharing one world camera.'),
    left: ComparisonOperand.describe('Left pane solve and field.'),
    right: ComparisonOperand.describe('Right pane solve and field.'),
  }),
  z.object({
    mode: z.literal('difference').describe('Draw the engine-computed left minus right field; unavailable nodes are explicitly missing.'),
    left: ComparisonOperand.describe('The minuend: left retained solve and field.'),
    right: ComparisonOperand.describe('The subtrahend: right retained solve and field.'),
    onto: z.enum(['left', 'right']).describe('Explicit retained target Mesh for interpolation and rendering.'),
  }),
]);
export const ComparisonPane = z.enum(['left', 'right', 'difference']);
/** Unit parsing and dimensions are authoritative engine conversions, not host arithmetic. */
export const ComparisonQuantity = z.object({
  value: z.number().describe('Finite physical value in the accompanying unit.'),
  unit: z.string().describe('Physical unit, such as m, mm, MPa, K, or degC; empty means dimensionless.'),
});
const Target = z.object({
  pane: ComparisonPane.describe('Explicit comparison presentation to change.'),
  resultId: z.string().min(1).describe('Id currently rendered in this pane; a mismatch refuses an obsolete UI action.'),
});
export const ComparisonLegendInput = Target.extend({
  colormap: z.enum(['viridis', 'turbo', 'rainbow']).optional().describe('This pane’s color map, independent of the other pane.'),
  range: z.union([z.literal('auto'), z.tuple([ComparisonQuantity, ComparisonQuantity])]).optional()
    .describe('Automatic data bounds, or physical lower/upper bounds. In difference mode these are difference amounts; conversion removes temperature origin offsets.'),
});
export const ComparisonVisibilityInput = Target.extend({
  bodies: z.array(z.string().min(1)).describe('Body names from this retained pane, never implicit current-Model targets.'),
  on: z.boolean().describe('Show these bodies when true; otherwise hide only in this pane.'),
});
export const ComparisonPickInput = Target.extend({
  at: z.tuple([ComparisonQuantity, ComparisonQuantity, ComparisonQuantity])
    .describe('World-space point with length units; select the nearest visible retained surface entity and show its engine field value.'),
  body: z.string().optional().describe('Optional retained Body name to restrict the pick.'),
  face: z.string().optional().describe('Optional retained face or Set name to restrict the pick.'),
});

export type ComparisonConfiguration = z.output<typeof ComparisonConfig>;
export type ComparisonOperandInput = z.output<typeof ComparisonOperand>;
export type ComparisonPaneName = z.output<typeof ComparisonPane>;
export type ComparisonLegendSpec = z.output<typeof ComparisonLegendInput>;
export type ComparisonVisibilitySpec = z.output<typeof ComparisonVisibilityInput>;
export type ComparisonPickSpec = z.output<typeof ComparisonPickInput>;

export interface ComparisonLegendState {
  min: Valued;
  max: Valued;
  colormap: 'viridis' | 'turbo' | 'rainbow';
  automatic: boolean;
  /** Values are differences, not absolute temperatures; the UI labels delta units. */
  difference: boolean;
}
export interface ComparisonPick {
  resultId: string;
  pane: ComparisonPaneName;
  field: string;
  component: number | null;
  at: [Valued, Valued, Valued];
  body: string | null;
  face: string | null;
  /** Read-only diagnostic identity, not an editable Model selector. */
  node: number;
  /** Exact engine field value in SI; null means unavailable difference coverage. */
  value: Valued | null;
  difference: boolean;
}
export interface ComparisonPaneState {
  operand: ComparisonOperandInput;
  summary: ResultSummary;
  label: string;
  legend: ComparisonLegendState | null;
  bodyNames: string[];
  hiddenBodies: string[];
  /** The selected retained payload contains a displacement/mode field usable for deformation. */
  canDeform: boolean;
  pick: ComparisonPick | null;
  error: EngineError | null;
}
/** JSON presentation metadata only; scientific fields/surfaces stay in their existing Queries. */
export interface ResultComparisonState {
  configuration: ComparisonConfiguration;
  viewMode: 'geometry' | 'mesh' | 'results';
  catalogue: RetainedResults;
  left: ComparisonPaneState | null;
  right: ComparisonPaneState | null;
  difference: ComparisonPaneState | null;
  coverage: DifferenceCoverage | null;
  interpolated: boolean;
  warnings: Warning[];
  loading: boolean;
  error: EngineError | null;
}
/** A browser implements this typed boundary; a headless host explicitly lacks the workspace. */
export interface ResultComparisonHost {
  configure(input: ComparisonConfiguration): void | Promise<void>;
  legend(input: ComparisonLegendSpec): void | Promise<void>;
  visible(input: ComparisonVisibilitySpec): void | Promise<void>;
  pick(input: ComparisonPickSpec): ComparisonPick | null | Promise<ComparisonPick | null>;
  state(): ResultComparisonState;
}
