// Exercise the real agent loop with opaque Responses state across multiple tool rounds.
import type OpenAI from 'openai';
import { expect, it } from 'vitest';
import { Registry, toToolDefinitions, type EngineSchema } from '@femlab/registry';
import schema from '../../registry/src/generated/engine.schema.json';
import { fakeHost, fakeTransport } from '../../registry/test/fakes';
import { openaiProvider, type OpenAILike } from '../src/ai/openai';
import { runTurn } from '../src/ai/agent';
import { toMessageParams } from '../src/ai/anthropic';
import type { Message } from '../src/ai/provider';

it('replays the reasoning and assistant phase before the function output', async () => {
  const seen: OpenAI.Responses.ResponseCreateParamsStreaming[] = [];
  const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque-test-state' };
  const preamble = { type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Checking the field', annotations: [] }] };
  const call = { type: 'function_call', call_id: 'call_1', name: 'view_showField', arguments: '{"field":null}' };
  const client: OpenAILike = { responses: { create: async (params) => {
    seen.push(params);
    const round = seen.length;
    const first = round === 1;
    return (async function* () {
      if (first) yield { type: 'response.output_text.delta', delta: 'Checking the field' } as OpenAI.Responses.ResponseStreamEvent;
      yield { type: 'response.completed', response: { output: first ? [reasoning, preamble, call] : round === 2 ? [{ ...reasoning, id: 'rs_2' }, { ...call, call_id: 'call_2' }] : [{ ...preamble, phase: 'final_answer' }] } } as unknown as OpenAI.Responses.ResponseStreamEvent;
    })();
  } } };
  const transport = fakeTransport();
  transport.query = (async () => ({ entries: [], revision: 0, canUndo: false, canRedo: false })) as never;
  const registry = new Registry({ schema: schema as unknown as EngineSchema, host: fakeHost(transport) });
  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'Hide contours' }] }];
  for await (const _ of runTurn({ registry, provider: openaiProvider('fake', () => client), model: 'gpt-6-astra', system: 'test', tools: toToolDefinitions(registry), messages })) { /* consume */ }
  expect(seen).toHaveLength(3);
  for (const request of seen) {
    expect(request.store).toBe(false);
    expect(request.include).toContain('reasoning.encrypted_content');
  }
  const firstInput = [{ role: 'user', content: 'Hide contours' }, reasoning, preamble, call,
    { type: 'function_call_output', call_id: 'call_1', output: 'null' }];
  expect(seen[1]!.input).toEqual(firstInput);
  expect(seen[2]!.input).toEqual([...firstInput, { ...reasoning, id: 'rs_2' }, { ...call, call_id: 'call_2' },
    { type: 'function_call_output', call_id: 'call_2', output: 'null' }]);
  expect(messages.at(-1)!.continuation).toEqual({ provider: 'openai', value: [{ ...preamble, phase: 'final_answer' }] });
  // Switching provider uses the neutral transcript, never the OpenAI encrypted payload.
  expect(JSON.stringify(toMessageParams(messages))).not.toContain('opaque-test-state');
});
