// The OpenAI side of `Provider`: Chat Completions with function calling and streaming. Chosen over
// the Responses API because the tool loop, the images and the streamed deltas map one-to-one onto
// what `provider.ts` already declares, so this file is a translation and nothing else. The client is
// injected, so the tests hand in a scripted double and nothing reaches the network.
import OpenAI from 'openai';
import type { Block, ChatEvent, ChatRequest, Message, Provider } from './provider';

/** From the SDK's `ChatModel` union, newest first. */
export const OPENAI_MODELS = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4-mini'];
export const OPENAI_DEFAULT = OPENAI_MODELS[0]!;

export interface OpenAILike {
  chat: {
    completions: {
      create(params: OpenAI.ChatCompletionCreateParamsStreaming): Promise<AsyncIterable<OpenAI.ChatCompletionChunk>>;
    };
  };
}

const dataUrl = (b: { mediaType: string; base64: string }) => `data:${b.mediaType};base64,${b.base64}`;

/**
 * Our messages into OpenAI's. The shapes do not line up one-to-one: a `tool_result` block rides in
 * a user message here but is its own `role: 'tool'` message there, so one of ours can become several.
 */
export function toChatMessages(system: string, messages: Message[]): OpenAI.ChatCompletionMessageParam[] {
  const out: OpenAI.ChatCompletionMessageParam[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.toolUseId, content: b.content });
    }
    const parts = m.content.filter((b): b is Extract<Block, { type: 'text' | 'image' }> => b.type === 'text' || b.type === 'image');
    const calls = m.content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
    if (m.role === 'assistant') {
      if (parts.length === 0 && calls.length === 0) continue;
      out.push({
        role: 'assistant',
        content: parts.map((p) => (p.type === 'text' ? p.text : '')).join('') || null,
        ...(calls.length > 0
          ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) }
          : {}),
      });
      continue;
    }
    if (parts.length === 0) continue;
    out.push({
      role: 'user',
      content: parts.flatMap((p): OpenAI.ChatCompletionContentPart[] =>
        p.type === 'text'
          ? [{ type: 'text', text: p.text }]
          : [{ type: 'image_url', image_url: { url: dataUrl(p) } }, ...(p.caption ? [{ type: 'text' as const, text: p.caption }] : [])],
      ),
    });
  }
  return out;
}

/** A model that returns unparseable arguments gets a schema error back rather than empty input. */
function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return { unparsed: raw };
  }
}

export function openaiProvider(apiKey: string, make: (key: string) => OpenAILike = (key) => new OpenAI({ apiKey: key, dangerouslyAllowBrowser: true })): Provider {
  const client = make(apiKey);
  return {
    id: 'openai',
    models: OPENAI_MODELS,
    async *chat(req: ChatRequest): AsyncIterable<ChatEvent> {
      const pending = new Map<number, { id: string; name: string; args: string }>();
      let stopReason = 'end_turn';
      let usage = { input: 0, output: 0, cacheRead: 0 };
      try {
        const stream = await client.chat.completions.create({
          model: req.model,
          max_completion_tokens: req.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
          messages: toChatMessages(req.system, req.messages),
          tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })),
        });
        for await (const chunk of stream) {
          if (chunk.usage) {
            usage = {
              input: chunk.usage.prompt_tokens - (chunk.usage.prompt_tokens_details?.cached_tokens ?? 0),
              output: chunk.usage.completion_tokens,
              cacheRead: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
            };
          }
          const choice = chunk.choices[0];
          if (!choice) continue;
          if (choice.delta.content) yield { type: 'text_delta', text: choice.delta.content };
          for (const call of choice.delta.tool_calls ?? []) {
            const cur = pending.get(call.index) ?? { id: '', name: '', args: '' };
            pending.set(call.index, {
              id: call.id ?? cur.id,
              name: call.function?.name ?? cur.name,
              args: cur.args + (call.function?.arguments ?? ''),
            });
          }
          if (choice.finish_reason) stopReason = choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason;
        }
        for (const call of pending.values()) yield { type: 'tool_use', id: call.id, name: call.name, input: parseArgs(call.args) };
        yield { type: 'usage', usage };
        yield { type: 'done', stopReason };
      } catch (e) {
        yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
