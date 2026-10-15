import { z } from 'zod';

export const PROTOCOL_VERSION = 1;
const text = z.string().max(1_000_000);
const identity = z.string().min(1).max(128);
const Block = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text }),
  z.strictObject({ type: z.literal('image'), mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']), base64: z.string().max(7_000_000), caption: text.optional() }),
  z.strictObject({ type: z.literal('tool_use'), id: identity, name: identity, input: z.unknown() }),
  z.strictObject({ type: z.literal('tool_result'), toolUseId: identity, content: text, isError: z.boolean().optional() }),
]);

/** One bounded provider round. Identity, prices and balances come from the service, not this body. */
export const CompletionInput = z.strictObject({
  protocol: z.literal(PROTOCOL_VERSION).describe('Protocol version shared by the browser and service.'),
  turnId: identity.describe('Host turn correlation only; never authority over an account or engine Session.'),
  round: z.number().int().min(0).max(11).describe('Round within the host turn; every round is separately admitted and metered.'),
  model: identity.describe('Requested model; the service checks its account-dependent allowlist.'),
  maxTokens: z.number().int().min(1).max(16_000).describe('Requested output ceiling, including reasoning; the service applies the plan limit.'),
  system: text.describe('Untrusted host/project instructions. Cannot change identity, billing or upstream destination.'),
  messages: z.array(z.strictObject({
    role: z.enum(['user', 'assistant']), content: z.array(Block).max(512),
    continuation: z.strictObject({ provider: z.enum(['anthropic', 'openai']), value: z.unknown() }).optional(),
  })).min(1).max(256).describe('Conversation blocks and opaque completed provider continuation; never Journal entries.'),
  tools: z.array(z.strictObject({ name: identity.regex(/^[a-zA-Z0-9_-]+$/), description: text, input_schema: z.record(z.string(), z.unknown()) })).max(512)
    .describe('Host registry function definitions, treated as data. The service never executes tools.'),
});
export type CompletionBody = z.infer<typeof CompletionInput>;

/** Structured service failure, including failures delivered after SSE headers. Never include secrets or prompt bodies. */
export const ServiceError = z.strictObject({
  code: identity, cause: z.string().max(512), where: z.string().max(256).nullable(),
  suggestion: z.string().max(256).nullable(), requestId: identity,
});
export type ServiceErrorBody = z.infer<typeof ServiceError>;
