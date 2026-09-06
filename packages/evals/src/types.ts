export type HostKind = 'browser' | 'mcp';
export type CaseKind = 'axial' | 'bending' | 'heat' | 'modal' | 'explicit';

export interface EvalCase {
  id: string;
  kind: CaseKind;
  prompt: string;
  dimensionsM: [number, number, number];
  procedure: 'static' | 'heat-steady' | 'modal' | 'explicit';
  expected: number;
  expectedUnit: 'm' | 'K' | 'Hz';
  relativeTolerance?: number;
  absoluteTolerance?: number;
  measure:
    | { kind: 'extreme'; field: string; component: number; side: 'min' | 'max' }
    | { kind: 'probe'; field: string; component?: number; atM: [number, number, number] }
    | { kind: 'frequency'; index: number }
    | { kind: 'frames'; component: 0 | 1 | 2; acceleration: number };
  thermal?: { leftK: number; rightK: number; conductivity: number };
  explicit?: { endS: number };

  materialE?: number;
  appliedN?: [number, number, number];
  requires?: 'material-library' | 'script-validation';
}

export interface ToolTrace {
  name: string;
  command?: string;
  ms?: number;
  ok?: boolean;
  input: unknown;
  output?: unknown;
  error?: unknown;
  journalBefore?: string;
  journalAfter?: string;
}

export interface EvalEvidence {
  status: 'completed' | 'error' | 'not-run';
  reason?: string;
  assistantText?: string;
  usage?: unknown;
  elapsedMs?: number;
  capabilities?: unknown;
  model?: unknown;
  result?: unknown;
  probe?: unknown;
  frames?: unknown[];
  journal?: unknown;
  trace: ToolTrace[];
}

export interface CheckResult {
  name: 'status' | 'journal' | 'model' | 'physics' | 'value' | 'balance' | 'trace';
  passed: boolean;
  detail: string;
}

export interface CaseScore {
  id: string;
  prompt: string;
  evidence: EvalEvidence;
  passed: boolean;
  checks: CheckResult[];
  observed: number | null;
  expected: number;
}

export interface LaneResult {
  host: HostKind;
  live: boolean;
  status: 'completed' | 'not-run';
  reason?: string;
  cases: CaseScore[];
  passed: number;
  total: number;
  passRate: number;
  gatePassed: boolean;
}
