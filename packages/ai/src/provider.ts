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
  /** Host-owned cancellation, including network reads while no tokens are arriving. */
  signal?: AbortSignal;
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

