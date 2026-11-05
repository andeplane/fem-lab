import {readFile,writeFile} from 'node:fs/promises';
const dir=process.env.FEMLAB_556_EVIDENCE??'/tmp/femlab556-drill',s=JSON.parse(await readFile(dir+'/state.json','utf8'));const base='https://api.femlab.app'+s.prefix;
const admin={authorization:'Bearer '+s.token};const request=(i,seconds=70)=>({protocol:1,turnId:'qa556-'+i,round:0,model:'gpt-5.4-mini',maxTokens:1000,system:'seconds='+seconds,messages:[{role:'user',content:[{type:'text',text:'Synthetic deterministic transport fixture; no real inference.'}]}],tools:[]});
const sendOnce=(i,seconds=70,signal)=>fetch(base+'/v1/ai/completions',{method:'POST',headers:{authorization:'Bearer '+s.token+':'+i,'content-type':'application/json','idempotency-key':'qa556-load-'+i},body:JSON.stringify(request(i,seconds)),signal});
const send=sendOnce;
const status=async()=>{const r=await fetch(base+'/__qa/status',{headers:admin});if(r.status!==200)throw new Error('status '+r.status);return r.json();};
const control=async(name,extra={})=>{const r=await fetch(base+'/__qa/'+name,{method:'POST',headers:{...admin,...extra}});if(r.status!==200)throw new Error('control '+r.status);return r.json();};
const assert=(ok,msg)=>{if(!ok)throw new Error(msg);};
const phase=process.argv[2];
if(phase==='load'){
 // URL-map propagation is preparation. No completion is retried in the measured run.
 let stable=0;
 for(let attempt=0;attempt<300&&stable<3;attempt++){
  const probes=await Promise.all(Array.from({length:16},async()=>{const r=await fetch(base+'/__qa/status',{headers:{...admin,connection:'close'}});await r.text();return r.status;}));
  stable=probes.every(code=>code===200)?stable+1:0;
  if(stable<3)await new Promise(resolve=>setTimeout(resolve,2000));
 }
 assert(stable===3,'proxy did not stabilize before measurement');
 const measuredAt=new Date().toISOString();let clientAbortedAt;let starts=[];const aborts=Array.from({length:16},()=>new AbortController());
 const headers=Array.from({length:16},()=>Promise.withResolvers());
 const tasks=Array.from({length:16},async(_,i)=>{const t=performance.now();let r;try{
  r=await send(i,70,aborts[i].signal);headers[i].resolve(r.status);assert(r.status===200,'stream status '+r.status);assert(r.headers.get('content-type')==='text/event-stream','SSE MIME');const first=performance.now();starts.push(first-t);
  const text=await r.text();const receipts=text.split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6))).filter(e=>e.type==='receipt');assert(i>=8&&receipts.length===1,'once-only confirmed receipt');return {i,ttfbMs:first-t,durationMs:performance.now()-first,receipts:receipts.length,confirmed:receipts[0].receipt.outcome==='confirmed'};
 }catch(e){headers[i].resolve();if(i<8&&aborts[i].signal.aborted)return {i,canceled:true};throw e;}});
 const all=Promise.all(tasks);void all.catch(()=>{});
 const admissions=await Promise.all(headers.map(h=>h.promise));assert(admissions.every(code=>code===200),'all16 measured admissions must succeed');
 const ceiling=await send(20,1);assert(ceiling.status===429,'17th request must hit shared ceiling');
 clientAbortedAt=new Date().toISOString();aborts.slice(0,8).forEach(a=>a.abort());
 const rows=await all;const snap=await status();
 await writeFile(dir+'/proxy-load-raw.json',JSON.stringify({measuredAt,clientAbortedAt,observedAt:new Date().toISOString(),rows,snapshot:snap},null,2));
 const settled=Number(snap.requests.find(r=>r.state==='settled')?.count??0),pending=Number(snap.requests.find(r=>r.state==='pending_reconciliation')?.count??0),dispatched=Number(snap.requests.find(r=>r.state==='dispatched')?.count??0);
 assert(settled>=8&&settled+pending+dispatched===16,'all16 dispatched calls have confirmed receipts or retained holds');
 const confirmed=snap.receipts.find(r=>r.outcome==='confirmed');assert(Number(confirmed?.count)===settled&&BigInt(confirmed.charged)===BigInt(settled)*4800n,'exact confirmed debit per observed usage');
 const replay=await send(8);const replayBody=await replay.json();assert(replayBody.replay===true&&replayBody.receipt.outcome==='confirmed','receipt replay');
 const pendingReplay=await send(0);const canceledStatus=await pendingReplay.json();assert(canceledStatus.replay===true&&['pending_reconciliation','dispatched','settled'].includes(canceledStatus.state),'canceled request replays its durable outcome');
 const bad=await fetch('https://api.femlab.app'+s.prefix+'/v1/account',{headers:{authorization:'Bearer invalid:0'}});assert(bad.status===401,'private capability required');
 await writeFile(dir+'/proxy-load-proof.json',JSON.stringify({at:new Date().toISOString(),measuredAt,clientAbortedAt,proxy:'https://api.femlab.app',concurrency:16,sharedCeilingStatus:ceiling.status,rows,snapshot:snap,replay:true,pendingReplay:true,invalidCapabilityStatus:bad.status},null,2));console.log(JSON.stringify({concurrency:16,completed:8,canceled:8,settled,pending,dispatched,minCompletedMs:Math.min(...rows.filter(r=>r.durationMs).map(r=>r.durationMs)),states:snap.requests}));
}else if(phase==='reconcile'){
 const before=await status();assert(before.operations.admissionEnabled===false,'restored DB must stay paused');
 const denied=await send(21,1);assert(denied.status===503,'restored paused admission denied');
 const expected=Number(before.operations.requests.pendingMetering);assert(expected>=1,'physical drain contributes an uncertain hold');
 const reconciled=await control('reconcile');assert(reconciled.recovered.settled===expected,'all pending recover once');
 const again=await control('reconcile');assert(again.recovered.settled===0,'second recovery no debits');
 const after=await status();assert(after.blocked.count==='1','canonical refund blocksaccount');assert(after.grants.count==='25','canonical renewal grants once');assert(after.requests.find(r=>r.state==='settled')?.count==='17','all original and drainedrequests settled');
 await control('resume');const refunded=await send(23,1);assert(refunded.status===403||refunded.status===402,'refunded paidgrant unusable');
 const short=await send(21,1);assert(short.status===200,'reconciled readmission');const text=await short.text();assert(text.includes('"outcome":"confirmed"'),'postrestore receipt');
 await writeFile(dir+'/paid-recovery-proof.json',JSON.stringify({at:new Date().toISOString(),before,reconciled,again,after,pausedStatus:denied.status,refundedStatus:refunded.status,resumedStatus:short.status},null,2));console.log(JSON.stringify({recovered:expected,duplicateRecovery:0,refundedBlocked:true,grants:after.grants,readmitted:true}));
}else if(phase==='drain'){
 const before=await status();const r=await send(19,90);assert(r.status===200,'drain stream admission');const reading=r.text().catch(()=>null);const start=performance.now();const cookie=r.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');await control('terminate',cookie?{cookie}:{});await reading;let after;
 for(let i=0;i<30;i++){try{after=await status();if(after.requests.find(r=>r.state==='pending_reconciliation')?.count===String(Number(before.operations.requests.pendingMetering)+1))break;}catch{}await new Promise(resolve=>setTimeout(resolve,1000));}
 assert(after?.requests.find(r=>r.state==='pending_reconciliation')?.count===String(Number(before.operations.requests.pendingMetering)+1),'drain persists pending beforeprocess exit');
 const elapsed=performance.now()-start;const replay=await send(19,90);assert((await replay.json()).state==='pending_reconciliation','drained request replay');
 await writeFile(dir+'/drain-proof.json',JSON.stringify({at:new Date().toISOString(),before,after,elapsedMs:elapsed,pendingReplay:true},null,2));console.log(JSON.stringify({elapsedMs:elapsed,durablePending:true,pendingReplay:true}));
}else throw new Error(phase);
