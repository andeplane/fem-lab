// One interface over Anthropic and OpenAI (PLAN 4.4). The blocks are ours, not either SDK's, so
// the agent loop, the transcript and the tests never learn which provider is behind them;
// `anthropic.ts` and `openai.ts` are the only files that know a wire format.
import type { ToolDefinition } from '@femlab/registry';

export type ProviderId = 'anthropic' | 'openai';

export interface TextBlock {
  type: 'text';
  text: string;
}
/** PLAN 4.15: images live in the conversation only, never in the Journal or a Model file. */
export interface ImageBlock {
  type: 'image';
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  base64: string;
  /** The person's caption, shown on the chip and sent as text next to the image. */
  caption?: string;
}
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}
export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  /** JSON of the Command's result, or of the structured `Error` when `isError`. */
  content: string;
  isError?: boolean;
}
export type Block = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock;

/** Opaque provider wire state, retained with its assistant message and never shown in the UI. */
export interface Continuation {
  provider: ProviderId;
  value: unknown;
}

export interface Message {
  role: 'user' | 'assistant';
  content: Block[];
  continuation?: Continuation;
}

export interface ChatRequest {
  system: string;
  messages: Message[];
  tools: ToolDefinition[];
  model: string;
  maxTokens: number;
}

export interface Usage {
  /** Uncached input tokens, including cache writes. */
  input: number;
  output: number;
  cacheRead: number;
  /** Subset of input billed at a cache-write rate when reported by the provider. */
  cacheWrite?: number;
}

export type ChatEvent =
  | { type: 'text_delta'; text: string }
  /** Display-only argument snapshot. Never executable until a completed tool_use arrives. */
  | { type: 'tool_progress'; id: string; name: string; arguments: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'continuation'; continuation: Continuation }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; stopReason: string }
  | { type: 'error'; message: string };

export interface Provider {
  id: ProviderId;
  models: string[];
  /** Emit at most one usage event with final totals for this request, never cumulative deltas. */
  chat(req: ChatRequest): AsyncIterable<ChatEvent>;
}

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
