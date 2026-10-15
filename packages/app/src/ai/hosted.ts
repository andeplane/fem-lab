import {PUBLIC_CREDIT_UNIT,toToolDefinitions,type PublicCreditUnit,type Registry,type ToolDefinition} from '@femlab/registry';
import type {ChatEvent,Provider} from '@femlab/ai';
import {normalizeAiCredits} from '../account/credits';
export interface HostedReceipt {requestId:string;outcome:string;chargedCredits:number;chargedSubcredits?:string;tariffVersion:string;creditUnit?:PublicCreditUnit}
function normalizedReceipt(receipt:HostedReceipt):HostedReceipt {
  return {...receipt,chargedCredits:normalizeAiCredits(receipt.chargedCredits,receipt.creditUnit),creditUnit:PUBLIC_CREDIT_UNIT};
}
export interface HostedEnvironment {
  origin:string;uid:string;models:string[];turnId:string;fetch:typeof fetch;
  token(force:boolean):Promise<string>;current():boolean;
  receipt(receipt:HostedReceipt):void;request(id:string):void;
}
/** A turn has one stable key per tool round. Ambiguous requests are never automatically retried. */
export function hostedProvider(env:HostedEnvironment):Provider {
  let round=0;
  const current=()=>{if(!env.current())throw new Error('The account changed. Start a new message.')};
  return {id:'openai',models:env.models,async *chat(req){
    current();const index=round++,key=`${env.turnId}:${index}`;
    const token=await env.token(false);current();
    const send=(accessToken:string)=>env.fetch(env.origin+'/v1/ai/completions',{method:'POST',signal:req.signal,headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json','Idempotency-Key':key,'X-FEMLab-Credit-Unit':PUBLIC_CREDIT_UNIT},body:JSON.stringify({protocol:1,turnId:env.turnId,round:index,model:req.model,maxTokens:req.maxTokens,system:req.system,messages:req.messages,tools:req.tools})});
    let response=await send(token);current();if(response.status===401){const fresh=await env.token(true);current();response=await send(fresh);current()}
    current();
    if(!response.ok){const error=await response.json() as {cause?:string};current();yield{type:'error',message:error.cause??'AI is unavailable. Refresh your account and try again later.'};return}
    if(!response.headers.get('content-type')?.includes('text/event-stream')){
      const replay=await response.json() as {id:string;state:string;receipt:HostedReceipt|null};current();env.request(replay.id);if(replay.receipt)env.receipt(normalizedReceipt(replay.receipt));yield{type:'error',message:'This request was already accepted. Its response cannot be replayed; refresh your account before starting a new message.'};return;
    }
    if(!response.body)throw new Error('The AI response has no stream.');
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',confirmed=false,done=false;
    const abort=()=>{void reader.cancel().catch(()=>undefined)};req.signal?.addEventListener('abort',abort,{once:true});
    try {
      while(true){const chunk=await reader.read();current();if(req.signal?.aborted)return;buffer+=decoder.decode(chunk.value,{stream:!chunk.done});buffer=buffer.replace(/\r\n/g,'\n');if(buffer.length>20*1024*1024)throw new Error('The AI response exceeded its limit.');
        let boundary:number;
        while((boundary=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(!data)continue;
          const event=JSON.parse(data) as {type:string;request?:{id:string};receipt?:HostedReceipt;event?:ChatEvent};current();
          if(event.type==='request'&&event.request){env.request(event.request.id)}
          else if(event.type==='receipt'&&event.receipt){const receipt=normalizedReceipt(event.receipt);confirmed=receipt.outcome==='confirmed';env.receipt(receipt)}
          else if(event.type==='chat'&&event.event){if((event.event.type==='tool_use'||event.event.type==='done')&&!confirmed)throw new Error('AI usage has not been confirmed. No tools were executed.');if(event.event.type==='done')done=true;yield event.event}
          else throw new Error('Unsupported AI stream event.');
        }
        if(chunk.done)break;
      }
      if(!done&&!req.signal?.aborted)yield{type:'error',message:'The response ended before completion. Refresh your account to check pending usage; this request will not be retried automatically.'};
    }finally{req.signal?.removeEventListener('abort',abort);await reader.cancel().catch(()=>undefined);reader.releaseLock()}
  }};
}

/** Engineering Commands remain callable through the typed registry Script host. Sending their
 * expanded schemas as 134 direct functions consumes over 95k input tokens before a user prompt. */
export function hostedTools(registry:Registry):ToolDefinition[]{
  return toToolDefinitions(registry).filter(tool=>(tool.name.startsWith('query_')&&tool.name!=='query_journalDiff')||['run_script','validate_script','skill_invoke','file_read','file_write'].includes(tool.name));
}
export const HOSTED_COMMAND_INSTRUCTIONS='This host uses a compact tool catalogue. Every Command and Query in the API index is available inside run_script as await fem.namespace.method({ ...args }). Execute engineering and view Commands through run_script; do not call an undeclared direct function. Use validate_script to check exact argument types before running an unfamiliar operation. The exposed Query tools can be called directly; query.journalDiff stays available in scripts without loading the whole Command union into every prompt. Account, billing, credential and consent actions require the person and are forbidden in scripts.';
