import {PUBLIC_CREDIT_UNIT} from '@femlab/registry';
import {expect,it,vi} from 'vitest';
import {hostedProvider,type HostedEnvironment} from '../src/ai/hosted';
import type {ChatRequest} from '@femlab/ai';
const req:ChatRequest={model:'gpt-5.4-mini',maxTokens:4096,system:'instructions',messages:[{role:'user',content:[{type:'text',text:'hello'}]}],tools:[]};
const receipt={requestId:'r',outcome:'confirmed',chargedCredits:.0405,chargedSubcredits:'1620',creditUnit:PUBLIC_CREDIT_UNIT,tariffVersion:'v1'};
const frame=(event:unknown)=>'data: '+JSON.stringify(event)+'\n\n';
function fixture(frames:unknown[]){const bytes=new TextEncoder().encode(frames.map(frame).join(''));let index=0;const fetch=vi.fn<typeof globalThis.fetch>(async()=>new Response(new ReadableStream({pull(controller){if(index<bytes.length){controller.enqueue(bytes.slice(index,index+7));index+=7}else controller.close()}}),{headers:{'content-type':'text/event-stream'}}));const env:HostedEnvironment={origin:'https://api.example.com',uid:'a',turnId:'turn-1',models:['gpt-5.4-mini'],fetch,token:vi.fn(async force=>force?'fresh':'token'),current:()=>true,receipt:vi.fn(),request:vi.fn()};return{env,provider:hostedProvider(env),fetch}}
const collect=async(f:ReturnType<typeof fixture>,request=req)=>{const events=[];for await(const event of f.provider.chat(request))events.push(event);return events};
it('decodes arbitrary chunks, retains continuation, and requires a receipt before tool execution',async()=>{const f=fixture([{type:'request',request:{id:'r'}},{type:'chat',event:{type:'text_delta',text:'hello'}},{type:'receipt',receipt},{type:'chat',event:{type:'continuation',continuation:{provider:'openai',value:[{type:'reasoning',encrypted_content:'opaque'}]}}},{type:'chat',event:{type:'tool_use',id:'call',name:'query_model',input:{}}},{type:'chat',event:{type:'done',stopReason:'tool'}}]);const events=await collect(f);expect(events.map(e=>e.type)).toEqual(['text_delta','continuation','tool_use','done']);expect(f.env.receipt).toHaveBeenCalledWith(receipt);expect(f.fetch).toHaveBeenCalledWith('https://api.example.com/v1/ai/completions',expect.objectContaining({headers:expect.objectContaining({'Idempotency-Key':'turn-1:0',Authorization:'Bearer token'})}));await collect(f);expect(JSON.parse(String(f.fetch.mock.calls[1]![1]!.body))).toMatchObject({protocol:1,round:1,turnId:'turn-1',maxTokens:4096});expect(JSON.parse(String(f.fetch.mock.calls[0]![1]!.body))).not.toHaveProperty('uid')});
it('refuses tool calls without confirmed usage and reports a broken stream without retry',async()=>{const f=fixture([{type:'chat',event:{type:'tool_use',id:'c',name:'query_model',input:{}}}]);await expect(collect(f)).rejects.toThrow('usage has not been confirmed');const broken=fixture([{type:'chat',event:{type:'text_delta',text:'partial'}}]);expect((await collect(broken)).at(-1)).toMatchObject({type:'error',message:expect.stringContaining('will not be retried')});expect(broken.fetch).toHaveBeenCalledTimes(1)});
it('rejects an account switch before any further event is exposed',async()=>{const f=fixture([{type:'chat',event:{type:'text_delta',text:'hello'}},{type:'receipt',receipt},{type:'chat',event:{type:'done',stopReason:'stop'}}]);let current=true;f.env.current=()=>current;const stream=f.provider.chat(req)[Symbol.asyncIterator]();expect((await stream.next()).value).toMatchObject({type:'text_delta'});current=false;await expect(stream.next()).rejects.toThrow('account changed')});
it('uses a forced token only after HTTP 401, with the same idempotency key',async()=>{const f=fixture([{type:'receipt',receipt},{type:'chat',event:{type:'done',stopReason:'stop'}}]);f.fetch.mockResolvedValueOnce(new Response('{}',{status:401}));await collect(f);expect(f.env.token).toHaveBeenCalledWith(true);expect(f.fetch.mock.calls.map(call=>(call[1]!.headers as Record<string,string>)['Idempotency-Key'])).toEqual(['turn-1:0','turn-1:0'])});
it('never redispatches an accepted duplicate and retains its usage receipt',async()=>{const f=fixture([]);f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({id:'r',state:'settled',receipt}),{headers:{'content-type':'application/json'}}));expect((await collect(f))[0]).toMatchObject({type:'error',message:expect.stringContaining('already accepted')});expect(f.env.request).toHaveBeenCalledWith('r');expect(f.env.receipt).toHaveBeenCalledWith(receipt);expect(f.fetch).toHaveBeenCalledTimes(1)});
it('surfaces quota errors and aborts a stalled reader',async()=>{const f=fixture([]);f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({cause:'No AI credits available.'}),{status:429}));expect((await collect(f))[0]).toEqual({type:'error',message:'No AI credits available.'});const controller=new AbortController(),cancel=vi.fn();f.fetch.mockResolvedValueOnce(new Response(new ReadableStream({cancel}),{headers:{'content-type':'text/event-stream'}}));const result=collect(f,{...req,signal:controller.signal});await vi.waitFor(()=>expect(f.fetch).toHaveBeenCalledTimes(2));controller.abort();await result;expect(cancel).toHaveBeenCalled()});

