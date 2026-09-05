import { FemError } from './error';

export interface Skill {
  name: string;
  description: string;
  when?: string;
  body: string;
  source: 'builtin' | 'project';
}

/**
 * Parse a `SKILL.md`: frontmatter between the first two `---` lines as `key: value` per line
 * (`name`, `description`, `when`), the rest is the body. No YAML parser: the format is three keys.
 */
export function parseSkill(markdown: string, source: Skill['source']): Skill {
  const lines = markdown.split(/\r?\n/);
  const open = lines.indexOf('---');
  const close = open < 0 ? -1 : lines.indexOf('---', open + 1);
  if (open < 0 || close < 0) {
    throw new FemError('schema', 'a skill starts with a `---` frontmatter block', 'frontmatter', 'add `---\\nname: <name>\\ndescription: <what it does>\\n---` at the top');
  }
  const meta: Record<string, string> = {};
  for (const line of lines.slice(open + 1, close)) {
    const m = /^(\w+)\s*:\s*(.*)$/.exec(line);
    if (m) meta[m[1]!] = m[2]!.trim();
  }
  if (!meta['name']) {
    throw new FemError('schema', 'a skill needs a `name` in its frontmatter', 'frontmatter.name', 'add `name: <name>` between the `---` lines');
  }
  const skill: Skill = { name: meta['name'], description: meta['description'] ?? '', body: lines.slice(close + 1).join('\n').trim(), source };
  if (meta['when']) skill.when = meta['when'];
  return skill;
}

/** Project skills override built-ins of the same name; the result is sorted by name. */
export function mergeSkills(builtin: Skill[], project: Skill[]): Skill[] {
  const byName = new Map(builtin.map((s) => [s.name, s]));
  for (const s of project) byName.set(s.name, s);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
