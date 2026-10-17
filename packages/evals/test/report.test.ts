import { expect, it } from 'vitest';
import { markdownReport } from '../src/report';
import type { EvaluationArtifact, FrozenManifest } from '../src/runner';
import { laneResult, scoreCase } from '../src/score';
import { EVAL_CASES } from '../src/cases';
import type { LaneResult } from '../src/types';

it('never presents an unavailable or interrupted lane as a measured zero-percent quality score', () => {
  const hashes = { app: 'not-built', nodeWasm: 'not-built', mcpPackage: 'not-built', mcpTarball: 'not-built', mcpDependencies: 'not-built', mcpLock: 'not-built' };
  const manifest: FrozenManifest = {
    gitCommit: 'fixture', dirty: false, engineVersion: 'not-run', schemaVersion: 'not-run', specificationSha256: 'fixed-cases',
    artifacts: { before: hashes, after: hashes, stable: true }, provenance: { source: 'not-run', buildCommands: [], appServer: 'not-run', mcp: 'not-run' },
    hosts: { browser: { capabilities: 'not-run' }, mcp: { node: 'fixture', platform: 'fixture', arch: 'fixture', capabilities: 'not-run' } },
    provider: 'openai', model: 'fixture', configuration: {}, startedAt: 'fixture-start', finishedAt: 'fixture-end',
  };
  const first = scoreCase(EVAL_CASES[0]!, { status: 'error', reason: 'interrupted fixture', trace: [] });
  const interrupted: LaneResult = { ...laneResult('mcp', true, [first]), status: 'interrupted', reason: 'resource guard', total: 20, gatePassed: false };
  const artifact: EvaluationArtifact = { format: 'femlab-assistant-eval/1', manifest, lanes: [laneResult('browser', true, [], 'credential unavailable'), interrupted] };
  const report = markdownReport(artifact);
  expect(report).toContain('not scored (0/20 attempted)');
  expect(report).toContain('not scored (1/20 attempted)');
  expect(report).toContain('credential unavailable');
  expect(report).toContain('resource guard');
  expect(report).not.toContain('0/20 (0%)');
});
