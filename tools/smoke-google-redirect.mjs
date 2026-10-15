#!/usr/bin/env node
// Opt-in developer smoke: serve a built candidate over the real app origin in a NEW Chromium
// context, leaving Firebase's public reserved helpers and Google requests untouched. No deploy,
// saved browser profile, credentials, consent or payment. Build with the matching public Firebase
// config + FEMLAB_GOOGLE_SIGN_IN=true + FEMLAB_BASE_PATH=/ first.
import {chromium} from '@playwright/test';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const origin=process.argv[2];
if(!['https://femlab.app','https://femlab-app-staging.web.app'].includes(origin))throw new Error('Select the production or staging app origin.');
const dist=path.join(root,'packages/app/dist');
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm','.json':'application/json','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.svg':'image/svg+xml'};
const safe=url=>{const u=new URL(url);return u.origin+u.pathname;};
const browser=await chromium.launch();
const evidence={origin,violations:[],failures:[],authDocuments:[],helperResponses:[],engineStates:[]};
try {
  const context=await browser.newContext({serviceWorkers:'block'});
  await context.exposeBinding('recordAuthPolicy',(_source,value)=>evidence.violations.push(value));
  await context.exposeBinding('recordAuthDocument',(_source,value)=>evidence.authDocuments.push(value));
  await context.addInitScript(()=>{if(location.pathname==='/signin.html')addEventListener('DOMContentLoaded',()=>{const policy=document.querySelector('meta[http-equiv="Content-Security-Policy"]').content;void window.recordAuthDocument({url:location.origin+location.pathname,isolated:crossOriginIsolated,framePolicy:policy.split(';').map(p=>p.trim()).find(p=>p.startsWith('frame-src '))});});addEventListener('securitypolicyviolation',event=>{
    let blocked=event.blockedURI;try{const u=new URL(blocked);blocked=u.origin+u.pathname;}catch{}
    let source=event.sourceFile;try{const u=new URL(source);source=u.origin+u.pathname;}catch{}
    void window.recordAuthPolicy({document:location.origin+location.pathname,directive:event.effectiveDirective,blocked,source,line:event.lineNumber});
  });});
  await context.route(`${origin}/**`,async route=>{
    const url=new URL(route.request().url());if(url.pathname.startsWith('/__/'))return route.continue();
    const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
    const file=path.resolve(dist,name);if(!file.startsWith(dist+path.sep))throw new Error('Invalid candidate path.');
    try{if(!(await stat(file)).isFile())return route.continue();}catch{return route.continue();}
    await route.fulfill({body:await readFile(file),headers:{'content-type':types[path.extname(file)]??'application/octet-stream','cross-origin-opener-policy':'same-origin','cross-origin-embedder-policy':name==='signin.html'?'unsafe-none':'credentialless','cache-control':'no-store'}});
  });
  const page=await context.newPage();page.setDefaultTimeout(30000);
  page.on('requestfailed',r=>evidence.failures.push({url:safe(r.url()),error:r.failure()?.errorText}));
  page.on('response',r=>{if(r.url().startsWith(`${origin}/__/auth/iframe`))evidence.helperResponses.push({url:safe(r.url()),status:r.status()});});
  const ready=async()=>{
    await page.waitForFunction(()=>Boolean(window.fem)&&crossOriginIsolated);
    await page.evaluate(()=>window.fem.model.new({name:'Google redirect boundary smoke'}));
    await page.waitForFunction(async()=>{const state=await window.fem.registry.query({query:'query.account'});return state.configured&&state.status==='anonymous';});
    const state=await page.evaluate(async()=>{const account=await window.fem.registry.query({query:'query.account'});return {isolated:crossOriginIsolated,account:{configured:account.configured,status:account.status,error:account.error},helpers:document.querySelectorAll('iframe[src*="/__/auth/"]').length};});
    if(!state.isolated||state.helpers!==0)throw new Error('Engine host initialized an auth helper or lost isolation.');
    evidence.engineStates.push(state);
  };
  const google=async()=>{
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await page.getByRole('button',{name:'Continue with Google',exact:true}).click();
    await page.waitForURL(u=>u.origin==='https://accounts.google.com'&&u.pathname.includes('/signin/identifier'),{timeout:60000});
    const url=new URL(page.url()),callback=new URL(url.searchParams.get('redirect_uri')??'https://invalid.test/');if(callback.origin!==origin||callback.pathname!=='/__/auth/handler')throw new Error('Unexpected OAuth callback.');
  };
  await page.goto(origin+'/');await ready();await google();
  // Cancel at Google's identifier: no identity or consent is entered. Return to the actual
  // redirectUrl document, so the real SDK consumes its pending state and iframe response.
  await page.goto(origin+'/signin.html');await page.waitForURL(origin+'/',{timeout:60000});await ready();
  if(await page.evaluate(()=>sessionStorage.getItem('femlab.googleReturn'))!==null)throw new Error('Canceled attempt was not consumed.');
  await google();
  // The engine's existing Zod JIT feature probe is caught by its strict CSP. Keep that
  // evidence visible; this regression gate concerns resources needed by the auth host.
  if(evidence.violations.some(v=>v.document===`${origin}/signin.html`)||evidence.failures.length)throw new Error('Candidate auth emitted CSP or request failures.');
  if(evidence.authDocuments.length<3||evidence.authDocuments.some(v=>v.isolated||v.framePolicy!==`frame-src ${origin}/__/auth/iframe`))throw new Error('Auth document isolation/frame boundary failed.');
  if(evidence.helperResponses.length===0||evidence.helperResponses.some(r=>r.status!==200))throw new Error('The real Firebase helper did not load.');
  console.log(JSON.stringify({...evidence,result:'start, canceled return, and retry passed; owner consent/authenticated return unverified'},null,2));
} catch(error) {
  console.error(JSON.stringify({...evidence,result:error.message},null,2));process.exitCode=1;
} finally {await browser.close();}
