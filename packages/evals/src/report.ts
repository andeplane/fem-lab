import type { EvaluationArtifact } from './runner';

const percent = (value: number) => `${(value * 100).toFixed(0)}%`;

/** Human-readable companion to the complete JSON artifact. Failures are never omitted. */
export function markdownReport(artifact: EvaluationArtifact): string {
  const lines = [
    '# Assistant evaluation results',
    '',
    `Build: \`${artifact.manifest.gitCommit}\` (${artifact.manifest.dirty ? 'dirty — not eligible' : 'clean'})`,
    `Provider/model: ${artifact.manifest.provider} / \`${artifact.manifest.model}\``,
    `Run: ${artifact.manifest.startedAt} through ${artifact.manifest.finishedAt}`,
    '',
    '| Host | Status | Passed | Gate |',
    '| --- | --- | ---: | --- |',
  ];
  for (const lane of artifact.lanes) {
    lines.push(`| ${lane.host} | ${lane.status}${lane.reason ? `: ${lane.reason}` : ''} | ${lane.passed}/${lane.total} (${percent(lane.passRate)}) | ${lane.gatePassed ? 'pass' : 'fail'} |`);
  }
  lines.push('', '## Cases', '', '| Host | ID | Result | Observed | Failure cause |', '| --- | --- | --- | ---: | --- |');
  for (const lane of artifact.lanes) {
    if (lane.status === 'not-run') {
      lines.push(`| ${lane.host} | — | not run | — | ${lane.reason ?? 'not run'} |`);
      continue;
    }
    for (const score of lane.cases) {
      const failures = score.checks.filter((item) => !item.passed).map((item) => `${item.name}: ${item.detail}`).join('; ');
      lines.push(`| ${lane.host} | ${score.id} | ${score.passed ? 'pass' : 'fail'} | ${score.observed ?? '—'} | ${failures || '—'} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}
