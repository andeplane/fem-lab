// @vitest-environment node
// Opt in: FEMLAB_LIVE_AI=1 npm test -w packages/app -- ai-provider-live.test.ts
// Uses real SDK streaming and all registry tools; only host side effects are faked.
import { Registry, toToolDefinitions, commandNameFor, type EngineSchema } from '@femlab/registry';
import { expect, it } from 'vitest';
import schema from '../../registry/src/generated/engine.schema.json';
import { fakeHost } from '../../registry/test/fakes';
import { anthropicProvider, ANTHROPIC_DEFAULT } from '../src/ai/anthropic';
import { openaiProvider, OPENAI_MODELS } from '../src/ai/openai';
import type { ChatEvent, ChatRequest, Message } from '../src/ai/provider';

for (const [id, keyName, make, model] of [
  ...OPENAI_MODELS.map((model) => ['openai', 'OPENAI_API_KEY', openaiProvider, model] as const),
  ['anthropic', 'ANTHROPIC_API_KEY', anthropicProvider, ANTHROPIC_DEFAULT],
] as const) {
  it.skipIf(process.env['FEMLAB_LIVE_AI'] !== '1' || !process.env[keyName])(`${id} ${model}: full registry tool call and result round trip`, async () => {
    const host = fakeHost();
    const registry = new Registry({ schema: schema as unknown as EngineSchema, host });
    const provider = make(process.env[keyName]!);
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'Turn contours off by calling view_showField with field null, exactly once. After its result, reply with the single word Done and do not call any more tools.' }] }];
    const request: ChatRequest = { system: 'Follow the user request exactly. This is a tool integration test.', messages, tools: toToolDefinitions(registry), model, maxTokens: 2048 };
    const events: ChatEvent[] = [];
    for await (const event of provider.chat(request)) events.push(event);
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    const calls = events.filter((e) => e.type === 'tool_use');
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.name).toBe('view_showField');
    expect(call.input).toEqual({ field: null });
    await registry.dispatch({ cmd: commandNameFor(call.name, registry)!, ...call.input as object });
    expect(host.view.showField).toHaveBeenCalledWith({ field: null });
    messages.push({ role: 'assistant', content: [call], continuation: events.find((e) => e.type === 'continuation')?.continuation }, { role: 'user', content: [{ type: 'tool_result', toolUseId: call.id, content: '{"ok":true}' }] });
    const followup: ChatEvent[] = [];
    for await (const event of provider.chat(request)) followup.push(event);
    expect(followup.filter((e) => e.type === 'error' || e.type === 'tool_use')).toEqual([]);
    expect(followup.filter((e) => e.type === 'text_delta').map((e) => e.text).join('')).toMatch(/Done/i);
    expect(followup.some((e) => e.type === 'done')).toBe(true);
  }, 120_000);
}
