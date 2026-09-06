// The Anthropic side of `Provider`: `messages.stream` for the text deltas, `finalMessage()` for
// the tool calls, the usage and the stop reason. The client is injected so the tests hand in a
// scripted double and nothing reaches the network (plan B §7.6).
import Anthropic from '@anthropic-ai/sdk';
import type { Block, ChatEvent, ChatRequest, Message, Provider, Usage } from './provider';

export const ANTHROPIC_MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];
export const ANTHROPIC_DEFAULT = ANTHROPIC_MODELS[0]!;

/** Only the two members we call, so a fake is two functions rather than a mock of the SDK. */
export interface AnthropicLike {
  messages: {
    stream(params: Anthropic.MessageStreamParams): AsyncIterable<Anthropic.MessageStreamEvent> & {
      finalMessage(): Promise<Anthropic.Message>;
    };
  };
}

function toContent(blocks: Block[]): Anthropic.ContentBlockParam[] {
  return blocks.flatMap((b): Anthropic.ContentBlockParam[] => {
    if (b.type === 'text') return [{ type: 'text', text: b.text }];
    if (b.type === 'tool_use') return [{ type: 'tool_use', id: b.id, name: b.name, input: b.input as object }];
    if (b.type === 'tool_result') {
      return [{ type: 'tool_result', tool_use_id: b.toolUseId, content: b.content, ...(b.isError ? { is_error: true } : {}) }];
    }
    const image: Anthropic.ContentBlockParam = { type: 'image', source: { type: 'base64', media_type: b.mediaType, data: b.base64 } };
    return b.caption ? [image, { type: 'text', text: b.caption }] : [image];
  });
}

export function toMessageParams(messages: Message[]): Anthropic.MessageParam[] {
  return messages.map((m) => ({ role: m.role, content: toContent(m.content) }));
}

const usageOf = (u: Anthropic.Usage): Usage => ({
  input: u.input_tokens + (u.cache_creation_input_tokens ?? 0),
  output: u.output_tokens,
  cacheRead: u.cache_read_input_tokens ?? 0,
});

/** Haiku 4.5 still wants `budget_tokens`; the current Opus and Sonnet take adaptive thinking. */
const thinkingFor = (model: string) => (model.startsWith('claude-haiku') ? {} : { thinking: { type: 'adaptive' as const } });

export function anthropicProvider(apiKey: string, make: (key: string) => AnthropicLike = (key) => new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true })): Provider {
  const client = make(apiKey);
  return {
    id: 'anthropic',
    models: ANTHROPIC_MODELS,
    async *chat(req: ChatRequest): AsyncIterable<ChatEvent> {
      let stream;
      try {
        stream = client.messages.stream({
          model: req.model,
          max_tokens: req.maxTokens,
          // The one cache breakpoint of plan B §7.6: everything before it is stable per deploy.
          system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
          tools: req.tools as Anthropic.Tool[],
          messages: toMessageParams(req.messages),
          ...thinkingFor(req.model),
        });
        const preparing = new Map<number, { id: string; name: string; arguments: string }>();
        for await (const event of stream) {
          if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
            const call = { id: event.content_block.id, name: event.content_block.name, arguments: '' };
            preparing.set(event.index, call);
            yield { type: 'tool_progress', ...call };
          }
          if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
            const call = preparing.get(event.index);
            if (call) {
              call.arguments += event.delta.partial_json;
              yield { type: 'tool_progress', ...call };
            }
          }
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') yield { type: 'text_delta', text: event.delta.text };
        }
        const final = await stream.finalMessage();
        for (const block of final.content) {
          if (block.type === 'tool_use') yield { type: 'tool_use', id: block.id, name: block.name, input: block.input };
        }
        yield { type: 'usage', usage: usageOf(final.usage) };
        yield { type: 'done', stopReason: final.stop_reason ?? 'end_turn' };
      } catch (e) {
        yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
