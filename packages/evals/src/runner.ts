import type { AttemptReceipt } from './transport-recovery';
import { EVAL_CASES } from './cases';
import { laneResult, scoreCase } from './score';
import type { EvaluationBudget } from './budget';
import type { CaseScore, EvalCase, EvalEvidence, HostKind, LaneResult } from './types';

export interface EvalAdapter {
  host: HostKind;
  /** False for a scripted adapter: useful for harness tests, never eligible for the live gate. */
  live: boolean;
  availability(): Promise<{ available: true } | { available: false; reason: string }>;
  execute(spec: EvalCase): Promise<EvalEvidence>;
  close(): Promise<void>;
}

export interface LaneOptions {
  completed?: readonly CaseScore[];
  beforeCase?: () => Promise<void>;
  onCase?: (scores: readonly CaseScore[]) => Promise<void>;
}

/** Exercise the fixed list sequentially so provider context and engine state never cross cases. */
export async function runLane(adapter: EvalAdapter, specs: readonly EvalCase[] = EVAL_CASES, options: LaneOptions = {}): Promise<LaneResult> {
  const completed = [...(options.completed ?? [])];
  if (completed.length > specs.length || completed.some((score, index) => score.id !== specs[index]?.id || score.prompt !== specs[index]?.prompt)) throw new Error('evaluation checkpoint is not a fixed-case prefix');
  const scores = completed.map((score, index) => scoreCase(specs[index]!, score.evidence));
  const available = await adapter.availability();
  if (!available.available) {
    await adapter.close();
    if (scores.length > 0) return { ...laneResult(adapter.host, adapter.live, scores), status: 'interrupted', reason: available.reason, total: specs.length, passRate: scores.filter(score => score.passed).length / specs.length, gatePassed: false };
    return laneResult(adapter.host, adapter.live, [], available.reason);
  }
  try {
    for (const spec of specs.slice(scores.length)) {
      try { await options.beforeCase?.(); }
      catch (error) {
        const partial = laneResult(adapter.host, adapter.live, scores);
        return { ...partial, status: 'interrupted', reason: error instanceof Error ? error.message : String(error), total: specs.length, passRate: partial.passed / specs.length, gatePassed: false };
      }
      let evidence: EvalEvidence;
      try {
        evidence = await adapter.execute(spec);
      } catch (error) {
        evidence = { status: 'error', reason: error instanceof Error ? error.message : String(error), trace: [] };
      }
      scores.push(scoreCase(spec, evidence));
      await options.onCase?.([...scores]);
    }
  } finally {
    await adapter.close();
  }
  return laneResult(adapter.host, adapter.live, scores);
}

export interface FrozenManifest {
  gitCommit: string;
  dirty: boolean;
  engineVersion: string;
  schemaVersion: string;
  specificationSha256: string;
  artifacts: {
    before: { app: string; nodeWasm: string; mcpPackage: string; mcpTarball: string; mcpDependencies: string; mcpLock: string };
    after: { app: string; nodeWasm: string; mcpPackage: string; mcpTarball: string; mcpDependencies: string; mcpLock: string };
    stable: boolean;
  };
  provenance: {
    runtimeLocks?: { file: string; sha256: string }[];
    source: 'built-from-clean-HEAD' | 'built-from-clean-HEAD-with-verified-wasm' | 'not-run';
    wasmProvenance?: Record<string, unknown>;
    buildCommands: string[];
    appServer: 'runner-loopback' | 'not-run';
    mcp: 'isolated-tarball-install' | 'not-run';
  };
  hosts: {
    browser: { capabilities: unknown };
    mcp: { node: string; platform: string; arch: string; capabilities: unknown };
  };
  provider: string;
  model: string;
  configuration: Record<string, string | number | boolean>;
  startedAt: string;
  finishedAt: string;
}

export interface EvaluationArtifact {
  format: 'femlab-assistant-eval/1';
  manifest: FrozenManifest;
  lanes: LaneResult[];
  controls?: { budget: ReturnType<EvaluationBudget['snapshot']>; resumedFromSha256: string | null; caseInFlight: boolean; providerAttempts?: AttemptReceipt[] };
}

/** Serialize only after proving no authorized credential value leaked into the artifact. */
export function serializeArtifact(artifact: EvaluationArtifact, credentialValues: readonly string[]): string {
  const text = `${JSON.stringify(artifact, null, 2)}\n`;
  const leaked = credentialValues.find((secret) => secret.length > 0 && text.includes(secret));
  if (leaked !== undefined) throw new Error('evaluation artifact contains a provider credential');
  return text;
}

export function credentialAvailability(value: string | undefined): { available: true } | { available: false; reason: string } {
  return value === undefined || value.length === 0
    ? { available: false, reason: 'provider credential unavailable' }
    : { available: true };
}
