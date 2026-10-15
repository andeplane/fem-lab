import OpenAI from 'openai';
import { responseParameters, responsesProvider, type ChatEvent, type ChatRequest, type Usage } from '@femlab/ai';

export interface Observations {
  providerId(id: string): Promise<void>;
  usage(usage: Usage): Promise<void>;
  rejected?():Promise<void>;
}
export interface ProviderGateway {
  countInput(request: ChatRequest): Promise<number>;
  chat(request: ChatRequest, observations: Observations): AsyncIterable<ChatEvent>;
}
function responseUsage(usage: OpenAI.Responses.ResponseUsage): Usage {
  const cached=usage.input_tokens_details.cached_tokens;
  const written=usage.input_tokens_details.cache_write_tokens ?? 0;
  return { input:usage.input_tokens-cached, cacheRead:cached, output:usage.output_tokens, ...(written ? { cacheWrite:written } : {}) };
}
/** Client constructor belongs to the host and disables generation retries. Neither route nor body can set an upstream. */
export function openaiGateway(client: OpenAI): ProviderGateway {
  return {
    async countInput(request) {
      const {model,input,instructions,tools}=responseParameters(request);
      return (await client.responses.inputTokens.count({model,input,instructions,tools},{signal:request.signal})).input_tokens;
    },
    async *chat(request,observations) {
      const adapter=responsesProvider({responses:{async create(params,options){
        let events:AsyncIterable<OpenAI.Responses.ResponseStreamEvent>;
        try { events=await client.responses.create(params,options); }
        catch(error) {
          if(error instanceof OpenAI.APIError && [400,401,403,404,413,422,429].includes(error.status??0)) await observations.rejected?.();
          throw error;
        }
        return (async function*(){
          for await(const event of events) {
            if(event.type==='response.created') await observations.providerId(event.response.id);
            if(event.type==='response.completed'||event.type==='response.failed'||event.type==='response.incomplete') {
              await observations.providerId(event.response.id);
              if(event.response.usage) await observations.usage(responseUsage(event.response.usage));
              yield event; return;
            }
            yield event;
          }
        })();
      }}});
      for await(const event of adapter.chat(request)) {
        // SDK errors can echo invalid request fields. Fixed public text protects prompts/credentials.
        yield event.type==='error' ? {type:'error',message:'The AI provider did not complete this request. Check your account for its usage status.'} : event;
      }
    },
  };
}
