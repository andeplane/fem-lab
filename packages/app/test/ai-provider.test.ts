// Both adapters against scripted doubles: one text delta, one tool call, usage, done. No network,
// no SDK client — `anthropicProvider`/`openaiProvider` take the client as an argument for exactly
// this reason (plan B §7.6).
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { Registry, toToolDefinitions, type EngineSchema } from '@femlab/registry';
import schema from '../../registry/src/generated/engine.schema.json';
import { fakeHost } from '../../registry/test/fakes';
import { anthropicProvider, toMessageParams, type AnthropicLike } from '../src/ai/anthropic';
import { openaiProvider, toResponseInput, type OpenAILike } from '../src/ai/openai';
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

function fakeOpenAI(events: unknown[], throws?: Error): { client: OpenAILike; seen: OpenAI.Responses.ResponseCreateParamsStreaming[] } {
  const seen: OpenAI.Responses.ResponseCreateParamsStreaming[] = [];
  const client: OpenAILike = { responses: { create: async (params) => {
    seen.push(params);
    if (throws) throw throws;
    return (async function* () {
      for (const event of events) yield event as OpenAI.Responses.ResponseStreamEvent;
    })();
  } } };
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
  const completed = (output: unknown[] = []) => ({ type: 'response.completed', response: {
    output, usage: { input_tokens: 20, output_tokens: 5, input_tokens_details: { cached_tokens: 8 } },
  } });
  const call = (id: string, args: string) => ({ type: 'function_call', call_id: id, name: 'geometry_addBox', arguments: args });

  it('streams text and emits completed tool calls once, using call_id rather than item id', async () => {
    const { client } = fakeOpenAI([
      { type: 'response.output_text.delta', delta: 'Hel' },
      { type: 'response.output_text.delta', delta: 'lo' },
      { type: 'response.function_call_arguments.delta', delta: '{"name"' },
      { type: 'response.output_item.done', item: call('c1', '{"name":"beam"}') },
      completed([call('c1', '{"name":"beam"}'), call('c2', '{}')]),
    ]);
    expect(await collect(openaiProvider('k', () => client).chat(request()))).toEqual([
      { type: 'text_delta', text: 'Hel' }, { type: 'text_delta', text: 'lo' },
      { type: 'tool_use', id: 'c1', name: 'geometry_addBox', input: { name: 'beam' } },
      { type: 'tool_use', id: 'c2', name: 'geometry_addBox', input: {} },
      { type: 'usage', usage: { input: 12, output: 5, cacheRead: 8 } },
      { type: 'continuation', continuation: { provider: 'openai', value: [call('c1', '{"name":"beam"}'), call('c2', '{}')] } },
      { type: 'done', stopReason: 'tool_use' },
    ]);
  });

  it('keeps cache writes inside uncached input and exposes their premium separately', async () => {
    const event = completed();
    const { client } = fakeOpenAI([{ ...event, response: { ...event.response, usage: {
      input_tokens: 20, output_tokens: 5, input_tokens_details: { cached_tokens: 8, cache_write_tokens: 3 },
    } } }]);
    const events = await collect(openaiProvider('k', () => client).chat(request()));
    expect(events.find((item) => item.type === 'usage')).toEqual({ type: 'usage', usage: { input: 12, output: 5, cacheRead: 8, cacheWrite: 3 } });
  });

  it('hands unparseable arguments back rather than pretending they were empty', async () => {
    const { client } = fakeOpenAI([completed([call('c1', '{oops')])]);
    expect((await collect(openaiProvider('k', () => client).chat(request())))[0]).toEqual({ type: 'tool_use', id: 'c1', name: 'geometry_addBox', input: { unparsed: '{oops' } });
  });

  it('preserves text, images, calls and results in Responses input', () => {
    expect(toResponseInput(conversation)).toEqual([
      { role: 'user', content: 'build a beam' },
      { role: 'user', content: [
        { type: 'input_image', image_url: 'data:image/png;base64,AAA', detail: 'auto' },
        { type: 'input_text', text: 'the sketch' },
      ] },
      { role: 'assistant', content: 'ok' },
      { type: 'function_call', call_id: 'call1', name: 'geometry_addBox', arguments: '{"name":"beam"}' },
      { type: 'function_call_output', call_id: 'call1', output: '{"ok":true}' },
    ]);
  });

  it('sends non-strict functions and request settings without server storage', async () => {
    const { client, seen } = fakeOpenAI([completed()]);
    const events = await collect(openaiProvider('k', () => client).chat(request()));
    expect(seen[0]).toMatchObject({ instructions: 'rules', max_output_tokens: 100, store: false, stream: true, service_tier: 'default' });
    expect(seen[0]!.tools).toEqual([{ type: 'function', name: 'geometry_addBox', description: 'add a box', parameters: { type: 'object' }, strict: false }]);
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });
    const { client: bad } = fakeOpenAI([], new Error('429 rate limit'));
    expect(await collect(openaiProvider('k', () => bad).chat(request()))).toEqual([{ type: 'error', message: '429 rate limit' }]);
  });

  it.each([
    [{ type: 'error', message: 'bad request' }, 'bad request'],
    [{ type: 'response.failed', response: { error: { message: 'failed' } } }, 'failed'],
    [{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }, 'OpenAI response incomplete: max_output_tokens'],
  ])('reports a terminal API error without executing partial calls', async (event, message) => {
    const { client } = fakeOpenAI([event]);
    expect(await collect(openaiProvider('k', () => client).chat(request()))).toEqual([{ type: 'error', message }]);
  });
});

