// The app's built-in skills (PLAN 4.12), bundled from `packages/app/skills/<name>/SKILL.md` at build
// time. Adding a skill is adding a file; nothing here changes.
import { parseSkill, type Skill } from '@femlab/registry';

const FILES = import.meta.glob('../../skills/*/SKILL.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export const BUILTIN_SKILLS: Skill[] = Object.values(FILES)
  .map((text) => parseSkill(text, 'builtin'))
  .sort((a, b) => a.name.localeCompare(b.name));
