import {beforeEach,expect,it,vi} from 'vitest';
import {beginGoogleRedirect,finishGoogleRedirect,googleEntry,GOOGLE_RETURN_KEY,type GoogleRedirectEnvironment} from '../src/account/google-redirect';
beforeEach(()=>sessionStorage.clear());
function environment(base='/'):GoogleRedirectEnvironment {
  return {storage:sessionStorage,origin:'https://femlab.app',base,complete:vi.fn(async()=>false),begin:vi.fn(async()=>{}),navigate:vi.fn()};
}
it.each(['/','/fem-lab/'])('starts and recovers a canceled redirect only through the %s app entry',async base=>{
  const env=environment(base),navigate=vi.fn();
  beginGoogleRedirect(env.storage,env.origin,base,navigate);
  expect(navigate).toHaveBeenCalledWith(`https://femlab.app${base}signin.html`);
  expect(JSON.parse(sessionStorage.getItem(GOOGLE_RETURN_KEY)!)).toEqual({path:base,started:false});
  env.begin=vi.fn(async()=>{expect(JSON.parse(sessionStorage.getItem(GOOGLE_RETURN_KEY)!)).toEqual({path:base,started:true});});
  await finishGoogleRedirect(env);expect(env.begin).toHaveBeenCalledOnce();expect(env.navigate).not.toHaveBeenCalled();
  // Returning without a credential consumes the old attempt, rather than restarting it.
  await finishGoogleRedirect(env);expect(env.begin).toHaveBeenCalledOnce();expect(env.navigate).toHaveBeenCalledWith(base);
  expect(sessionStorage.getItem(GOOGLE_RETURN_KEY)).toBeNull();
});
it('returns after a completed credential before starting any new Google operation',async()=>{
  const env=environment();beginGoogleRedirect(env.storage,env.origin,env.base,vi.fn());env.complete=vi.fn(async()=>true);
  await finishGoogleRedirect(env);expect(env.navigate).toHaveBeenCalledWith('/');expect(env.begin).not.toHaveBeenCalled();expect(sessionStorage.getItem(GOOGLE_RETURN_KEY)).toBeNull();
});
it.each([null,'{','null','{}',...['https://evil.test/','//evil.test/','https://femlab.app/','/signin.html','/__/auth/handler','/other/','/?code=secret','/#access_token=secret','/%2f%2fevil.test/'].map(path=>JSON.stringify({path,started:false}))])('fails closed on edited/missing return state %s',async value=>{
  const env=environment();if(value!==null)sessionStorage.setItem(GOOGLE_RETURN_KEY,value);
  await finishGoogleRedirect(env);expect(env.navigate).toHaveBeenCalledWith('/');expect(env.complete).not.toHaveBeenCalled();expect(env.begin).not.toHaveBeenCalled();expect(sessionStorage.getItem(GOOGLE_RETURN_KEY)).toBeNull();
});
it.each(['https://evil.test/','//evil.test/','/signin.html/','/__/auth/','/fem-lab/__/auth/','/?code=secret','/#token','/fem-lab'])('rejects an invalid configured app base %s',base=>{
  expect(()=>googleEntry('https://femlab.app',base)).toThrow('Invalid app entry');
});
it('preserves a recoverable attempt on supplier failure without navigating or starting another one',async()=>{
  const env=environment();beginGoogleRedirect(env.storage,env.origin,env.base,vi.fn());env.complete=vi.fn(async()=>{throw new Error('network unavailable')});
  await expect(finishGoogleRedirect(env)).rejects.toThrow('network unavailable');expect(env.navigate).not.toHaveBeenCalled();expect(env.begin).not.toHaveBeenCalled();
  expect(JSON.parse(sessionStorage.getItem(GOOGLE_RETURN_KEY)!)).toEqual({path:'/',started:false});
});
