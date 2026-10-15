/** A ref is `<kind>:<name>`; quote names with JSON strings when they contain separators. */
export const MENTION_KINDS = ['body', 'face', 'set', 'material', 'constraint', 'load', 'step', 'mesh', 'result', 'journal', 'file'] as const;
export type MentionKind = (typeof MENTION_KINDS)[number];

export interface Chip {
  ref: string;
  kind: MentionKind;
  name: string;
}

const NAME = '("(?:\\\\.|[^"\\\\])*"|[^\\s,;()"\\\\]+)';
const KINDED = new RegExp(`@(${MENTION_KINDS.join('|')}):${NAME}`, 'g');
const SINGLE = new RegExp(`^(${MENTION_KINDS.join('|')}):${NAME}(?![\\s\\S])`);
const SELECTION = /@selection\b/;

export function refOf(kind: MentionKind, name: string): string {
  return `${kind}:${name === '' || /[\s,;()"\\]/.test(name) ? JSON.stringify(name) : name}`;
}

/** Decode one canonical target, including `result:id:<opaque-id>` and global `mesh:mesh`. */
export function parseRef(ref: string): Chip | null {
  const match = SINGLE.exec(ref);
  if (!match) return null;
  const kind = match[1] as MentionKind;
  const encoded = match[2]!;
  try {
    const name: string = encoded.startsWith('"') ? JSON.parse(encoded) as string : encoded;
    return { ref: refOf(kind, name), kind, name };
  } catch { return null; }
}

/**
 * Find the `@kind:name` chips and the `@selection` pseudo-ref in a chat turn. A bare `@name`
 * without a kind is left as text (the picker always inserts the kinded form); chips are deduplicated
 * in order of first appearance; `text` is returned unchanged so the turn still reads naturally.
 */
export function parseMentions(text: string): { text: string; chips: Chip[]; selection: boolean } {
  const chips: Chip[] = [];
  const seen = new Set<string>();
  for (const [, kind, name] of text.matchAll(KINDED)) {
    const chip = parseRef(`${kind}:${name}`);
    if (chip && !seen.has(chip.ref)) {
      seen.add(chip.ref);
      chips.push(chip);
    }
  }
  return { text, chips, selection: SELECTION.test(text.replace(KINDED, '')) };
}
