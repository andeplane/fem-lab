import OpenAI from 'openai';
import { describe,expect,it } from 'vitest';
import type { ChatRequest,ChatEvent,Usage } from '@femlab/ai';
import { openaiGateway } from '../src/provider';

const request:ChatRequest={model:'gpt-5.4-mini',maxTokens:64,system:'Private instructions',messages:[{role:'user',content:[{type:'text',text:'Private prompt'},{type:'image',mediaType:'image/png',base64:'aGVsbG8=',caption:'caption'}]}],tools:[{name:'query_nodes',description:'Inspect nodes',input_schema:{type:'object',properties:{set:{type:'string'}}}}]};
const usage={input_tokens:120,output_tokens:30,total_tokens:150,input_tokens_details:{cached_tokens:20},output_tokens_details:{reasoning_tokens:10}};
const response={id:'resp_fixture',object:'response',status:'completed',output:[],usage};
const encode=(events:unknown[])=>events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join('')+'data: [DONE]\n\n';
describe('server Responses gateway',()=>{
  it('counts exactly the generation input, including images, schemas and instructions',async()=>{
    const bodies:{url:string;body:Record<string,unknown>}[]=[];
    const client=new OpenAI({apiKey:'fixture-key',maxRetries:0,fetch:async(url,init)=>{
      bodies.push({url:String(url),body:JSON.parse(String(init?.body))});
      return String(url).endsWith('/input_tokens') ? Response.json({object:'response.input_tokens',input_tokens:120}) : new Response(encode([
        {type:'response.created',response:{...response,status:'in_progress',usage:null}},
        {type:'response.output_text.delta',delta:'answer'},
        {type:'response.completed',response},
      ]),{headers:{'content-type':'text/event-stream'}});
    }});
    const gateway=openaiGateway(client),observed:{id:string;usage:Usage|null}={id:'',usage:null};
    expect(await gateway.countInput(request)).toBe(120);
    const events:ChatEvent[]=[];
    for await(const event of gateway.chat(request,{providerId:async id=>{observed.id=id;},usage:async value=>{observed.usage=value;}})) events.push(event);
    expect(observed).toEqual({id:'resp_fixture',usage:{input:100,cacheRead:20,output:30}});
    expect(events).toContainEqual({type:'usage',usage:{input:100,cacheRead:20,output:30}});
    expect(events.at(-1)).toEqual({type:'done',stopReason:'end_turn'});
    const generation=bodies[1]!.body, counted=bodies[0]!.body;
    for(const field of ['model','input','instructions','tools']) expect(counted[field]).toEqual(generation[field]);
    expect(generation).toMatchObject({store:false,stream:true,service_tier:'default',max_output_tokens:64});
    expect(generation).not.toHaveProperty('previous_response_id');
  });
  it.each(['response.failed','response.incomplete'])('records terminal usage even when %s',async type=>{
    const client=new OpenAI({apiKey:'fixture-key',maxRetries:0,fetch:async()=>new Response(encode([{type,response:{...response,status:type.split('.')[1],incomplete_details:{reason:'max_output_tokens'},error:{message:'private prompt leaked'}}}]),{headers:{'content-type':'text/event-stream'}})});
    let metered:Usage|null=null;const events:ChatEvent[]=[];
    for await(const event of openaiGateway(client).chat(request,{providerId:async()=>{},usage:async value=>{metered=value;}})) events.push(event);
    expect(metered).toEqual({input:100,cacheRead:20,output:30});
    expect(events).toHaveLength(1);expect(events[0]).toMatchObject({type:'error'});
    expect(JSON.stringify(events)).not.toContain('private prompt');
  });
  it('does not retry generation failures and redacts SDK errors',async()=>{
    let calls=0;
    const client=new OpenAI({apiKey:'fixture-key',maxRetries:0,fetch:async()=>{calls++;return Response.json({error:{message:'Private prompt and server key',type:'server_error'}},{status:500});}});
    const events:ChatEvent[]=[];
    for await(const event of openaiGateway(client).chat(request,{providerId:async()=>{},usage:async()=>{}})) events.push(event);
    expect(calls).toBe(1);expect(events).toHaveLength(1);expect(JSON.stringify(events)).not.toContain('Private prompt');
  });
  it('reports an explicit HTTP rejection without treating a response failure as unbilled',async()=>{
    let rejected=0;
    const client=new OpenAI({apiKey:'fixture-key',maxRetries:0,fetch:async()=>Response.json({error:{message:'invalid request',type:'invalid_request_error'}},{status:400})});
    for await(const _event of openaiGateway(client).chat(request,{providerId:async()=>{},usage:async()=>{},rejected:async()=>{rejected++;}})) { /* drain */ }
    expect(rejected).toBe(1);
  });
});
