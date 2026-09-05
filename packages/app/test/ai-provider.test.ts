// Both adapters against scripted doubles: one text delta, one tool call, usage, done. No network,
// no SDK client — `anthropicProvider`/`openaiProvider` take the client as an argument for exactly
// this reason (plan B §7.6).
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { anthropicProvider, toMessageParams, type AnthropicLike } from '../src/ai/anthropic';
import { openaiProvider, toChatMessages, type OpenAILike } from '../src/ai/openai';
import { costOf, textOf, type ChatEvent, type ChatRequest, type Message } from '../src/ai/provider';

const TOOLS = [{ name: 'geometry_addBox', description: 'add a box', input_schema: { type: 'object' } }];

const conversation: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'build a beam' }, { type: 'image', mediaType: 'image/png', base64: 'AAA', caption: 'the sketch' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'call1', name: 'geometry_addBox', input: { name: 'beam' } }] },
  { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call1', content: '{"ok":true}' }] },
];

const request = (messages: Message[] = conversation): ChatRequest => ({ system: 'rules', messages, tools: TOOLS, model: 'claude-opus-5', maxTokens: 100 });

async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

function fakeAnthropic(final: Partial<Anthropic.Message>, deltas = ['Hel', 'lo'], throws?: Error): { client: AnthropicLike; seen: Anthropic.MessageStreamParams[] } {
  const seen: Anthropic.MessageStreamParams[] = [];
  const client: AnthropicLike = {
    messages: {
      stream(params) {
        seen.push(params);
        if (throws) throw throws;
        return {
          async *[Symbol.asyncIterator]() {
            for (const text of deltas) yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as Anthropic.MessageStreamEvent;
            yield { type: 'message_stop' } as Anthropic.MessageStreamEvent;
          },
          finalMessage: async () =>
            ({
              content: [],
              stop_reason: 'end_turn',
              usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
              ...final,
            }) as Anthropic.Message,
        };
      },
    },
  };
  return { client, seen };
}

function fakeOpenAI(chunks: Partial<OpenAI.ChatCompletionChunk>[], throws?: Error): { client: OpenAILike; seen: OpenAI.ChatCompletionCreateParamsStreaming[] } {
  const seen: OpenAI.ChatCompletionCreateParamsStreaming[] = [];
  const client: OpenAILike = {
    chat: {
      completions: {
        create: async (params) => {
          seen.push(params);
          if (throws) throw throws;
          return (async function* () {
            for (const c of chunks) yield c as OpenAI.ChatCompletionChunk;
          })();
        },
      },
    },
  };
  return { client, seen };
}

describe('the Anthropic adapter', () => {
  it('streams text, then the tool calls, the usage and the stop reason', async () => {
    const { client } = fakeAnthropic({
      content: [{ type: 'tool_use', id: 'c1', name: 'geometry_addBox', input: { name: 'beam' } } as Anthropic.ContentBlock],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 } as Anthropic.Usage,
    });
    const events = await collect(anthropicProvider('k', () => client).chat(request()));
    expect(events).toEqual([
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo' },
      { type: 'tool_use', id: 'c1', name: 'geometry_addBox', input: { name: 'beam' } },
      { type: 'usage', usage: { input: 13, output: 4, cacheRead: 7 } },
      { type: 'done', stopReason: 'tool_use' },
    ]);
  });

  it('puts the one cache breakpoint on the system prompt and asks for adaptive thinking', async () => {
    const { client, seen } = fakeAnthropic({});
    await collect(anthropicProvider('k', () => client).chat(request()));
    expect(seen[0]!.system).toEqual([{ type: 'text', text: 'rules', cache_control: { type: 'ephemeral' } }]);
    expect(seen[0]!.thinking).toEqual({ type: 'adaptive' });
  });

  it('leaves thinking off for Haiku, which has no adaptive mode', async () => {
    const { client, seen } = fakeAnthropic({});
    await collect(anthropicProvider('k', () => client).chat({ ...request(), model: 'claude-haiku-4-5' }));
    expect(seen[0]!.thinking).toBeUndefined();
  });

  it('sends images as base64 image blocks, tool results with is_error, and keeps captions', () => {
    const params = toMessageParams([
      ...conversation,
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c2', content: '{"code":"schema"}', isError: true }] },
    ]);
    expect(params[0]!.content).toEqual([
      { type: 'text', text: 'build a beam' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
      { type: 'text', text: 'the sketch' },
    ]);
    expect(params[2]!.content).toEqual([{ type: 'tool_result', tool_use_id: 'call1', content: '{"ok":true}' }]);
    expect(params[3]!.content).toEqual([{ type: 'tool_result', tool_use_id: 'c2', content: '{"code":"schema"}', is_error: true }]);
  });

  it('turns a thrown SDK error into one error event instead of rejecting', async () => {
    const { client } = fakeAnthropic({}, [], new Error('401 invalid x-api-key'));
    const events = await collect(anthropicProvider('k', () => client).chat(request()));
    expect(events).toEqual([{ type: 'error', message: '401 invalid x-api-key' }]);
  });
});

