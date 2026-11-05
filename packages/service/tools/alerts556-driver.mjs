/** Cloud Run Job-only source drill. All credentials/capabilities stay in inherited env. */
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const token=process.env.QA_TOKEN??'',prefix=process.env.QA_PREFIX??'',uid=process.env.QA_ALERT_UID??'20';
if(token.length<32||!/^\/qa556_[a-f0-9]+$/.test(prefix)||!/^2[0-3]$/.test(uid))throw new Error('A private bounded QA fixture is required.');
if(!/^femlab_qa556_/.test(process.env.PGDATABASE??'')||!/^qa556_/.test(process.env.PGUSER??''))throw new Error('Dedicated fixture database and role are required.');
if(['OPENAI_API_KEY','STRIPE_SECRET_KEY','FIREBASE_PROJECT_ID'].some(key=>process.env[key]))throw new Error('Real provider, payment and Auth configuration is forbidden.');
const child=spawn(process.execPath,['service/tools/acceptance556.mjs'],{stdio:['ignore','inherit','inherit']});
const exited=once(child,'exit');
const base='http://127.0.0.1:'+(process.env.PORT??'8080');
const assert=(ok,message)=>{if(!ok)throw new Error(message);};
try{
 let ready=false;
 for(let attempt=0;attempt<100&&!ready;attempt++){
  if(child.exitCode!==null)throw new Error('Fixture stopped before readiness.');
  try{const response=await fetch(base+'/ready');await response.text();ready=response.status===200;}catch{}
  if(!ready)await new Promise(resolve=>setTimeout(resolve,100));
 }
 assert(ready,'Fixture readiness deadline.');
 const body={protocol:1,turnId:'provider-alert-'+uid,round:0,model:'gpt-5.4-mini',maxTokens:1000,system:'qa-stream-failure',messages:[{role:'user',content:[{type:'text',text:'Deterministic provider failure fixture.'}]}],tools:[]};
 const response=await fetch(base+prefix+'/v1/ai/completions',{method:'POST',headers:{authorization:'Bearer '+token+':'+uid,'content-type':'application/json','idempotency-key':'provider-alert-'+uid},body:JSON.stringify(body)});
 assert(response.status===200&&response.headers.get('content-type')==='text/event-stream','Expected an HTTP 200 SSE stream.');
 const text=await response.text();assert(text.includes('interrupted')&&!text.includes('private fake'),'Expected the fixed interrupted-stream message.');
 const check=await fetch(base+prefix+'/__qa/operations',{headers:{authorization:'Bearer '+token}});assert(check.status===200,'Expected a source operational snapshot.');
 const snapshot=await check.json();assert(snapshot.signups.recent==='24'&&snapshot.alarms.some(alarm=>alarm.code==='signup-surge'),'Expected the exact signup fixture count.');
 assert(snapshot.requests.pendingMetering==='1','Provider failure must retain an uncertain hold.');
 console.log(JSON.stringify({event:'qa556-alert-source-proof',severity:'INFO',at:new Date().toISOString(),synthetic:true,drillRun:prefix.slice(1),httpStatus:response.status,signups:snapshot.signups,uncertainHold:true}));
}finally{
 child.kill('SIGTERM');
 let timeout;try{await Promise.race([exited,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Fixture shutdown deadline.')),9000);})]);}finally{clearTimeout(timeout);if(child.exitCode===null)child.kill('SIGKILL');}
}
