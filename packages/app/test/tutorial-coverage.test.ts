import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fetchClosed, markdown, rank, readTutorials, referencedIssues, summaryLine, text } from '../../../tools/tutorial-coverage.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const tutorials = readTutorials();

// The sub-issues epic #432 lists (Landed, In review, Not started, in that order). Copied from the
// issue body: a `needs` number outside this list is a mapping mistake, not a new capability.
const EPIC_SUB_ISSUES = [
  4, 354, 79, 78, 61, 350, 66, 59, 397, 368, 370, 371, 440, 67, 372, 72, 85, 71, 369, 68, 58, 373, 84, 22, 81, 82, // landed
  396, // in review
  62, 64, 351, 80, 60, 65, 347, 63, 73, 74, 75, 344, 346, 77, 83, 345, 69, 76, 343, 70, 431, // not started
];

/** The numbered vendor-tutorial rows of §1, parsed out of the doc the JSON is derived from. */
function docRows(): { id: number; url: string; status: string }[] {
  const lines = readFileSync(path.join(root, 'docs/TUTORIAL-COVERAGE.md'), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith('## 1. '));
  const end = lines.findIndex((l) => l.startsWith('## 2. '));
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const rows: { id: number; url: string; status: string }[] = [];
  for (const line of lines.slice(start, end)) {
    const cells = /^\|\s*(\d+)\s*\|\s*(.*?)\s*\|\s*.*?\s*\|\s*(.*?)\s*\|\s*$/.exec(line);
    if (!cells) continue;
    const url = /\[[^\]]+\]\(([^)]+)\)/.exec(cells[2] ?? '');
    const verdict = /^\*\*([^*]+)\*\*/.exec(cells[3] ?? '');
    expect(url, line).not.toBeNull();
    expect(verdict, line).not.toBeNull();
    rows.push({ id: Number(cells[1]), url: url?.[1] ?? '', status: verdict?.[1]?.trim() ?? '' });
  }
  return rows;
}

const VERDICTS: Record<string, string> = { 'can do': 'can-do', partial: 'partial', partly: 'partial', cannot: 'cannot', 'variant available': 'variant' };

describe('docs/tutorial-coverage.json', () => {
  it('has exactly one entry per numbered vendor-tutorial row of the doc', () => {
    const rows = docRows();
    expect(rows).toHaveLength(86);
    expect(tutorials).toHaveLength(rows.length);
    expect(tutorials.map((t) => t.id)).toEqual(rows.map((r) => r.id));
    expect(tutorials.map((t) => t.url)).toEqual(rows.map((r) => r.url));
    expect(tutorials.map((t) => t.status_written)).toEqual(rows.map((r) => VERDICTS[r.status] ?? r.status));
  });

  it('has unique ids, consecutive from 1', () => {
    expect(new Set(tutorials.map((t) => t.id)).size).toBe(tutorials.length);
    expect(tutorials.map((t) => t.id)).toEqual(tutorials.map((_, i) => i + 1));
  });

  it('names only sub-issues of epic #432', () => {
    const known = new Set(EPIC_SUB_ISSUES);
    for (const t of tutorials) for (const n of t.needs) expect(known.has(n), `tutorial ${t.id} needs #${n}`).toBe(true);
    expect(referencedIssues(tutorials).length).toBeGreaterThan(0);
  });

  it('leaves needs empty exactly where the doc says the tutorial already runs', () => {
    for (const t of tutorials) {
      if (t.status_written === 'can-do' || t.status_written === 'variant') expect(t.needs, `tutorial ${t.id}`).toEqual([]);
      else expect(t.needs.length, `tutorial ${t.id}`).toBeGreaterThan(0);
    }
  });

  it('rejects a broken tracker', () => {
    expect(() => readTutorials(path.join(root, 'package.json'))).toThrow(/no tutorials/);
  });
});

// A fixture rather than the real file: the ranking is what the tool asserts, and it must not move
// when an issue closes. #1 alone blocks tutorial 1, #2 and #3 both block tutorial 2, and #4 blocks
// nothing that is not already blocked twice over.
const fixture = [
  { needs: [] },
  { needs: [1] },
  { needs: [1, 9] },
  { needs: [2, 3] },
  { needs: [3, 4] },
  { needs: [9] },
];
const closed = new Set([9]);

describe('rank', () => {
  const report = rank(fixture, closed);

  it('counts doable, partly and blocked', () => {
    expect(report.summary).toEqual({ total: 6, doable: 2, partly: 1, blocked: 3 });
    expect(summaryLine(report.summary)).toBe('doable 2 / partly 1 / blocked 3 of 6');
  });

  it('ranks by what closing an issue alone would unlock, then by reach, then by number', () => {
    expect(report.ranked).toEqual([
      { issue: 1, unlocks: 2, tutorials: 2 },
      { issue: 3, unlocks: 0, tutorials: 2 },
      { issue: 2, unlocks: 0, tutorials: 1 },
      { issue: 4, unlocks: 0, tutorials: 1 },
    ]);
  });

  it('has nothing to rank once every issue is closed', () => {
    const all = rank(fixture, { has: () => true });
    expect(all.summary).toEqual({ total: 6, doable: 6, partly: 0, blocked: 0 });
    expect(all.ranked).toEqual([]);
    expect(text(all)).toContain('every tutorial is doable');
  });

  it('renders both reports', () => {
    expect(markdown(report)).toContain('| #1 | 2 | 2 |');
    expect(markdown(report)).toContain('doable 2 / partly 1 / blocked 3 of 6');
    expect(text(report)).toContain('#1  unlocks  2   needed by  2');
  });
});

describe('fetchClosed', () => {
  it('reads one batched gh listing', () => {
    const { closed: state, warnings } = fetchClosed([1, 2], () => JSON.stringify([{ number: 1, state: 'CLOSED' }, { number: 2, state: 'OPEN' }]));
    expect([...state]).toEqual([1]);
    expect(warnings).toEqual([]);
  });

  it('counts an issue the listing does not carry as open, and says so', () => {
    const { closed: state, warnings } = fetchClosed([7], () => '[]');
    expect([...state]).toEqual([]);
    expect(warnings).toEqual(['issue #7 is not in the andeplane/fem-lab listing; counted as open']);
  });

  it('counts every issue as open when gh is unavailable', () => {
    const { closed: state, warnings } = fetchClosed([1], () => {
      throw new Error('gh: command not found');
    });
    expect([...state]).toEqual([]);
    expect(warnings[0]).toContain('gh unavailable');
  });
});
