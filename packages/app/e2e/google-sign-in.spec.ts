import {expect,test} from './fixtures';
import {GOOGLE_RETURN_KEY} from '../src/account/google-redirect';

for(const controlled of [false,true])test(`@cpu sign-in host preserves shared tab state (existing controller: ${controlled})`,async({page})=>{
  await page.goto('./');await page.waitForFunction(()=>Boolean(window.fem)&&crossOriginIsolated,undefined,{timeout:60000});
  if(controlled){await page.evaluate(async()=>{const registration=await navigator.serviceWorker.register('coi-serviceworker.min.js');await navigator.serviceWorker.ready;if(!registration.active)throw new Error('Worker not active');});await page.reload();await page.waitForFunction(()=>Boolean(window.fem)&&crossOriginIsolated&&Boolean(navigator.serviceWorker.controller));}
  const base=new URL(page.url()).pathname;
  const enginePolicy=await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(enginePolicy).not.toContain('apis.google.com');

  await page.evaluate(({key,path})=>sessionStorage.setItem(key,JSON.stringify({path,started:true})),{key:GOOGLE_RETURN_KEY,path:base});
  const response=await page.goto('signin.html');
  await expect(page.getByRole('status')).toContainText('Sign-in could not complete');
  expect(await page.evaluate(()=>crossOriginIsolated)).toBe(false);
  expect(response!.headers()['cross-origin-embedder-policy']).toBe('unsafe-none');
  expect(await page.evaluate(()=>typeof window.fem)).toBe('undefined');
  expect(await page.locator('script[src*="coi-"]').count()).toBe(0);expect(await page.locator('link[href*="viewer-"],link[href*="three-"]').count()).toBe(0);
  const policy=await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(policy).toContain('https://apis.google.com/js/api.js');expect(policy).toContain('https://apis.google.com/_/scs/abc-static/_/js/');
  expect(policy).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
  expect(policy).toContain("frame-src 'none'");
  await page.getByRole('link',{name:'Return to FEM Lab'}).click();await page.waitForFunction(()=>Boolean(window.fem)&&crossOriginIsolated,undefined,{timeout:60000});
});

test('@cpu edited sign-in return state and query parameters cannot choose another destination',async({page})=>{
  await page.goto('./');const base=new URL(page.url()).pathname;
  await page.evaluate(key=>sessionStorage.setItem(key,JSON.stringify({path:'https://evil.test/?code=secret',started:false})),GOOGLE_RETURN_KEY);
  await page.goto('signin.html?return=https://evil.test/');await page.waitForURL(url=>url.pathname===base&&!url.search);
  await page.waitForFunction(()=>Boolean(window.fem)&&crossOriginIsolated,undefined,{timeout:60000});
  expect(await page.evaluate(key=>sessionStorage.getItem(key),GOOGLE_RETURN_KEY)).toBeNull();
});

// GitHub Pages/headerless preview has no Firebase config: exercise its safe fallback,
// while the hosted session-persistence contract above has actual HTTP COOP headers.
test('@sw sign-in fallback stays non-isolated under the existing preview controller',async({page})=>{
  const documents:Array<{path:string;isolated:boolean}>=[];
  await page.exposeBinding('recordAuthDocument',(_source,value:{path:string;isolated:boolean})=>documents.push(value));
  await page.addInitScript(()=>{if(location.pathname.endsWith('/signin.html'))void (window as unknown as {recordAuthDocument(value:unknown):void}).recordAuthDocument({path:location.pathname,isolated:crossOriginIsolated});});
  await page.goto('./');await page.waitForFunction(()=>Boolean(window.fem)&&crossOriginIsolated);
  const base=new URL(page.url()).pathname;expect(await page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBe(true);
  await page.goto('signin.html?return=https://evil.test/');await page.waitForURL(url=>url.pathname===base&&!url.search);
  await page.waitForFunction(()=>Boolean(window.fem)&&crossOriginIsolated);
  expect(documents).toEqual([{path:base+'signin.html',isolated:false}]);
});
