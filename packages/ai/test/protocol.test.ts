import { describe, expect, it } from 'vitest';
import { CompletionInput, ServiceError } from '../src/schema';

const request = {
  protocol: 1, turnId: 'turn', round: 0, model: 'gpt-5.4-mini', maxTokens: 4000,
  system: 'Model context', tools: [{ name: 'query_model', description: 'Read the model', input_schema: { type: 'object' } }],
  messages: [
    { role: 'user', content: [
      { type: 'text', text: 'Solve this beam' },
      { type: 'image', mediaType: 'image/png', base64: 'AAAA', caption: 'drawing' },
      { type: 'tool_result', toolUseId: 'call', content: '{}', isError: false },
    ] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'query_model', input: {} }],
      continuation: { provider: 'openai', value: [{ type: 'reasoning', encrypted_content: 'opaque' }] } },
  ],
};

describe('one shared completion contract', () => {
  it('retains images, explicit tool identities and opaque completed continuation', () => {
    expect(CompletionInput.parse(request)).toEqual(request);
  });
  it('rejects client-owned identity/price and unsupported wire behavior', () => {
    for (const field of ['accountId', 'balance', 'price', 'upstream', 'stream_options']) {
      expect(CompletionInput.safeParse({ ...request, [field]: 'untrusted' }).success).toBe(false);
    }
    expect(CompletionInput.safeParse({ ...request, protocol: 2 }).success).toBe(false);
    expect(CompletionInput.safeParse({ ...request, round: 12 }).success).toBe(false);
    expect(CompletionInput.safeParse({ ...request, maxTokens: 16001 }).success).toBe(false);
    expect(CompletionInput.safeParse({ ...request, tools: [{ type: 'web_search' }] }).success).toBe(false);
  });
  it('provides structured errors without arbitrary extra data', () => {
    const error = { code: 'auth.required', cause: 'Log in to use AI.', where: 'account', suggestion: 'account.login', requestId: 'req' };
    expect(ServiceError.parse(error)).toEqual(error);
    expect(ServiceError.safeParse({ ...error, apiKey: 'secret' }).success).toBe(false);
  });
});