describe('the OpenAI adapter', () => {
  const chunk = (delta: OpenAI.ChatCompletionChunk.Choice.Delta, finish?: string): Partial<OpenAI.ChatCompletionChunk> => ({
    choices: [{ index: 0, delta, finish_reason: (finish ?? null) as never, logprobs: null }],
  });

  it('accumulates streamed tool-call argument deltas into one tool_use', async () => {
    const { client } = fakeOpenAI([
      chunk({ content: 'Hel' }),
      chunk({ content: 'lo' }),
      chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'geometry_addBox', arguments: '{"name"' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: ':"beam"}' } }] }),
      chunk({}, 'tool_calls'),
      { usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, prompt_tokens_details: { cached_tokens: 8 } } as OpenAI.CompletionUsage, choices: [] },
    ]);
    const events = await collect(openaiProvider('k', () => client).chat({ ...request(), model: 'gpt-6-astra' }));
    expect(events).toEqual([
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo' },
      { type: 'tool_use', id: 'c1', name: 'geometry_addBox', input: { name: 'beam' } },
      { type: 'usage', usage: { input: 12, output: 5, cacheRead: 8 } },
      { type: 'done', stopReason: 'tool_use' },
    ]);
  });

  it('hands unparseable arguments back rather than pretending they were empty', async () => {
    const { client } = fakeOpenAI([chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'x', arguments: '{oops' } }] }), chunk({}, 'tool_calls')]);
    const events = await collect(openaiProvider('k', () => client).chat(request()));
    expect(events[0]).toEqual({ type: 'tool_use', id: 'c1', name: 'x', input: { unparsed: '{oops' } });
  });

  it('splits tool results into `role: tool` messages and images into data URLs', () => {
    const messages = toChatMessages('rules', conversation);
    expect(messages[0]).toEqual({ role: 'system', content: 'rules' });
    expect(messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'build a beam' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
        { type: 'text', text: 'the sketch' },
      ],
    });
    expect(messages[2]).toEqual({ role: 'assistant', content: 'ok', tool_calls: [{ id: 'call1', type: 'function', function: { name: 'geometry_addBox', arguments: '{"name":"beam"}' } }] });
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'call1', content: '{"ok":true}' });
    expect(messages).toHaveLength(4);
  });

  it('sends the tools as functions and turns a thrown error into one error event', async () => {
    const { client, seen } = fakeOpenAI([chunk({ content: 'hi' }, 'stop')]);
    const events = await collect(openaiProvider('k', () => client).chat(request()));
    expect(seen[0]!.tools).toEqual([{ type: 'function', function: { name: 'geometry_addBox', description: 'add a box', parameters: { type: 'object' } } }]);
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'stop' });

    const { client: bad } = fakeOpenAI([], new Error('429 rate limit'));
    expect(await collect(openaiProvider('k', () => bad).chat(request()))).toEqual([{ type: 'error', message: '429 rate limit' }]);
  });
});

describe('cost and text helpers', () => {
  it('prices a turn from the table and refuses to invent a price for an unknown model', () => {
    expect(costOf('claude-opus-5', { input: 1e6, output: 1e6, cacheRead: 1e6 })).toBeCloseTo(5 + 25 + 0.5, 6);
    expect(costOf('gpt-6-astra', { input: 1, output: 1, cacheRead: 0 })).toBeNull();
  });

  it('joins the text blocks of an assistant turn and ignores the rest', () => {
    expect(textOf(conversation[1]!.content)).toBe('ok');
  });
});
