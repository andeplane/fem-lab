import { createHash } from 'node:crypto';
import { z } from 'zod';
import { imageSize } from 'image-size';
import { CompletionInput, type ChatEvent, type ChatRequest } from '@femlab/ai';
import type { Account } from './accounts';
import type { CreditLedger } from './ledger';
import type { ProviderGateway } from './provider';
import type { Receipt, Reservations, RequestStatus } from './reservations';
import { ServiceFailure } from './errors';

const annotation=z.record(z.string(),z.unknown());
const continuation=z.array(z.discriminatedUnion('type',[
  z.object({type:z.literal('message'),role:z.literal('assistant'),id:z.string(),status:z.string(),phase:z.string().nullable().optional(),content:z.array(z.discriminatedUnion('type',[
    z.object({type:z.literal('output_text'),text:z.string(),annotations:z.array(annotation),logprobs:z.array(z.unknown()).optional()}),
    z.object({type:z.literal('refusal'),refusal:z.string()}),
  ]))}).strict(),
  z.object({type:z.literal('reasoning'),id:z.string(),summary:z.array(z.object({type:z.literal('summary_text'),text:z.string()}).strict()),encrypted_content:z.string().nullable().optional(),status:z.string().optional(),content:z.array(z.object({type:z.literal('reasoning_text'),text:z.string()}).strict()).optional()}).strict(),
  z.object({type:z.literal('function_call'),id:z.string().optional(),call_id:z.string(),name:z.string(),arguments:z.string(),status:z.string().optional()}).strict(),
]));
export interface CompletionOutput { start(): void; send(event: {type:'chat';event:ChatEvent}|{type:'receipt';receipt:Receipt}|{type:'request';request:RequestStatus}): Promise<void> }
export interface CompletionCall { authorization?:string; key?:string; body:unknown; signal:AbortSignal }
export function completionService(deps:{account(authorization:string|undefined):Promise<Account>;ledger:CreditLedger;reservations:Reservations;provider:ProviderGateway}) {
  return {
    async run(call:CompletionCall,output:CompletionOutput):Promise<RequestStatus|undefined> {
      const account=await deps.account(call.authorization);
      const parsed=CompletionInput.safeParse(call.body);
      if(!parsed.success) throw new ServiceFailure(422,'invalid-request','The AI request does not match the supported protocol.','request');
      const input=parsed.data;
      let imageCount=0;
      for(const message of input.messages) {
        if(message.continuation && (message.role!=='assistant'||message.continuation.provider!=='openai'||!continuation.safeParse(message.continuation.value).success))
          throw new ServiceFailure(422,'invalid-continuation','This chat contains unsupported provider continuation. Start a new chat.','request','ai.newChat');
        for(const block of message.content) if(block.type==='image') {
          if(++imageCount>2) throw new ServiceFailure(422,'too-many-images','Use at most two images in a chat request. Start a new chat to attach more.','request','ai.newChat');
          try {
            if(!block.base64.length||block.base64.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(block.base64)) throw new Error('invalid base64');
            const bytes=Buffer.from(block.base64,'base64');const dimensions=imageSize(bytes);
            const expected={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[block.mediaType];
            if(bytes.length>5*1024*1024||dimensions.type!==expected||dimensions.width<1||dimensions.height<1||Math.max(dimensions.width,dimensions.height)>1568) throw new Error('image bounds');
          } catch { throw new ServiceFailure(422,'invalid-image','Use a PNG, JPEG or WebP of at most 5 MiB and 1568 pixels on its longest edge.','request'); }
        }
      }
      const prepared=await deps.reservations.prepare({accountId:account.id,key:call.key??'',digest:createHash('sha256').update(JSON.stringify(input)).digest('hex'),turnId:input.turnId,round:input.round,model:input.model,maxOutput:input.maxTokens});
      if(prepared.replay) return prepared;
      const request:ChatRequest={system:input.system,messages:input.messages,tools:input.tools,model:input.model,maxTokens:prepared.maxOutput,signal:call.signal};
      let dispatched=false, final:Receipt|null=null, sentReceipt=false;
      try {
        if(call.signal.aborted) throw new ServiceFailure(499,'request-canceled','This AI request was canceled before generation.','request');
        const tokens=await deps.provider.countInput(request);
        await deps.reservations.reserve(account.id,prepared.id,tokens);
        if(call.signal.aborted) throw new ServiceFailure(499,'request-canceled','This AI request was canceled before generation.','request');
        await deps.reservations.dispatch(account.id,prepared.id); dispatched=true;
        output.start(); await output.send({type:'request',request:{...prepared,state:'dispatched'}});
        for await(const event of deps.provider.chat(request,{
          providerId:id=>deps.reservations.providerId(account.id,prepared.id,id),
          usage:async usage=>{ final=await deps.reservations.settle(account.id,prepared.id,usage); },
          rejected:async()=>{final=await deps.reservations.rejected(account.id,prepared.id);},
        })) {
          if(event.type==='done'&&!final) {
            await output.send({type:'chat',event:{type:'error',message:'The provider did not report usage. Your request is pending confirmation.'}}); continue;
          }
          if(final&&!sentReceipt) { await output.send({type:'receipt',receipt:final}); sentReceipt=true; }
          await output.send({type:'chat',event});
        }
        if(final&&!sentReceipt) await output.send({type:'receipt',receipt:final});
      } catch(error) {
        if(!dispatched) throw error instanceof ServiceFailure ? error : new ServiceFailure(503,'provider-unavailable','AI input counting is unavailable. Try again later.','provider');
        if(!call.signal.aborted) await output.send({type:'chat',event:{type:'error',message:'This AI request was interrupted. Refresh your account to check its usage status.'}});
      } finally {
        if(!dispatched) await deps.reservations.release(account.id,prepared.id);
        else if(!final) await deps.reservations.pending(account.id,prepared.id);
      }
      return undefined;
    },
    async status(authorization:string|undefined,id:string) { const account=await deps.account(authorization); return deps.reservations.status(account.id,id); },
  };
}
export type Completions=ReturnType<typeof completionService>;
