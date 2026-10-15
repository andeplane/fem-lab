// Shared provider protocol: browser and hosted service consume exactly the same events.
import type { Block, Usage, TextBlock } from '@femlab/ai';
export type { ProviderId, TextBlock, ImageBlock, ToolUseBlock, ToolResultBlock, Block, Continuation, Message, ChatRequest, Usage, ChatEvent, Provider } from '@femlab/ai';

export const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0 };

/**
 * $ per million tokens, for the cost line under the composer. Only models we can quote sit here;
 * an unknown id yields `null` and the panel shows tokens and seconds without a price rather than
 * a made-up number.
 */
// OpenAI Standard rates verified 2026-09-06 against the model pages linked in docs/AI-PRICING.md.
export const PRICES: Record<string, { in: number; out: number; cached?: number; write?: number; longContext?: boolean }> = {
  'gpt-6-astra': { in: 10, cached: 1, write: 12.5, out: 50, longContext: true },
  'gpt-5.6-sol': { in: 4, cached: 0.4, write: 5, out: 20, longContext: true },
  'gpt-5.5': { in: 5, cached: 0.5, out: 30, longContext: true },
  'gpt-5.4-mini': { in: 0.75, cached: 0.075, out: 4.5 },
  'claude-opus-5': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

/** Estimate one request, never a sum of multiple requests with different context lengths. */
export function costOf(model: string, usage: Usage): number | null {
  const p = PRICES[model];
  if (!p) return null;
  const written = usage.cacheWrite ?? 0;
  if (written > 0 && p.write === undefined) return null;
  const long = p.longContext && usage.input + usage.cacheRead > 272_000;
  return (((usage.input - written) * p.in + written * (p.write ?? p.in) + usage.cacheRead * (p.cached ?? p.in * 0.1)) * (long ? 2 : 1)
    + usage.output * p.out * (long ? 1.5 : 1)) / 1e6;
}

/** Every text block joined; what the transcript shows for one assistant turn. */
export function textOf(blocks: Block[]): string {
  return blocks
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}
