// Direct browser provider remains an explicit development/BYO adapter. Hosted inference
// injects a server client into the same Responses adapter, without browser constructors.
import OpenAI from 'openai';
import { responsesProvider, type OpenAILike, type Provider } from '@femlab/ai';
export { OPENAI_DEFAULT, OPENAI_MODELS, toResponseInput, type OpenAILike } from '@femlab/ai';

export function openaiProvider(apiKey: string, make: (key: string) => OpenAILike = (key) => new OpenAI({ apiKey: key, dangerouslyAllowBrowser: true })): Provider {
  return responsesProvider(make(apiKey));
}
