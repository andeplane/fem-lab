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

export interface Message {
  role: 'user' | 'assistant';
  content: Block[];
}

export interface ChatRequest {
  system: string;
  messages: Message[];
  tools: ToolDefinition[];
  model: string;
  maxTokens: number;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
}

export type ChatEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; stopReason: string }
  | { type: 'error'; message: string };

export interface Provider {
  id: ProviderId;
  models: string[];
  chat(req: ChatRequest): AsyncIterable<ChatEvent>;
}

export const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0 };

/**
 * $ per million tokens, for the cost line under the composer. Only models we can quote sit here;
 * an unknown id yields `null` and the panel shows tokens and seconds without a price rather than
 * a made-up number.
 */
export const PRICES: Record<string, { in: number; out: number }> = {
  'claude-opus-5': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

export function costOf(model: string, usage: Usage): number | null {
  const p = PRICES[model];
  if (!p) return null;
  return ((usage.input + usage.cacheRead * 0.1) * p.in + usage.output * p.out) / 1e6;
}

/** Every text block joined; what the transcript shows for one assistant turn. */
export function textOf(blocks: Block[]): string {
  return blocks
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}
