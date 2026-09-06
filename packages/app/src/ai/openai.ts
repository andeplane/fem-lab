// Responses supports function tools with reasoning on every model offered by the app.
// The client is injected so adapter tests exercise the wire format without the network.
import OpenAI from 'openai';
import type { ChatEvent, ChatRequest, Message, Provider } from './provider';

export const OPENAI_MODELS = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4-mini'] satisfies OpenAI.ChatModel[];
export const OPENAI_DEFAULT = OPENAI_MODELS[0]!;

export interface OpenAILike {
  responses: {
    create(params: OpenAI.Responses.ResponseCreateParamsStreaming, options?: { signal?: AbortSignal }): Promise<AsyncIterable<OpenAI.Responses.ResponseStreamEvent>>;
  };
}

/** Keep tool call IDs paired with their results, including multiple calls in a turn. */
export function toResponseInput(messages: Message[]): OpenAI.Responses.ResponseInput {
  return messages.flatMap((m) => {
    // Replay the complete output in order, including encrypted reasoning and message phase.
    // These items replace the display blocks; adding both would duplicate text and tool calls.
    if (m.role === 'assistant' && m.continuation?.provider === 'openai') {
      return m.continuation.value as OpenAI.Responses.ResponseInput;
    }
    return m.content.flatMap((b): OpenAI.Responses.ResponseInput => {
      if (b.type === 'tool_use') return [{ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) }];
      if (b.type === 'tool_result') return [{ type: 'function_call_output', call_id: b.toolUseId, output: b.content }];
      if (b.type === 'text') return [{ role: m.role, content: b.text }];
      return [{ role: 'user', content: [
        { type: 'input_image', image_url: `data:${b.mediaType};base64,${b.base64}`, detail: 'auto' },
        ...(b.caption ? [{ type: 'input_text' as const, text: b.caption }] : []),
      ] }];
    });
  });
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
      try {
        const stream = await client.responses.create({
          model: req.model,
          max_output_tokens: req.maxTokens,
          stream: true,
          store: false,
          service_tier: 'default',
          include: ['reasoning.encrypted_content'],
          instructions: req.system,
          input: toResponseInput(req.messages),
          // Registry schemas intentionally have optional fields; strict mode would rewrite them.
          tools: req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema, strict: false })),
        }, { signal: req.signal });
        const preparing = new Map<number, { id: string; name: string; arguments: string }>();
        let terminal = false;
        for await (const event of stream) {
          if (event.type === 'response.output_item.added' && event.item.type === 'function_call') {
            const call = { id: event.item.call_id, name: event.item.name, arguments: event.item.arguments };
            preparing.set(event.output_index, call);
            yield { type: 'tool_progress', ...call };
          }
          if (event.type === 'response.function_call_arguments.delta') {
            const call = preparing.get(event.output_index);
            if (call) {
              call.arguments += event.delta;
              yield { type: 'tool_progress', ...call };
            }
          }
          if (event.type === 'response.function_call_arguments.done') {
            const call = preparing.get(event.output_index);
            if (call) {
              call.arguments = event.arguments;
              yield { type: 'tool_progress', ...call };
            }
          }
          if (['response.completed', 'response.failed', 'response.incomplete', 'error'].includes(event.type)) terminal = true;
          if (event.type === 'response.output_text.delta') yield { type: 'text_delta', text: event.delta };
          if (event.type === 'response.completed') {
            const response = event.response;
            const calls = response.output.filter((item) => item.type === 'function_call');
            for (const call of calls) yield { type: 'tool_use', id: call.call_id, name: call.name, input: parseArgs(call.arguments) };
            if (response.usage) {
              const cacheRead = response.usage.input_tokens_details.cached_tokens;
              const cacheWrite = response.usage.input_tokens_details.cache_write_tokens ?? 0;
              yield { type: 'usage', usage: { input: response.usage.input_tokens - cacheRead, output: response.usage.output_tokens, cacheRead, ...(cacheWrite > 0 ? { cacheWrite } : {}) } };
            }
            yield { type: 'continuation', continuation: { provider: 'openai', value: response.output } };
            yield { type: 'done', stopReason: calls.length ? 'tool_use' : 'end_turn' };
          }
          if (event.type === 'error') yield { type: 'error', message: event.message };
          if (event.type === 'response.failed') yield { type: 'error', message: event.response.error?.message ?? 'OpenAI response failed' };
          if (event.type === 'response.incomplete') yield { type: 'error', message: `OpenAI response incomplete: ${event.response.incomplete_details?.reason ?? 'unknown'}` };
        }
        if (!terminal) yield { type: 'error', message: 'OpenAI stream ended before the response completed' };
      } catch (e) {
        if (req.signal?.aborted) return;
        yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
