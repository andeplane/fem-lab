import { EVAL_CASES } from './cases';
import { laneResult, scoreCase } from './score';
import type { EvalCase, EvalEvidence, HostKind, LaneResult } from './types';

export interface EvalAdapter {
  host: HostKind;
  /** False for a scripted adapter: useful for harness tests, never eligible for the live gate. */
  live: boolean;
  availability(): Promise<{ available: true } | { available: false; reason: string }>;
  execute(spec: EvalCase): Promise<EvalEvidence>;
  close(): Promise<void>;
}

/** Exercise the fixed list sequentially so provider context and engine state never cross cases. */
export async function runLane(adapter: EvalAdapter, specs: readonly EvalCase[] = EVAL_CASES): Promise<LaneResult> {
  const available = await adapter.availability();
  if (!available.available) {
    await adapter.close();
    return laneResult(adapter.host, adapter.live, [], available.reason);
  }
  const scores = [];
  try {
    for (const spec of specs) {
      let evidence: EvalEvidence;
      try {
        evidence = await adapter.execute(spec);
      } catch (error) {
        evidence = { status: 'error', reason: error instanceof Error ? error.message : String(error), trace: [] };
      }
      scores.push(scoreCase(spec, evidence));
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
    before: { app: string; nodeWasm: string; mcpPackage: string; mcpTarball: string };
    after: { app: string; nodeWasm: string; mcpPackage: string; mcpTarball: string };
    stable: boolean;
  };
  provenance: {
    source: 'built-from-clean-HEAD' | 'not-run';
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
