import {execFileSync} from 'node:child_process';
import {readFile,stat,unlink,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {expect,test,type Page} from '@playwright/test';
import type {AccountInfo,AccountState} from '@femlab/registry';
import type {CompletionBody} from '@femlab/ai';

const ORIGIN='https://femlab-app-staging.web.app';
const API='https://femlab-api-dhphcl4vma-ey.a.run.app';
interface Login {link:string;email:string}
interface Session {token:string;firebaseKey:string;email:string;accountId?:string}
interface AccountExport {account:{id:string;email:string};requests:unknown[];credit_grants:unknown[];credit_entries:unknown[];credit_holds:unknown[];usage_receipts:unknown[]}
const account=(page:Page)=>page.evaluate(()=>window.fem.registry.query({query:'query.account'})) as Promise<AccountState>;
const zeroAllowance={plan:'free',totalCredits:0,availableCredits:0,reservedCredits:0};

test('email login has zero signup credits, staging rejects AI, exports stay owned and deletion is durable',async({page,browser},testInfo)=>{
  const paths=[process.env['FEMLAB_LIVE_LOGIN_PATH'],process.env['FEMLAB_LIVE_OTHER_LOGIN_PATH']];
  test.skip(paths.some(path=>!path),'Requires two fresh disposable staging email action links; no email is sent.');
  expect(process.env['FEMLAB_LIVE_ORIGIN']).toBe(ORIGIN);
  expect(process.env['FEMLAB_LIVE_API_ORIGIN']).toBe(API);
  expect(Boolean(process.env['FEMLAB_LIVE_GOOGLE_ACCOUNT'])).toBe(true);
  const fixtures:Login[]=[];
  for(const path of paths){
    expect((await stat(path!)).mode&0o777).toBe(0o600);
    const fixture=JSON.parse(await readFile(path!,'utf8')) as Login;
    expect(/^[^@]+@example\.invalid$/.test(fixture.email)).toBe(true);
    const action=new URL(fixture.link);
    expect([ORIGIN,'https://femlab-app-staging.firebaseapp.com'].includes(action.origin)).toBe(true);
    if(action.origin!==ORIGIN){
      expect(action.pathname).toBe('/__/auth/action');
      const continuation=new URL(action.searchParams.get('continueUrl')!);
      expect(continuation.origin).toBe(ORIGIN);
      for(const key of ['apiKey','mode','oobCode']){const value=action.searchParams.get(key);expect(Boolean(value)).toBe(true);continuation.searchParams.set(key,value!)}
      fixture.link=continuation.toString();
    }
    expect(new URL(fixture.link).searchParams.get('mode')).toBe('signIn');
    fixtures.push(fixture);
  }
  expect(fixtures[0]!.email===fixtures[1]!.email).toBe(false);
  // Keep credentials private for owned cleanup if a browser assertion or recovery job fails.
  const statePath=paths[0]!+'.state.json',sessions:Session[]=[];
  await writeFile(statePath,'[]',{mode:0o600,flag:'wx'});
  const otherContext=await browser.newContext(),other=await otherContext.newPage();
  const headers=(session:Session)=>({Authorization:`Bearer ${session.token}`,'Content-Type':'application/json','X-Femlab-Credit-Unit':'usd-milli-v1'});
  const request=(session:Session,path:string,body?:unknown)=>fetch(API+path,{method:body===undefined?'GET':'POST',headers:headers(session),...(body===undefined?{}:{body:JSON.stringify(body)})});
  const runJob=()=>execFileSync('gcloud',['run','jobs','execute','femlab-recover','--region=europe-west3','--project=femlab-app-staging',`--account=${process.env['FEMLAB_LIVE_GOOGLE_ACCOUNT']!}`,'--wait'],{stdio:'pipe',timeout:120000});
  let passed=false;
  try {
    for(const [index,current] of [page,other].entries()){
      const fixture=fixtures[index]!;
      await current.addInitScript(email=>{sessionStorage.setItem('femlab.signInEmail',email);localStorage.setItem('femlab.tour.dismissed','1')},fixture.email);
      const exchanged=current.waitForResponse(response=>response.url().includes('accounts:signInWithEmailLink')&&response.status()===200);
      await current.goto(fixture.link);
      const response=await exchanged,credential=await response.json() as {idToken:string};
      expect(typeof credential.idToken==='string'&&credential.idToken.length>0).toBe(true);
      const session:Session={token:credential.idToken,firebaseKey:new URL(response.url()).searchParams.get('key')!,email:fixture.email};
      sessions.push(session);await writeFile(statePath,JSON.stringify(sessions),{mode:0o600});
      const profile=await request(session,'/v1/account');expect(profile.status).toBe(200);
      const created=await profile.json() as AccountInfo;expect(created).toMatchObject({creditUnit:'usd-milli-v1',usage:zeroAllowance,freeAllowance:{status:'review-required',credits:4999.9995}});
      session.accountId=created.id;await writeFile(statePath,JSON.stringify(sessions),{mode:0o600});
      const claim=await request(session,'/v1/account/free-allowance',{});
      expect(claim.status).toBe(403);expect(await claim.json()).toMatchObject({code:'eligibility-required',where:'free-allowance'});
      await current.waitForFunction(()=>Boolean(window.fem),undefined,{timeout:60000});
      await expect.poll(()=>account(current),{timeout:30000}).toMatchObject({status:'active',email:fixture.email,profile:{id:session.accountId,usage:zeroAllowance}});
      await current.reload();
      await current.waitForFunction(()=>Boolean(window.fem),undefined,{timeout:60000});
      await expect.poll(()=>account(current),{timeout:30000}).toMatchObject({status:'active',profile:{id:session.accountId,usage:zeroAllowance}});
      await current.evaluate(()=>window.fem.dispatch({cmd:'account.refresh'}));
      expect((await account(current)).profile).toMatchObject({creditUnit:'usd-milli-v1',usage:zeroAllowance,freeAllowance:{status:'review-required',credits:4999.9995}});
    }
    expect(sessions[0]!.accountId===sessions[1]!.accountId).toBe(false);
    await page.evaluate(()=>window.fem.dispatch({cmd:'model.new',name:'Staging zero-allowance smoke'}));
    await page.evaluate(()=>window.fem.dispatch({cmd:'panel.toggle',panel:'assistant',open:true}));
    await expect(page.locator('aside.assistant input[type=password]')).toHaveCount(0);
    await page.getByRole('button',{name:'Accept and enable AI',exact:true}).click();
    const admission=page.waitForResponse(response=>response.url()===API+'/v1/ai/completions');
    await page.evaluate(()=>window.fem.dispatch({cmd:'chat.send',text:'Staging admission check: this request must be rejected without generation.'}));
    const denied=await admission;
    expect(denied.status()).toBe(503);expect(await denied.json()).toMatchObject({code:'ai-unavailable',where:'admission'});
    expect(denied.headers()['content-type']).not.toContain('text/event-stream');
    await expect(page.locator('aside.assistant')).toContainText('Hosted AI is temporarily unavailable.');
    const body:CompletionBody={protocol:1,turnId:randomUUID(),round:0,model:'gpt-5.4-mini',maxTokens:1,system:'Staging admission must reject this request.',messages:[{role:'user',content:[{type:'text',text:'Do not generate.'}]}],tools:[]};
    const alias=await fetch(API+'/chat/completions',{method:'POST',headers:{...headers(sessions[0]!),'Idempotency-Key':randomUUID()},body:JSON.stringify(body)});
    expect(alias.status).toBe(503);expect(await alias.json()).toMatchObject({code:'ai-unavailable',where:'admission'});
    await page.evaluate(()=>window.fem.dispatch({cmd:'account.refresh'}));
    expect((await account(page)).profile?.usage).toMatchObject(zeroAllowance);
    await page.evaluate(()=>window.fem.dispatch({cmd:'account.open'}));
    const dialog=page.getByRole('dialog',{name:'Your AI allowance'});
    await expect(dialog).toContainText('Free monthly AI requires an eligibility review.');
    await expect(dialog).toContainText('Signing up starts with zero credits.');
    await expect(dialog.getByRole('button',{name:'Claim this month’s free allowance',exact:true})).toBeDisabled();
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:testInfo.outputPath('zero-signup-account-390.png')});
    await dialog.getByRole('button',{name:'Sign out',exact:true}).click();
    expect(await account(page)).toMatchObject({status:'anonymous',uid:null,profile:null,disclosureAccepted:false});
    await expect(page.locator('aside.assistant .messages')).toBeEmpty();
    expect((await page.evaluate(()=>window.fem.query.model())).name).toBe('Staging zero-allowance smoke');

    const anonymous=await fetch(API+'/v1/account/export',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    expect(anonymous.status).toBe(401);
    for(const [index,session] of sessions.entries()){
      const directDelete=await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${session.firebaseKey}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idToken:session.token})});
      expect(directDelete.status).toBe(400);expect(await directDelete.json()).toMatchObject({error:{message:'ADMIN_ONLY_OPERATION'}});
      const otherId=sessions[1-index]!.accountId;
      const selected=await request(session,'/v1/account/export',{accountId:otherId});
      expect(selected.status).toBe(422);expect(await selected.json()).toMatchObject({code:'invalid-export'});
      expect((await request(session,`/v1/account/export?accountId=${otherId}`,{})).status).toBe(404);
      const queued=await request(session,'/v1/account/export',{});
      expect(queued.status).toBe(200);expect(await queued.json()).toMatchObject({status:'queued'});
    }
    runJob();
    for(const [index,session] of sessions.entries()){
      const exported=await request(session,'/v1/account/export',{});expect(exported.status).toBe(200);
      const artifact=await exported.json() as {status:string;url:string};expect(artifact.status).toBe('ready');
      const download=await fetch(artifact.url);expect(download.status).toBe(200);
      const data=await download.json() as AccountExport;
      expect(data.account).toMatchObject({id:session.accountId,email:session.email});
      expect(JSON.stringify(data).includes(sessions[1-index]!.email)).toBe(false);
      for(const field of ['requests','credit_grants','credit_entries','credit_holds','usage_receipts'] as const)expect(data[field]).toHaveLength(0);
      expect(data).not.toHaveProperty('prompts');
      const unsigned=new URL(artifact.url);unsigned.search='';
      expect((await fetch(unsigned)).status).toBe(403);
      const profile=await request(session,'/v1/account');expect(profile.status).toBe(200);
      expect((await profile.json() as AccountInfo).usage).toMatchObject(zeroAllowance);
    }
    passed=true;
  } finally {
    try {
      for(const session of sessions){const deleted=await request(session,'/v1/account/delete',{confirm:'DELETE'});expect(deleted.status).toBe(200);expect(await deleted.json()).toMatchObject({status:'queued'})}
      if(sessions.length)runJob();
      for(const session of sessions)await expect.poll(async()=>(await request(session,'/v1/account')).status,{timeout:30000}).toBe(401);
      if(passed){
        await testInfo.attach('staging-zero-signup-proof',{contentType:'application/json',body:JSON.stringify({verifiedAt:new Date().toISOString(),creditUnit:'usd-milli-v1',disposableAccounts:sessions.length,signupCredits:0,reopenedCredits:0,freeAllowanceStatus:'review-required',unapprovedClaimStatus:403,completionStatus:503,completionCode:'ai-unavailable',requestRows:0,creditRows:0,usageReceipts:0,exportsOwned:true,unsignedExportStatus:403,logoutPreservedLocalModel:true,oldTokenStatus:401,generatedAI:false})});
        for(const path of paths)await unlink(path!);
        await unlink(statePath);
      }
    } finally {await otherContext.close()}
  }
});
