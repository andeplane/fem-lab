/** A ref is `<kind>:<name>`; `face` is a Set of kind face, kept as its own word because that is what people say. */
export const MENTION_KINDS = ['body', 'face', 'set', 'material', 'constraint', 'load', 'step', 'result', 'journal', 'file'] as const;
export type MentionKind = (typeof MENTION_KINDS)[number];

export interface Chip {
  ref: string;
  kind: MentionKind;
  name: string;
}

const KINDED = new RegExp(`@(${MENTION_KINDS.join('|')}):([^\\s,;)]+)`, 'g');
const SELECTION = /@selection\b/;

export function refOf(kind: MentionKind, name: string): string {
  return `${kind}:${name}`;
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
    const ref = refOf(kind as MentionKind, name!);
    if (!seen.has(ref)) {
      seen.add(ref);
      chips.push({ ref, kind: kind as MentionKind, name: name! });
    }
  }
  return { text, chips, selection: SELECTION.test(text) };
}