describe('cost and text helpers', () => {
  it('prices a turn from the table and refuses to invent a price for an unknown model', () => {
    expect(costOf('claude-opus-5', { input: 1e6, output: 1e6, cacheRead: 1e6 })).toBeCloseTo(5 + 25 + 0.5, 6);
    expect(costOf('unpriced-model', { input: 1, output: 1, cacheRead: 0 })).toBeNull();
  });

  it('joins the text blocks of an assistant turn and ignores the rest', () => {
    expect(textOf(conversation[1]!.content)).toBe('ok');
  });
});


it('both adapters send the entire real registry with provider-compatible object roots', async () => {
  const tools = toToolDefinitions(new Registry({ schema: schema as unknown as EngineSchema, host: fakeHost() }));
  const anthropic = fakeAnthropic({});
  const openai = fakeOpenAI([]);
  await collect(anthropicProvider('k', () => anthropic.client).chat({ ...request(), tools }));
  await collect(openaiProvider('k', () => openai.client).chat({ ...request(), tools }));
  expect(anthropic.seen[0]!.tools).toEqual(tools);
  const functions = openai.seen[0]!.tools!.map((t) => {
    expect(t.type).toBe('function');
    if (t.type !== 'function') throw new Error('Expected function tool');
    return { name: t.name, description: t.description, input_schema: t.parameters };
  });
  expect(functions).toEqual(tools);
  for (const tool of tools) {
    expect(tool.input_schema['type'], tool.name).toBe('object');
    for (const key of ['anyOf', 'oneOf', 'allOf']) expect(tool.input_schema, tool.name).not.toHaveProperty(key);
  }
});


it('reveals interleaved OpenAI tool arguments before response completion, without executable calls', async () => {
  const call = (id: string, name: string, args = '') => ({ type: 'function_call', call_id: id, name, arguments: args });
  const { client } = fakeOpenAI([
    { type: 'response.output_item.added', output_index: 1, item: call('a', 'geometry_addBox') },
    { type: 'response.output_item.added', output_index: 2, item: call('b', 'view_fit') },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"name":' },
    { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{}' },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '"beam"}' },
    { type: 'response.function_call_arguments.done', output_index: 1, arguments: '{"name":"beam"}' },
    { type: 'response.completed', response: { output: [call('a', 'geometry_addBox', '{"name":"beam"}'), call('b', 'view_fit', '{}')] } },
  ]);
  const stream = openaiProvider('k', () => client).chat(request())[Symbol.asyncIterator]();
  const progress = [];
  for (let i = 0; i < 6; i++) progress.push((await stream.next()).value);
  expect(progress).toEqual([
    { type: 'tool_progress', id: 'a', name: 'geometry_addBox', arguments: '' },
    { type: 'tool_progress', id: 'b', name: 'view_fit', arguments: '' },
    { type: 'tool_progress', id: 'a', name: 'geometry_addBox', arguments: '{"name":' },
    { type: 'tool_progress', id: 'b', name: 'view_fit', arguments: '{}' },
    { type: 'tool_progress', id: 'a', name: 'geometry_addBox', arguments: '{"name":"beam"}' },
    { type: 'tool_progress', id: 'a', name: 'geometry_addBox', arguments: '{"name":"beam"}' },
  ]);
  expect((await stream.next()).value).toEqual({ type: 'tool_use', id: 'a', name: 'geometry_addBox', input: { name: 'beam' } });
});

