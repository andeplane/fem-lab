#!/usr/bin/env node
// Tutorial coverage tracker for epic #432 (issue #446).
//
// `docs/TUTORIAL-COVERAGE.md` judged all 86 vendor tutorials on one day; `docs/tutorial-coverage.json`
// turns that prose into data (one row per tutorial, with the #432 sub-issues it needs) and this tool
// answers "how many are doable now" from the live issue state instead of from the prose. Run it after
// every merge and paste the one-line summary on #432.
//
//   node tools/tutorial-coverage.mjs              the summary and the ranked open issues
//   node tools/tutorial-coverage.mjs --markdown   the same table, ready to paste into #432
//   node tools/tutorial-coverage.mjs --json       machine output
//
// Without `gh` (or when it fails) every issue counts as open, so the JSON still lints in CI.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const REPO = 'andeplane/fem-lab';
export const DATA_PATH = path.resolve(import.meta.dirname, '../docs/tutorial-coverage.json');

/** Read and validate the tracker: ids are unique and consecutive from 1, needs are issue numbers. */
export function readTutorials(file = DATA_PATH) {
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const tutorials = doc.tutorials;
  if (!Array.isArray(tutorials) || tutorials.length === 0) throw new Error(`${file}: no tutorials`);
  tutorials.forEach((t, i) => {
    if (t.id !== i + 1) throw new Error(`${file}: tutorial ${i + 1} has id ${String(t.id)}; ids must be unique and consecutive from 1`);
    if (!Array.isArray(t.needs)) throw new Error(`${file}: tutorial ${t.id} has no needs array`);
    for (const n of t.needs) if (!Number.isInteger(n) || n <= 0) throw new Error(`${file}: tutorial ${t.id} needs ${String(n)}, which is not an issue number`);
    if (new Set(t.needs).size !== t.needs.length) throw new Error(`${file}: tutorial ${t.id} lists an issue twice`);
  });
  return tutorials;
}

/**
 * Rank the open issues by what closing each one alone would do. Pure: `closed` is any set-like with
 * `.has(issueNumber)`, so tests drive it from a fixture and the CLI drives it from `gh`.
 *
 * doable  every need closed (a row the doc marked "can do" has none)
 * partly  some needs closed, some open
 * blocked needs, none of them closed
 *
 * `unlocks` counts the tutorials that closing this issue *alone* would make doable; `tutorials` counts
 * every tutorial that needs it. Ranked by unlocks, then by tutorials, then by issue number.
 */
export function rank(tutorials, closed) {
  const isOpen = (n) => !closed.has(n);
  const summary = { total: tutorials.length, doable: 0, partly: 0, blocked: 0 };
  const unlocks = new Map();
  const totals = new Map();
  for (const t of tutorials) {
    const open = t.needs.filter(isOpen);
    if (open.length === 0) summary.doable += 1;
    else if (open.length === t.needs.length) summary.blocked += 1;
    else summary.partly += 1;
    for (const n of open) {
      totals.set(n, (totals.get(n) ?? 0) + 1);
      if (open.length === 1) unlocks.set(n, (unlocks.get(n) ?? 0) + 1);
    }
  }
  const ranked = [...totals.keys()]
    .map((issue) => ({ issue, unlocks: unlocks.get(issue) ?? 0, tutorials: totals.get(issue) ?? 0 }))
    .sort((a, b) => b.unlocks - a.unlocks || b.tutorials - a.tutorials || a.issue - b.issue);
  return { summary, ranked };
}

/** One line for #432. */
export const summaryLine = (s) => `doable ${s.doable} / partly ${s.partly} / blocked ${s.blocked} of ${s.total}`;

/** Every issue any tutorial needs, ascending. */
export const referencedIssues = (tutorials) => [...new Set(tutorials.flatMap((t) => t.needs))].sort((a, b) => a - b);

/**
 * The state of every referenced issue in one `gh` call. Returns the closed set plus warnings; a
 * missing `gh`, a failed call or an issue absent from the listing all count as open and say so.
 */
export function fetchClosed(issues, run = defaultRun) {
  const warnings = [];
  let rows;
  try {
    rows = JSON.parse(run());
  } catch (error) {
    warnings.push(`gh unavailable (${error instanceof Error ? error.message.split('\n')[0] : String(error)}); every issue counted as open`);
    return { closed: new Set(), warnings };
  }
  const states = new Map(rows.map((r) => [r.number, r.state]));
  for (const n of issues) if (!states.has(n)) warnings.push(`issue #${n} is not in the ${REPO} listing; counted as open`);
  return { closed: new Set(issues.filter((n) => states.get(n) === 'CLOSED')), warnings };
}

const defaultRun = () =>
  execFileSync('gh', ['issue', 'list', '--json', 'number,state', '--state', 'all', '--limit', '500', '--repo', REPO], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/** The ranked table, as markdown for #432. */
export function markdown({ summary, ranked }) {
  const lines = [
    `**${summaryLine(summary)}** (${DATA_PATH.split('/').slice(-2).join('/')}, \`node tools/tutorial-coverage.mjs\`)`,
    '',
    '| open issue | tutorials it alone would make doable | tutorials that need it |',
    '|---|---|---|',
  ];
  for (const r of ranked) lines.push(`| #${r.issue} | ${r.unlocks} | ${r.tutorials} |`);
  return lines.join('\n');
}

/** The default report. */
export function text({ summary, ranked }) {
  const lines = [summaryLine(summary), ''];
  if (ranked.length === 0) lines.push('no open issues left: every tutorial is doable');
  else {
    lines.push('open issues, by the tutorials closing each one alone would make doable:', '');
    const width = Math.max(...ranked.map((r) => `#${r.issue}`.length));
    for (const r of ranked) lines.push(`  ${`#${r.issue}`.padEnd(width)}  unlocks ${String(r.unlocks).padStart(2)}   needed by ${String(r.tutorials).padStart(2)}`);
  }
  return lines.join('\n');
}

export function main(argv, { log = console.log, warn = console.error, run = defaultRun } = {}) {
  const flags = new Set(argv);
  for (const a of flags) if (a !== '--markdown' && a !== '--json') throw new Error(`unknown option ${a}; use --markdown or --json`);
  const tutorials = readTutorials();
  const { closed, warnings } = fetchClosed(referencedIssues(tutorials), run);
  const report = rank(tutorials, closed);
  for (const w of warnings) warn(`warning: ${w}`);
  if (flags.has('--json')) log(JSON.stringify({ ...report, summaryLine: summaryLine(report.summary), warnings }, null, 2));
  else if (flags.has('--markdown')) log(markdown(report));
  else log(text(report));
  return report;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
