import type OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { responsesProvider, toResponseInput, type ChatEvent, type ChatRequest, type Message, type OpenAILike } from '../src/index';

const request: ChatRequest = { model: 'gpt-5.4-mini', maxTokens: 4000, system: 'rules', tools: [
  { name: 'query_model', description: 'Read the model', input_schema: { type: 'object' } },
], messages: [{ role: 'user', content: [{ type: 'text', text: 'Check this model' }] }] };
const call = (id: string, args: string) => ({ type: 'function_call', call_id: id, name: 'query_model', arguments: args });
function client(events: unknown[], failure?: unknown): { sdk: OpenAILike; requests: OpenAI.Responses.ResponseCreateParamsStreaming[] } {
  const requests: OpenAI.Responses.ResponseCreateParamsStreaming[] = [];
  return { requests, sdk: { responses: { create: async (params) => {
    requests.push(params);
    if (failure !== undefined) throw failure;
    return (async function* () { for (const event of events) yield event as OpenAI.Responses.ResponseStreamEvent; })();
  } } } };
}
async function events(sdk: OpenAILike, req = request): Promise<ChatEvent[]> {
  const out: ChatEvent[] = []; for await (const event of responsesProvider(sdk).chat(req)) out.push(event); return out;
}

describe('one Responses adapter for both hosts', () => {
  it('preserves neutral blocks and completed opaque state in order', () => {
    const opaque = [{ type: 'reasoning', encrypted_content: 'state' }];
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'draw' }, { type: 'image', mediaType: 'image/png', base64: 'AAAA', caption: 'beam' },
        { type: 'image', mediaType: 'image/jpeg', base64: 'BBBB' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'query_model', input: null }], continuation: { provider: 'anthropic', value: 'ignored' } },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'a', content: '{}' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'display only' }], continuation: { provider: 'openai', value: opaque } },
    ];
    expect(toResponseInput(messages)).toEqual([
      { role: 'user', content: 'draw' },
      { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' }, { type: 'input_text', text: 'beam' }] },
      { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/jpeg;base64,BBBB', detail: 'auto' }] },
      { type: 'function_call', call_id: 'a', name: 'query_model', arguments: '{}' },
      { type: 'function_call_output', call_id: 'a', output: '{}' }, ...opaque,
    ]);
  });
  it('shows argument fragments but executes only completed calls and reports cache-write usage once', async () => {
    const c = client([
      { type: 'response.output_item.added', output_index: 0, item: call('a', '') },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"name":' },
      { type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"name":"beam"}' },
      { type: 'response.output_text.delta', delta: 'Checked' },
      { type: 'response.completed', response: { output: [call('a', '{"name":"beam"}'), call('b', ''), call('c', '{invalid')],
        usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 10, cache_write_tokens: 15 } } } },
    ]);
    expect(await events(c.sdk)).toEqual([
      { type: 'tool_progress', id: 'a', name: 'query_model', arguments: '' },
      { type: 'tool_progress', id: 'a', name: 'query_model', arguments: '{"name":' },
      { type: 'tool_progress', id: 'a', name: 'query_model', arguments: '{"name":"beam"}' },
      { type: 'text_delta', text: 'Checked' },
      { type: 'tool_use', id: 'a', name: 'query_model', input: { name: 'beam' } },
      { type: 'tool_use', id: 'b', name: 'query_model', input: {} },
      { type: 'tool_use', id: 'c', name: 'query_model', input: { unparsed: '{invalid' } },
      { type: 'usage', usage: { input: 90, cacheRead: 10, cacheWrite: 15, output: 20 } },
      { type: 'continuation', continuation: { provider: 'openai', value: [call('a', '{"name":"beam"}'), call('b', ''), call('c', '{invalid')] } },
      { type: 'done', stopReason: 'tool_use' },
    ]);
    expect(c.requests[0]).toMatchObject({ stream: true, store: false, service_tier: 'default', max_output_tokens: 4000, instructions: 'rules', include: ['reasoning.encrypted_content'],
      tools: [{ type: 'function', name: 'query_model', description: 'Read the model', parameters: { type: 'object' }, strict: false }] });
  });
  it('ignores unknown/non-function fragments and distinguishes usage from missing usage', async () => {
    const c = client([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
      { type: 'response.function_call_arguments.delta', output_index: 9, delta: '{}' },
      { type: 'response.function_call_arguments.done', output_index: 9, arguments: '{}' },
      { type: 'response.completed', response: { output: [], usage: { input_tokens: 3, output_tokens: 4, input_tokens_details: { cached_tokens: 1 } } } },
    ]);
    expect(await events(c.sdk)).toEqual([
      { type: 'usage', usage: { input: 2, output: 4, cacheRead: 1 } },
      { type: 'continuation', continuation: { provider: 'openai', value: [] } }, { type: 'done', stopReason: 'end_turn' },
    ]);
    const noUsage = await events(client([{ type: 'response.completed', response: { output: [] } }]).sdk);
    expect(noUsage.map(x => x.type)).toEqual(['continuation', 'done']);
    expect(responsesProvider(c.sdk, ['gpt-5.4-mini']).models).toEqual(['gpt-5.4-mini']);
  });
  it.each([
    [{ type: 'error', message: 'provider rejected' }, 'provider rejected'],
    [{ type: 'response.failed', response: { error: { message: 'failed' } } }, 'failed'],
    [{ type: 'response.failed', response: {} }, 'OpenAI response failed'],
    [{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }, 'OpenAI response incomplete: max_output_tokens'],
    [{ type: 'response.incomplete', response: {} }, 'OpenAI response incomplete: unknown'],
  ])('reports terminal failures without executing proposals', async (terminal, message) => {
    expect(await events(client([{ type: 'response.output_item.done', item: call('partial', '{}') }, terminal]).sdk))
      .toEqual([{ type: 'error', message }]);
  });
  it('makes truncation, thrown errors and host cancellation distinct', async () => {
    expect(await events(client([]).sdk)).toEqual([{ type: 'error', message: 'OpenAI stream ended before the response completed' }]);
    expect(await events(client([], new Error('network failure')).sdk)).toEqual([{ type: 'error', message: 'network failure' }]);
    expect(await events(client([], 'network failure').sdk)).toEqual([{ type: 'error', message: 'network failure' }]);
    const abort = new AbortController(); abort.abort();
    const sdk: OpenAILike = { responses: { create: async (_params, options) => { expect(options?.signal).toBe(abort.signal); throw new Error('cancel'); } } };
    expect(await events(sdk, { ...request, signal: abort.signal })).toEqual([]);
  });
});