it('reports a disconnected OpenAI stream without turning partial arguments into a call', async () => {
  const { client } = fakeOpenAI([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'a', name: 'geometry_addBox', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"name":' },
  ]);
  const events = await collect(openaiProvider('k', () => client).chat(request()));
  expect(events.filter(e => e.type === 'tool_use')).toEqual([]);
  expect(events.at(-1)).toEqual({ type: 'error', message: 'OpenAI stream ended before the response completed' });
});

it('reveals Anthropic argument fragments before requesting the final message', async () => {
  let finalized = false;
  const client: AnthropicLike = { messages: { stream: () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'a', name: 'geometry_addBox', input: {} } } as Anthropic.MessageStreamEvent;
      for (const partial_json of ['{"name":', '"beam"}']) {
        yield { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json } } as Anthropic.MessageStreamEvent;
      }
    },
    finalMessage: async () => {
      finalized = true;
      return { content: [{ type: 'tool_use', id: 'a', name: 'geometry_addBox', input: { name: 'beam' } }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } } as Anthropic.Message;
    },
  }) } };
  const stream = anthropicProvider('k', () => client).chat(request())[Symbol.asyncIterator]();
  expect((await stream.next()).value).toEqual({ type: 'tool_progress', id: 'a', name: 'geometry_addBox', arguments: '' });
  expect((await stream.next()).value).toEqual({ type: 'tool_progress', id: 'a', name: 'geometry_addBox', arguments: '{"name":' });
  expect((await stream.next()).value).toEqual({ type: 'tool_progress', id: 'a', name: 'geometry_addBox', arguments: '{"name":"beam"}' });
  expect(finalized).toBe(false);
  expect((await stream.next()).value).toEqual({ type: 'tool_use', id: 'a', name: 'geometry_addBox', input: { name: 'beam' } });
  expect(finalized).toBe(true);
});

it('passes cancellation to both SDKs and treats an aborted network read as interruption', async () => {
  const controller = new AbortController();
  const abort = () => { controller.abort(); throw new DOMException('aborted', 'AbortError'); };
  const openai: OpenAILike = { responses: { create: async (_params, options) => {
    expect(options?.signal).toBe(controller.signal);
    return abort();
  } } };
  expect(await collect(openaiProvider('k', () => openai).chat({ ...request(), signal: controller.signal }))).toEqual([]);
  const anthropic: AnthropicLike = { messages: { stream: (_params, options) => {
    expect(options?.signal).toBe(controller.signal);
    return abort();
  } } };
  expect(await collect(anthropicProvider('k', () => anthropic).chat({ ...request(), signal: controller.signal }))).toEqual([]);
});


it('does not execute Anthropic tool proposals from a token-limited response', async () => {
  const { client } = fakeAnthropic({
    content: [{ type: 'tool_use', id: 'a', name: 'geometry_addBox', input: { name: 'partial' } } as Anthropic.ContentBlock],
    stop_reason: 'max_tokens',
  }, []);
  const events = await collect(anthropicProvider('k', () => client).chat(request()));
  expect(events.map(event => event.type)).toEqual(['usage', 'error']);
  expect(events.at(-1)).toEqual({ type: 'error', message: 'Anthropic response incomplete: max_tokens' });
});