it.each(['stream','replay'] as const)('normalizes legacy %s receipts once while retaining exact subcredits',async kind=>{
  const legacy={...receipt,creditUnit:undefined,chargedCredits:112,chargedSubcredits:'3360'};
  const f=fixture([{type:'receipt',receipt:legacy},{type:'chat',event:{type:'done',stopReason:'end_turn'}}]);
  if(kind==='replay')f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({id:'r',state:'settled',receipt:legacy}),{headers:{'content-type':'application/json'}}));
  await collect(f);expect(f.env.receipt).toHaveBeenCalledExactlyOnceWith({...legacy,creditUnit:PUBLIC_CREDIT_UNIT,chargedCredits:.084});
  expect(f.fetch).toHaveBeenCalledWith('https://api.example.com/v1/ai/completions',expect.objectContaining({headers:expect.objectContaining({'X-FEMLab-Credit-Unit':PUBLIC_CREDIT_UNIT})}));
});
it('keeps small charges fractional and never rounds each request to a whole credit',async()=>{
  const exact={...receipt,chargedCredits:.00075,chargedSubcredits:'30'};
  const f=fixture([{type:'receipt',receipt:exact},{type:'chat',event:{type:'done',stopReason:'end_turn'}}]);
  await collect(f);expect(f.env.receipt).toHaveBeenCalledExactlyOnceWith(exact);
});
it.each([
  {...receipt,creditUnit:'future-unit'},
  {...receipt,chargedCredits:-1},
])('rejects unsupported or invalid credit receipts before exposing tools',async invalid=>{
  const f=fixture([{type:'receipt',receipt:invalid},{type:'chat',event:{type:'tool_use',id:'call',name:'query_model',input:{}}}]);
  await expect(collect(f)).rejects.toThrow(/AI credit/);expect(f.env.receipt).not.toHaveBeenCalled();expect(f.fetch).toHaveBeenCalledTimes(1);
});
it('never retries generation after a network error',async()=>{
  const f=fixture([]);f.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  await expect(collect(f)).rejects.toThrow('Failed to fetch');expect(f.fetch).toHaveBeenCalledTimes(1);
});

it('keeps engineering capabilities available through scripts without paying for every expanded function schema',async()=>{
  const {Registry,toToolDefinitions}=await import('@femlab/registry');const {hostedTools}=await import('../src/ai/hosted');
  const {default:schema}=await import('../../registry/src/generated/runtime-schema');
  const registry=new Registry({schema:schema as never,host:{} as never});const tools=hostedTools(registry),names=tools.map(t=>t.name);
  expect(names).toContain('run_script');expect(names).toContain('validate_script');expect(names).toContain('query_model');
  expect(names).not.toContain('query_journalDiff');expect(names).not.toContain('geometry_addBox');expect(names).not.toContain('account_checkout');expect(names).not.toContain('query_account');
  for(const tool of toToolDefinitions(registry).filter(t=>t.name.startsWith('query_')&&t.name!=='query_journalDiff'))expect(names).toContain(tool.name);
});
